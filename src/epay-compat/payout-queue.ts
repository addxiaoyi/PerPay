import { randomUUID } from "node:crypto";
import { appendAuditEvent } from "../database/identity-store.ts";
import { finalizePayoutBalance } from "./payout-posting.ts";
import { requirePayoutProof } from "./payout-evidence.ts";
import { postPayoutReturn } from "./payout-reconciliation.ts";
import { payoutChannel, payoutRow, payoutTime, type PayoutDatabase, type PayoutLease, type PayoutPolicy, type PayoutProof, type PayoutRow } from "./payout-model.ts";

const LEASE_MS = 30_000;
const RETRY_MS = 60_000;
const DAY_MS = 86_400_000;
const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

export function claimPayout(database: PayoutDatabase, policy: PayoutPolicy, now: number, prepared?: ReadonlySet<string>): PayoutLease | null {
  payoutTime(now);
  return database.write(sql => {
    const candidates = sql.prepare(`SELECT p.* FROM epay_payouts p JOIN epay_payout_accounts a ON a.account_id=p.account_id AND a.merchant_id=p.merchant_id
      JOIN epay_merchant_accounts m ON m.merchant_id=p.merchant_id
      WHERE p.status IN ('READY','UNKNOWN','PROCESSING','WAIT_USER_CONFIRM') AND p.next_at<=? AND (p.lease_token IS NULL OR p.lease_until<=?)
      AND (p.submitted_at IS NOT NULL OR (a.status='APPROVED' AND m.enabled=1)) ORDER BY p.next_at,p.created_at,p.settlement_id`).all(now, now) as PayoutRow[];
    const row = candidates.find(row => {
      if (policy.channels[row.channel]?.account !== row.payer) return false;
      if (row.submitted_at !== null) return true;
      if (prepared && !prepared.has(row.settlement_id)) return false;
      if (!policy.enabled) return false;
      const channel = payoutChannel(policy, row.channel);
      const dayStart = Math.floor((now + CHINA_OFFSET_MS) / DAY_MS) * DAY_MS - CHINA_OFFSET_MS;
      const submitted = sql.prepare("SELECT coalesce(sum(amount_cents),0) cents FROM epay_payouts WHERE channel=? AND payer=? AND submitted_at>=? AND submitted_at<?")
        .get(row.channel, row.payer!, dayStart, dayStart + DAY_MS)!;
      return Number(row.amount_cents) <= channel.maxSingleCents && BigInt(submitted.cents as bigint | number) + BigInt(row.amount_cents) <= BigInt(channel.maxDailyCents);
    });
    if (!row) return null;
    if (now < Number(row.updated_at)) throw new Error("payout clock regressed");
    if (row.lease_token) sql.prepare("UPDATE epay_payout_attempts SET outcome='EXPIRED',finished_at=? WHERE token=? AND outcome='STARTED'").run(now, row.lease_token);
    const action = row.submitted_at === null ? "SUBMIT" : "QUERY", token = randomUUID(), until = now + LEASE_MS;
    sql.prepare("UPDATE epay_payouts SET status='UNKNOWN',submitted_at=coalesce(submitted_at,?),attempts=attempts+1,lease_token=?,lease_until=?,updated_at=? WHERE settlement_id=?")
      .run(now, token, until, now, row.settlement_id);
    sql.prepare("INSERT INTO epay_payout_attempts(token,settlement_id,action,started_at,outcome) VALUES(?,?,?,?,'STARTED')").run(token, row.settlement_id, action, now);
    return { id: row.settlement_id, merchantId: Number(row.merchant_id), accountId: row.account_id, channel: row.channel, payer: row.payer!, outNo: row.out_no, amountCents: Number(row.amount_cents), action, token, until };
  });
}

function validLease(row: PayoutRow, lease: PayoutLease, now: number) {
  return row.lease_token === lease.token && Number(row.lease_until) === lease.until && lease.until > now && now >= Number(row.updated_at) &&
    row.settlement_id === lease.id && Number(row.merchant_id) === lease.merchantId && row.account_id === lease.accountId && row.channel === lease.channel && row.payer === lease.payer && row.out_no === lease.outNo && Number(row.amount_cents) === lease.amountCents;
}

export function deferPayout(database: PayoutDatabase, lease: PayoutLease, now: number, code: string): boolean {
  payoutTime(now);
  if (!/^[a-z_]{1,64}$/.test(code)) throw new Error("invalid payout error code");
  return database.write(sql => {
    const row = payoutRow(sql, lease.id);
    if (!validLease(row, lease, now)) return false;
    sql.prepare("UPDATE epay_payout_attempts SET outcome='UNKNOWN',finished_at=?,error_code=? WHERE token=? AND outcome='STARTED'").run(now, code, lease.token);
    sql.prepare("UPDATE epay_payouts SET status='UNKNOWN',lease_token=NULL,lease_until=NULL,next_at=?,last_error=?,updated_at=? WHERE settlement_id=?").run(now + RETRY_MS, code, now, lease.id);
    return true;
  });
}

export function completePayout(database: PayoutDatabase, lease: PayoutLease, proof: PayoutProof, now: number): boolean {
  payoutTime(now);
  return database.write(sql => {
    const row = payoutRow(sql, lease.id);
    if (!validLease(row, lease, now)) return false;
    requirePayoutProof(proof);
    if (proof.outNo !== lease.outNo || proof.channel !== lease.channel || proof.payer !== lease.payer || proof.accountId !== lease.accountId || proof.amountCents !== lease.amountCents ||
        !Number.isSafeInteger(proof.observedAt) || proof.observedAt > now || now - proof.observedAt > 60_000 ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(proof.providerId) || !/^[a-f0-9]{64}$/.test(proof.responseSha256) ||
        !["PROCESSING", "WAIT_USER_CONFIRM", "SUCCEEDED", "FAILED", "RETURNED"].includes(proof.state) || (row.provider_id && row.provider_id !== proof.providerId)) throw new Error("payout evidence mismatch");
    const state = proof.state === "RETURNED" ? "SUCCEEDED" : proof.state;
    const terminal = state === "SUCCEEDED" || state === "FAILED";
    sql.prepare("UPDATE epay_payout_attempts SET outcome=?,finished_at=?,response_sha256=? WHERE token=? AND outcome='STARTED'").run(state, now, proof.responseSha256, lease.token);
    sql.prepare("UPDATE epay_payouts SET status=?,provider_id=?,response_sha256=?,lease_token=NULL,lease_until=NULL,next_at=?,last_error=NULL,updated_at=? WHERE settlement_id=?")
      .run(state, proof.providerId, proof.responseSha256, now + RETRY_MS, now, lease.id);
    if (terminal) {
      finalizePayoutBalance(sql, row, state === "SUCCEEDED", "payout-worker", proof.providerId, now);
      appendAuditEvent(sql, { occurredAt: now, actorType: "SYSTEM", actorId: "payout-worker", action: state === "SUCCEEDED" ? "epay.payout.succeeded" : "epay.payout.failed", outcome: "SUCCESS", subjectType: "payout", subjectId: lease.id, details: { amountCents: lease.amountCents, responseSha256: proof.responseSha256, observedState: proof.state } });
      if (proof.state === "RETURNED") postPayoutReturn({ read: operation => operation(sql), write: operation => operation(sql) }, lease.id, proof, now);
    }
    return true;
  });
}
