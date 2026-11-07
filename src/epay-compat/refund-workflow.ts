import { randomUUID } from "node:crypto";
import { z } from "zod";
import { appendAuditEvent } from "../database/identity-store.ts";
import { readConfirmedOrder } from "./confirmed-order.ts";
import { InsufficientBalance, readLiveBalance } from "./live-balance.ts";
import { publicRefund, refundRow, refundTime, requireRefundAccess, RefundConflict, RefundPermission,
  type RefundAccess, type RefundDatabase } from "./refund-store.ts";
export { readRefund } from "./refund-store.ts";
export { claimRefund, deferRefund, settleRefund } from "./refund-queue.ts";

export const refundRequestInput = z.object({ requestId: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/),
  tradeNo: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), amountCents: z.number().int().safe().positive(),
  reason: z.string().trim().min(1).max(300).regex(/^[^\x00-\x1f\x7f]+$/) }).strict();

export function requestRefund(database: RefundDatabase, access: RefundAccess, input: unknown, now: number) {
  const command = refundRequestInput.parse(input);
  refundTime(now);
  return database.write(sql => {
    requireRefundAccess(sql, access);
    const prior = sql.prepare("SELECT refund_no FROM epay_native_refunds WHERE merchant_id=? AND request_id=?").get(access.epayMerchantId, command.requestId);
    if (prior) {
      const row = refundRow(sql, String(prior.refund_no));
      if (row.trade_no !== command.tradeNo || row.amount_cents !== command.amountCents || row.reason !== command.reason || row.requested_by !== access.userId) throw new RefundConflict("refund request conflict");
      return publicRefund(row);
    }
    const order = readConfirmedOrder(sql, command.tradeNo, access.epayMerchantId);
    if (!order) throw new RefundConflict("refund requires a confirmed native payment");
    const proof = order.type_code === "alipay"
      ? sql.prepare("SELECT i.seller_id account,c.provider_trade_no,c.amount_cents,c.fee_cents FROM epay_alipay_confirmations c JOIN epay_alipay_intents i ON i.trade_no=c.trade_no WHERE c.trade_no=?").get(command.tradeNo)
      : sql.prepare("SELECT i.provider_merchant_id account,c.provider_trade_no,c.amount_cents,c.fee_cents FROM epay_wechat_confirmations c JOIN epay_wechat_intents i ON i.trade_no=c.trade_no WHERE c.trade_no=?").get(command.tradeNo);
    if (!proof) throw new RefundConflict("refund confirmation is unavailable");
    if (sql.prepare("SELECT 1 FROM epay_native_refunds WHERE trade_no=? AND status IN ('REQUESTED','READY','PROCESSING','UNKNOWN')").get(command.tradeNo)) throw new RefundConflict("refund already active");
    const refunded = Number(sql.prepare("SELECT coalesce(sum(amount_cents),0) amount FROM epay_native_refunds WHERE trade_no=? AND status='SUCCEEDED'").get(command.tradeNo)?.amount);
    const total = Number(proof.amount_cents), net = total - Number(proof.fee_cents);
    if (!Number.isSafeInteger(refunded) || refunded + command.amountCents > total) throw new RefundConflict("refund exceeds remaining payment");
    const debit = Math.min(net, refunded + command.amountCents) - Math.min(net, refunded);
    const refundNo = `r${randomUUID().replaceAll("-", "")}`;
    sql.prepare(`INSERT INTO epay_native_refunds(refund_no,request_id,trade_no,merchant_id,provider,provider_account,provider_trade_no,
      total_cents,amount_cents,debit_cents,reason,requested_by,status,next_attempt_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'REQUESTED',?,?,?)`).run(refundNo, command.requestId, command.tradeNo, access.epayMerchantId, String(order.type_code),
        String(proof.account), String(proof.provider_trade_no), total, command.amountCents, debit, command.reason, access.userId!, now, now, now);
    appendAuditEvent(sql, { occurredAt: now, actorType: access.role === "admin" ? "ADMIN" : "SYSTEM", actorId: access.userId!,
      action: "epay.refund.requested", outcome: "SUCCESS", subjectType: "epay_refund", subjectId: refundNo, details: { merchantId: access.epayMerchantId, amountCents: command.amountCents, reason: command.reason } });
    return publicRefund(refundRow(sql, refundNo));
  });
}

export function approveRefund(database: RefundDatabase, access: RefundAccess, refundNo: string, now: number) {
  refundTime(now);
  return database.write(sql => {
    requireRefundAccess(sql, access, true);
    const row = refundRow(sql, refundNo);
    if (row.merchant_id !== access.epayMerchantId) throw new RefundPermission("refund merchant differs");
    if (row.status !== "REQUESTED") {
      if (row.approved_by === access.userId) return publicRefund(row);
      throw new RefundConflict("refund already processed");
    }
    if (now < row.updated_at || !readConfirmedOrder(sql, row.trade_no, row.merchant_id)) throw new RefundConflict("refund payment changed");
    const before = readLiveBalance(sql, row.merchant_id);
    if (before.availableCents < row.debit_cents) throw new InsufficientBalance("refund available balance is insufficient");
    sql.prepare(`INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,frozen_delta_cents,reason,actor_id,occurred_at,source)
      VALUES(?,?,'refund_hold',?,?,?,?,?,'perpay_epay')`).run(`epay_refund_hold:${refundNo}`, row.merchant_id, -row.debit_cents, row.debit_cents, row.reason, access.userId!, now);
    sql.prepare("UPDATE epay_native_refunds SET status='READY',approved_by=?,next_attempt_at=?,updated_at=? WHERE refund_no=?").run(access.userId!, now, now, refundNo);
    readLiveBalance(sql, row.merchant_id);
    appendAuditEvent(sql, { occurredAt: now, actorType: "ADMIN", actorId: access.userId!, action: "epay.refund.approved", outcome: "SUCCESS",
      subjectType: "epay_refund", subjectId: refundNo, details: { amountCents: row.amount_cents, frozenCents: row.debit_cents } });
    return publicRefund(refundRow(sql, refundNo));
  });
}

export function rejectRefund(database: RefundDatabase, access: RefundAccess, refundNo: string, now: number) {
  refundTime(now);
  return database.write(sql => {
    requireRefundAccess(sql, access, true);
    const row = refundRow(sql, refundNo);
    if (row.merchant_id !== access.epayMerchantId) throw new RefundPermission("refund merchant differs");
    if (row.status !== "REQUESTED" || now < row.updated_at) throw new RefundConflict("refund cannot be rejected after approval");
    sql.prepare("UPDATE epay_native_refunds SET status='REJECTED',updated_at=? WHERE refund_no=?").run(now, refundNo);
    appendAuditEvent(sql, { occurredAt: now, actorType: "ADMIN", actorId: access.userId!, action: "epay.refund.rejected", outcome: "SUCCESS", subjectType: "epay_refund", subjectId: refundNo });
    return publicRefund(refundRow(sql, refundNo));
  });
}
