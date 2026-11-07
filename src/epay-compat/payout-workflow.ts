import { randomUUID } from "node:crypto";
import { z } from "zod";
import { appendAuditEvent } from "../database/identity-store.ts";
import { requestSettlement } from "./settlement-workflow.ts";
import { payoutAccount } from "./payout-accounts.ts";
import { finalizePayoutBalance } from "./payout-posting.ts";
import { payoutAccess, payoutChannel, payoutPage, payoutRequestId, payoutRow, payoutText, payoutTime, publicPayout, PayoutConflict, type PayoutAccess, type PayoutDatabase, type PayoutPolicy, type PayoutRow } from "./payout-model.ts";

const request = z.object({ requestId: payoutRequestId, accountId: z.string().uuid(), amountCents: z.number().int().safe().positive(), note: z.string().trim().max(300).regex(/^[^\x00-\x1f\x7f]*$/).default("") }).strict();
const review = z.object({ decision: z.enum(["approve", "reject"]), reference: payoutText(200) }).strict();
const DAY_MS = 86_400_000;
const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

export function requestPayout(database: PayoutDatabase, access: PayoutAccess, input: unknown, policy: PayoutPolicy, now: number) {
  const command = request.parse(input); payoutTime(now);
  return database.write(sql => {
    payoutAccess(sql, access, "owner");
    const prior = sql.prepare(`SELECT p.* FROM epay_payouts p JOIN epay_native_settlements s ON s.settlement_id=p.settlement_id
      WHERE s.merchant_id=? AND s.request_id=?`).get(access.epayMerchantId, command.requestId) as PayoutRow | undefined;
    if (prior) {
      const settlement = sql.prepare("SELECT note,created_by FROM epay_native_settlements WHERE settlement_id=?").get(prior.settlement_id)!;
      if (prior.account_id !== command.accountId || Number(prior.amount_cents) !== command.amountCents || settlement.note !== command.note || settlement.created_by !== access.userId) throw new PayoutConflict("payout request conflict");
      return publicPayout(prior);
    }
    const account = payoutAccount(sql, command.accountId, access.epayMerchantId);
    if (account.status !== "APPROVED") throw new PayoutConflict("payout account is not approved");
    const channel = payoutChannel(policy, account.kind);
    if (account.kind === "wechat" && !sql.prepare(`SELECT 1 FROM epay_wechat_payout_authorizations a JOIN epay_wechat_payout_identities i ON i.account_id=a.account_id
      WHERE a.account_id=? AND a.merchant_id=? AND a.owner_id=i.owner_id AND a.app_id=i.app_id AND a.payer=? AND a.state='TAKING_EFFECT'`).get(account.account_id, access.epayMerchantId, channel.account)) throw new PayoutConflict("active verified WeChat authorization required");
    if (command.amountCents > channel.maxSingleCents || (account.kind === "alipay" && command.amountCents < 10)) throw new PayoutConflict("payout exceeds single transfer limit");
    if (sql.prepare("SELECT 1 FROM epay_native_settlements WHERE merchant_id=? AND request_id=?").get(access.epayMerchantId, command.requestId)) throw new PayoutConflict("manual settlement already uses request ID");
    const transaction = { write: <T>(operation: (connection: typeof sql) => T) => operation(sql), read: <T>(operation: (connection: typeof sql) => T) => operation(sql) };
    const held = requestSettlement(transaction, access, { requestId: command.requestId, amountCents: command.amountCents, note: command.note }, now);
    const outNo = randomUUID().replaceAll("-", "");
    sql.prepare(`INSERT INTO epay_payouts(settlement_id,merchant_id,account_id,channel,out_no,amount_cents,status,next_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'PENDING',?,?,?)`).run(held.id, access.epayMerchantId, account.account_id, account.kind, outNo, command.amountCents, now, now, now);
    return publicPayout(payoutRow(sql, held.id));
  });
}

