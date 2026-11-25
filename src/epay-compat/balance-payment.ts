import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { AppDatabase } from "../database/database.ts";
import { appendAuditEvent } from "../database/identity-store.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { readLiveBalance, safeCents, InsufficientBalance, BalanceConflict } from "./live-balance.ts";
import { parseLegacyCents } from "./money.ts";
import { issueCheckoutToken, verifyCheckoutToken } from "./isolated-checkout-status.ts";
import { enqueuePaidCallback } from "./outbox.ts";
import type { MainOrderIdentity } from "./main-native-order.ts";
import { requireInvoiceWriter } from "../invoices/store.ts";
import type { InvoiceAccess } from "../invoices/model.ts";

type Database = Pick<AppDatabase, "read" | "write" | "instanceId">;
const LIFETIME_MS = 20 * 60_000;
export const balanceOrderInput = z.object({ merchantOrderId: z.string().regex(/^[A-Za-z0-9_-]{3,64}$/), amount: z.string().max(32),
  subject: z.string().trim().min(1).max(127).regex(/^[^\x00-\x1f\x7f]+$/), notifyUrl: z.string().max(2048).default(""), returnUrl: z.string().max(2048).default("") }).strict();
export const balancePayInput = z.object({ requestId: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/), token: z.string().max(160),
  expectedAmountCents: z.number().int().safe().positive(), expectedBalanceVersion: z.number().int().safe().nonnegative() }).strict();
export class BalancePaymentError extends Error {
  readonly code: string;
  readonly status: 400 | 403 | 404 | 409 | 429 | 503;
  constructor(code: string, status: 400 | 403 | 404 | 409 | 429 | 503, message: string) { super(message); this.code=code; this.status=status; }
}
function orderRow(sql: DatabaseSync, id: string) {
  const row = sql.prepare("SELECT o.*,b.order_id,b.main_merchant_id,b.main_api_id,b.fee_cents,b.expires_at FROM epay_balance_orders b JOIN epay_orders o ON o.trade_no=b.trade_no WHERE b.order_id=?").get(id);
  if (!row) throw new BalancePaymentError("balance_order_not_found", 404, "balance payment order not found");
  return row;
}
function publicOrder(sql: DatabaseSync, id: string, now: number) {
  const row = orderRow(sql, id), refund = sql.prepare("SELECT refunded_at FROM epay_balance_refunds WHERE trade_no=?").get(String(row.trade_no));
  return { id: String(row.order_id), merchantOrderId: String(row.out_trade_no), merchantId: String(row.main_merchant_id), receiverMerchantId: Number(row.merchant_id),
    subject: String(row.name), amountCents: Number(row.money_cents), feeCents: Number(row.fee_cents), expiresAt: Number(row.expires_at),
    status: refund ? "refunded" : row.status === "PAID" ? "paid" : Number(row.expires_at) <= now ? "expired" : "pending", paidAt: row.paid_at === null ? null : Number(row.paid_at),
    refundedAt: refund ? Number(refund.refunded_at) : null, tradeNo: String(row.trade_no), providerTradeNo: row.api_trade_no ? String(row.api_trade_no) : null,
    merchantOrigin: new URL(String(row.notify_url)).origin, returnUrl: row.return_url ? String(row.return_url) : null };
}
function tokenOrder(sql: DatabaseSync, id: string, token: string, options: { masterKey: Uint8Array; instanceId: string }, now: number) {
  const identity = verifyCheckoutToken(token, options.masterKey, options.instanceId, now), row = orderRow(sql, id);
  if (!identity || identity.tradeNo !== row.trade_no || identity.merchantId !== Number(row.merchant_id))
    throw new BalancePaymentError("balance_checkout_invalid", 403, "balance checkout capability is invalid or expired");
  return row;
}
export function createBalancePayments(options: { database: Database; masterKey: Uint8Array; enabled: () => boolean; clock?: (() => number) | undefined }) {
  const { database, masterKey } = options;
  const now = () => { const time = (options.clock ?? Date.now)(); if (!Number.isSafeInteger(time) || time < 0) throw new Error("balance payment clock is invalid"); return time; };
  const cipher = new RuntimeSecretCipher(masterKey, database.instanceId());
  function create(identity: MainOrderIdentity, input: unknown) {
    if (!options.enabled()) throw new BalancePaymentError("balance_payment_disabled", 503, "balance payment is disabled");
    const command = balanceOrderInput.parse(input), at = now();
    let amount: number;
    try { amount=parseLegacyCents(command.amount); }
    catch { throw new BalancePaymentError('balance_amount_invalid',400,'amount must be a valid CNY amount'); }
    if (amount < 1) throw new BalancePaymentError("balance_amount_invalid", 400, "amount must be positive");
    let callback: URL;
    try { callback=new URL(identity.callbackUrl); }
    catch { throw new BalancePaymentError('balance_callback_invalid',400,'HTTPS notification URL is required'); }
    if (callback.protocol !== "https:" || callback.username || callback.password || callback.hash || callback.hostname==='localhost' || callback.hostname.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(callback.hostname)) throw new BalancePaymentError("balance_callback_invalid", 400, "callback must use a public HTTPS hostname");
    if(command.notifyUrl && command.notifyUrl!==identity.callbackUrl) throw new BalancePaymentError('balance_callback_invalid',400,'callback differs from the authenticated contract');
    if (command.returnUrl) { const url = new URL(command.returnUrl); if (url.origin !== callback.origin || url.username || url.password || url.hash) throw new BalancePaymentError("balance_return_invalid", 400, "return URL must use the registered merchant origin"); }
    const fingerprint = createHash("sha256").update(JSON.stringify([identity.merchantId, identity.apiId, command, amount, identity.callbackUrl])).digest("hex");
    return database.write(sql => {
      const merchant = sql.prepare(`SELECT m.fee_rate_bps FROM epay_merchant_accounts m JOIN epay_merchant_bindings b ON b.epay_merchant_id=m.merchant_id
        WHERE m.merchant_id=? AND m.enabled=1 AND b.main_merchant_id=? AND b.main_api_id=?`).get(identity.epayMerchantId, identity.merchantId, identity.apiId);
      if (!merchant) throw new BalancePaymentError("balance_merchant_unavailable", 403, "receiving merchant is not available");
      readLiveBalance(sql, identity.epayMerchantId);
      const previous = sql.prepare(`SELECT b.order_id,b.request_fingerprint FROM epay_orders o LEFT JOIN epay_balance_orders b ON b.trade_no=o.trade_no WHERE o.merchant_id=? AND o.out_trade_no=?`).get(identity.epayMerchantId, command.merchantOrderId);
      if (previous) {
        if (!previous.order_id || previous.request_fingerprint !== fingerprint) throw new BalanceConflict("merchant order already exists with different details");
        const row = publicOrder(sql, String(previous.order_id), at);
        return { order: row, token: issueCheckoutToken(masterKey, database.instanceId(), row.tradeNo, identity.epayMerchantId, at), duplicate: true };
      }
      const rate = Number(merchant.fee_rate_bps);
      if (!Number.isSafeInteger(rate) || rate < 0 || rate > 10000) throw new Error("balance payment merchant fee rate is invalid");
      const fee = Number((BigInt(amount) * BigInt(rate) + 5000n) / 10000n), tradeNo = randomUUID().replaceAll("-", ""), orderId = randomUUID();
      sql.prepare(`INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,type_code,channel_code,name,money_cents,notify_url,return_url,status,notify_status,notify_count,created_at,updated_at)
        VALUES(?,?,?,'balance','merchant_balance',?,?,?,?,'PENDING','PENDING',0,?,?)`).run(tradeNo, command.merchantOrderId, identity.epayMerchantId, command.subject, amount, identity.callbackUrl, command.returnUrl || null, at, at);
      const secret = cipher.encrypt(`epay:config:balance-callback:${identity.epayMerchantId}:${identity.apiId}:${tradeNo}`, 1, identity.callbackSecret);
      sql.prepare("INSERT INTO epay_balance_orders VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(tradeNo, orderId, identity.merchantId, identity.apiId, identity.epayMerchantId, fee,
        fingerprint, randomUUID(), secret.nonce, secret.ciphertext, secret.authenticationTag, at + LIFETIME_MS, at);
      return { order: publicOrder(sql, orderId, at), token: issueCheckoutToken(masterKey, database.instanceId(), tradeNo, identity.epayMerchantId, at), duplicate: false };
    });
  }
  function inspect(access: InvoiceAccess, id: string, token: string) {
    return database.read(sql => {
      requireInvoiceWriter(sql, access); tokenOrder(sql, id, token, { masterKey, instanceId: database.instanceId() }, now());
      const order = publicOrder(sql, id, now()), balance = readLiveBalance(sql, access.epayMerchantId);
      return { order, balance, canPay: options.enabled() && order.status === "pending" && order.receiverMerchantId !== access.epayMerchantId && balance.availableCents >= order.amountCents };
    });
  }
  function pay(access: InvoiceAccess, id: string, input: unknown) {
    const command = balancePayInput.parse(input), at = now();
    if (!options.enabled()) throw new BalancePaymentError("balance_payment_disabled", 503, "balance payment is disabled");
    return database.write(sql => {
      requireInvoiceWriter(sql, access); const row = tokenOrder(sql, id, command.token, { masterKey, instanceId: database.instanceId() }, at);
      const receiver = Number(row.merchant_id), amount = Number(row.money_cents), fee = Number(row.fee_cents), tradeNo = String(row.trade_no);
      const previous = sql.prepare("SELECT * FROM epay_balance_confirmations WHERE trade_no=?").get(tradeNo);
      if (previous) {
        if (Number(previous.payer_merchant_id) !== access.epayMerchantId || previous.actor_id !== access.userId) throw new BalancePaymentError("balance_payment_owned", 403, "another payer owns this payment");
        return { duplicate: true, order: publicOrder(sql, id, at), balance: readLiveBalance(sql, access.epayMerchantId) };
      }
      if(sql.prepare('SELECT 1 FROM epay_balance_confirmations WHERE payer_merchant_id=? AND request_id=?').get(access.epayMerchantId,command.requestId)) throw new BalanceConflict('payment request ID belongs to another order');
      if (amount !== command.expectedAmountCents) throw new BalanceConflict("checkout amount differs");
      if (receiver === access.epayMerchantId) throw new BalancePaymentError("balance_self_payment", 409, "merchant cannot pay itself");
      if (row.status !== "PENDING" || Number(row.expires_at) <= at) throw new BalancePaymentError("balance_order_expired", 409, "order is no longer payable");
      if (!sql.prepare("SELECT 1 FROM epay_merchant_accounts WHERE merchant_id=? AND enabled=1").get(receiver)) throw new BalancePaymentError("balance_receiver_disabled", 409, "receiving merchant is disabled");
      const senderBalance = readLiveBalance(sql, access.epayMerchantId), receiverBalance = readLiveBalance(sql, receiver);
      if (senderBalance.version !== command.expectedBalanceVersion) throw new BalanceConflict("payer balance changed");
      if (senderBalance.availableCents < amount) throw new InsufficientBalance("available merchant balance is insufficient");
      safeCents(BigInt(receiverBalance.availableCents) + BigInt(amount - fee));
      const payerEntry = `balance_debit:${tradeNo}`, receiverEntry = `epay_payment:${tradeNo}`, providerTradeNo = `balance_${tradeNo}`;
      sql.prepare("INSERT INTO epay_balance_confirmations VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(tradeNo, providerTradeNo, receiver, access.epayMerchantId, access.userId!, command.requestId, amount, fee, at, payerEntry, receiverEntry);
      sql.prepare(`INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,frozen_delta_cents,reason,actor_id,occurred_at,source)
        VALUES(?,?,'balance_payment_out',?,0,?,?,?,'perpay_balance')`).run(payerEntry, access.epayMerchantId, -amount, `支付 ${tradeNo}`, access.userId!, at);
      sql.prepare(`INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,frozen_delta_cents,reason,actor_id,occurred_at,source)
        VALUES(?,?,'payment_paid',?,0,?,?,?,'perpay_epay')`).run(receiverEntry, receiver, amount - fee, `余额收款 ${tradeNo}`, access.userId!, at);
      sql.prepare("UPDATE epay_orders SET status='PAID',real_money_cents=?,get_money_cents=?,api_trade_no=?,paid_at=?,updated_at=? WHERE trade_no=? AND status='PENDING'")
        .run(amount, amount, providerTradeNo, at, at, tradeNo);
      if (!enqueuePaidCallback(sql, tradeNo, receiver, at)) throw new Error("balance payment callback already exists");
      sql.prepare("UPDATE epay_callback_jobs SET next_method='GET' WHERE trade_no=?").run(tradeNo);
      const after = readLiveBalance(sql, access.epayMerchantId), credited = readLiveBalance(sql, receiver);
      if (after.availableCents !== senderBalance.availableCents - amount || credited.availableCents !== receiverBalance.availableCents + amount - fee) throw new Error("balance payment did not conserve balances");
      appendAuditEvent(sql, { occurredAt: at, actorType: access.role === "admin" ? "ADMIN" : "SYSTEM", actorId: access.userId!, action: "balance.payment.confirmed", outcome: "SUCCESS", subjectType: "epay_order", subjectId: tradeNo,
        details: { payerMerchantId: access.epayMerchantId, receiverMerchantId: receiver, amountCents: amount, feeCents: fee } });
      return { duplicate: false, order: publicOrder(sql, id, at), balance: after };
    });
  }
  function read(identity: MainOrderIdentity, id: string) { return database.read(sql => { const row = orderRow(sql, id); if (Number(row.merchant_id) !== identity.epayMerchantId || row.main_api_id !== identity.apiId) throw new BalancePaymentError("balance_order_forbidden", 403, "order belongs to another merchant"); return publicOrder(sql, id, now()); }); }
  function refund(access: InvoiceAccess, id: string, requestId: string) {
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(requestId)) throw new BalancePaymentError("balance_refund_invalid", 400, "invalid refund request ID");
    if (!options.enabled()) throw new BalancePaymentError("balance_payment_disabled", 503, "balance payments are disabled");
    return database.write(sql => {
      requireInvoiceWriter(sql, access); const row = orderRow(sql, id), tradeNo = String(row.trade_no);
      if (Number(row.merchant_id) !== access.epayMerchantId) throw new BalancePaymentError("balance_refund_forbidden", 403, "only the receiving merchant may refund");
      const proof = sql.prepare("SELECT * FROM epay_balance_confirmations WHERE trade_no=?").get(tradeNo);
      if (!proof) throw new BalancePaymentError("balance_refund_unpaid", 409, "payment has not been confirmed");
      if (sql.prepare("SELECT 1 FROM epay_balance_refunds WHERE trade_no=?").get(tradeNo)) return { duplicate: true, order: publicOrder(sql, id, now()) };
      if (sql.prepare(`SELECT 1 FROM epay_fee_invoice_requests WHERE trade_no=? AND status NOT IN ('FAILED','REVERSED')
        UNION ALL SELECT 1 FROM epay_tax_invoice_requests WHERE trade_no=? AND status NOT IN ('FAILED','REVERSED')`).get(tradeNo, tradeNo))
        throw new BalancePaymentError("balance_refund_invoice_conflict", 409, "refund requires invoice reconciliation first");
      const payer = Number(proof.payer_merchant_id), amount = Number(proof.amount_cents), net = amount - Number(proof.fee_cents), at = now();
      const debit = readLiveBalance(sql, access.epayMerchantId), credit = readLiveBalance(sql, payer);
      if (debit.availableCents < net) throw new InsufficientBalance("receiver has insufficient available balance for a full refund");
      safeCents(BigInt(credit.availableCents) + BigInt(amount));
      const payerEntry = `balance_refund_in:${tradeNo}`, receiverEntry = `balance_refund_out:${tradeNo}`;
      sql.prepare("INSERT INTO epay_balance_refunds VALUES(?,?,?,?,?,?,?,?)").run(tradeNo, access.epayMerchantId, requestId, access.userId!, amount, at, payerEntry, receiverEntry);
      for (const [entryId, merchantId, type, delta] of [[payerEntry,payer,'balance_refund_in',amount],[receiverEntry,access.epayMerchantId,'balance_refund_out',-net]] as const)
        sql.prepare(`INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,frozen_delta_cents,reason,actor_id,occurred_at,source)
          VALUES(?,?,?, ?,0,'余额支付原路退款',?,?,'perpay_balance')`).run(entryId, merchantId, type, delta, access.userId!, at);
      appendAuditEvent(sql, { occurredAt: at, actorType: access.role === 'admin' ? 'ADMIN' : 'SYSTEM', actorId: access.userId!, action: 'balance.payment.refunded', outcome: 'SUCCESS',
        subjectType: 'epay_order', subjectId: tradeNo, details: { payerMerchantId: payer, amountCents: amount } });
      return { duplicate: false, order: publicOrder(sql, id, at) };
    });
  }
  return { create, inspect, pay, read, refund };
}