export function reviewPayout(database: PayoutDatabase, access: PayoutAccess, id: string, input: unknown, policy: PayoutPolicy, now: number) {
  const command = review.parse(input); payoutTime(now);
  return database.write(sql => {
    payoutAccess(sql, access, "admin");
    const row = payoutRow(sql, id);
    if (Number(row.merchant_id) !== access.epayMerchantId || now < Number(row.updated_at)) throw new PayoutConflict("payout merchant or time differs");
    if (row.status === "REJECTED" && command.decision === "reject") {
      const settlement = sql.prepare("SELECT reviewed_by,reference FROM epay_native_settlements WHERE settlement_id=?").get(id)!;
      if (settlement.reviewed_by !== access.userId || settlement.reference !== command.reference) throw new PayoutConflict("payout decision conflicts");
      return publicPayout(row);
    }
    if (row.status === "READY" && command.decision === "approve" && row.approved_by === access.userId && row.approval_reference === command.reference) return publicPayout(row);
    if (row.status !== "PENDING" && !(row.status === "READY" && command.decision === "reject" && row.submitted_at === null)) throw new PayoutConflict("payout already reviewed or sent");
    if (command.decision === "reject") {
      sql.prepare("UPDATE epay_payouts SET status='REJECTED',updated_at=? WHERE settlement_id=?").run(now, id);
      finalizePayoutBalance(sql, row, false, access.userId!, command.reference, now);
    } else {
      const account = payoutAccount(sql, row.account_id, access.epayMerchantId);
      if (account.status !== "APPROVED") throw new PayoutConflict("payout account was revoked");
      const channel = payoutChannel(policy, row.channel);
      const dayStart = Math.floor((now + CHINA_OFFSET_MS) / DAY_MS) * DAY_MS - CHINA_OFFSET_MS;
      const spent = sql.prepare(`SELECT coalesce(sum(amount_cents),0) cents FROM epay_payouts
        WHERE channel=? AND payer=? AND approved_at>=? AND approved_at<? AND status NOT IN ('REJECTED','FAILED')`).get(row.channel, channel.account, dayStart, dayStart + DAY_MS)!;
      if (Number(row.amount_cents) > channel.maxSingleCents || BigInt(spent.cents as bigint | number) + BigInt(row.amount_cents) > BigInt(channel.maxDailyCents)) throw new PayoutConflict("payout exceeds channel daily limit");
      sql.prepare("UPDATE epay_payouts SET status='READY',payer=?,approved_by=?,approved_at=?,approval_reference=?,updated_at=? WHERE settlement_id=?")
        .run(channel.account, access.userId!, now, command.reference, now, id);
    }
    appendAuditEvent(sql, { occurredAt: now, actorType: "ADMIN", actorId: access.userId!, action: `epay.payout.${command.decision === "approve" ? "approved" : "rejected"}`, outcome: "SUCCESS", subjectType: "payout", subjectId: id, details: { reference: command.reference, amountCents: Number(row.amount_cents) } });
    return publicPayout(payoutRow(sql, id));
  });
}

export function listPayouts(database: PayoutDatabase, access: PayoutAccess, page: number) {
  const offset = payoutPage(page);
  return database.read(sql => {
    payoutAccess(sql, access, "read");
    const rows = sql.prepare("SELECT * FROM epay_payouts WHERE merchant_id=? ORDER BY created_at DESC,settlement_id LIMIT 21 OFFSET ?").all(access.epayMerchantId, offset) as PayoutRow[];
    return { payouts: rows.slice(0, 20).map(row => {
      const returned = sql.prepare("SELECT amount_cents,posted_at FROM epay_payout_returns WHERE settlement_id=?").get(row.settlement_id);
      return { ...publicPayout(row), returnedCents: returned ? Number(returned.amount_cents) : 0, returnedAt: returned ? Number(returned.posted_at) : null };
    }), hasNext: rows.length > 20 };
  });
}
