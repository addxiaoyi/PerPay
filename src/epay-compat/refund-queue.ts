import { randomUUID } from "node:crypto";
import { appendAuditEvent } from "../database/identity-store.ts";
import { readLiveBalance } from "./live-balance.ts";
import { requireRefundEvidence, type RefundEvidence, type RefundIdentity } from "./refund-evidence.ts";
import { refundRow, refundIdentity, refundTime, type RefundDatabase, type RefundRow } from "./refund-store.ts";

export type RefundLease = Readonly<RefundIdentity & { leaseToken: string; leaseUntil: number; action: "SUBMIT" | "QUERY"; reason: string }>;
const RETRY_MS = 30_000;

export function claimRefund(database: RefundDatabase, now: number, leaseMs = 30_000): RefundLease | null {
  refundTime(now);
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 60_000 || !Number.isSafeInteger(now + leaseMs)) throw new Error("invalid refund lease duration");
  return database.write(sql => {
    const selected = sql.prepare(`SELECT refund_no FROM epay_native_refunds WHERE status IN ('READY','PROCESSING','UNKNOWN')
      AND next_attempt_at<=? AND (lease_token IS NULL OR lease_until<=?) ORDER BY next_attempt_at,created_at,refund_no LIMIT 1`).get(now, now);
    if (!selected) return null;
    const row = refundRow(sql, String(selected.refund_no));
    if (now < row.updated_at) throw new Error("refund lease clock regressed");
    if (row.lease_token) sql.prepare("UPDATE epay_native_refund_attempts SET outcome='EXPIRED',finished_at=? WHERE attempt_id=? AND outcome='STARTED'").run(now, row.lease_token);
    const action = row.submitted_at === null ? "SUBMIT" : "QUERY", leaseToken = randomUUID();
    // Commit uncertainty before the first network byte. Recovery only queries this exact refund ID.
    sql.prepare(`UPDATE epay_native_refunds SET status='UNKNOWN',submitted_at=coalesce(submitted_at,?),lease_token=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE refund_no=?`)
      .run(now, leaseToken, now + leaseMs, now, row.refund_no);
    sql.prepare("INSERT INTO epay_native_refund_attempts(attempt_id,refund_no,action,started_at,outcome) VALUES(?,?,?,?,'STARTED')").run(leaseToken, row.refund_no, action, now);
    return { ...refundIdentity(row), leaseToken, leaseUntil: now + leaseMs, action, reason: row.reason };
  });
}

function validLease(row: RefundRow, lease: RefundLease, now: number) {
  return row.lease_token === lease.leaseToken && row.lease_until === lease.leaseUntil && lease.leaseUntil > now && now >= row.updated_at &&
    Object.entries(refundIdentity(row)).every(([key, value]) => lease[key as keyof RefundIdentity] === value);
}

export function deferRefund(database: RefundDatabase, lease: RefundLease, now: number, code: string) {
  refundTime(now);
  if (!/^[a-z_]{1,64}$/.test(code)) throw new Error("invalid refund error code");
  return database.write(sql => {
    const row = refundRow(sql, lease.refundNo);
    if (!validLease(row, lease, now)) return false;
    sql.prepare("UPDATE epay_native_refund_attempts SET outcome='UNKNOWN',finished_at=?,error_code=? WHERE attempt_id=? AND outcome='STARTED'").run(now, code, lease.leaseToken);
    sql.prepare("UPDATE epay_native_refunds SET status='UNKNOWN',lease_token=NULL,lease_until=NULL,next_attempt_at=?,last_error=?,updated_at=? WHERE refund_no=?")
      .run(now + RETRY_MS, code, now, lease.refundNo);
    return true;
  });
}

export function settleRefund(database: RefundDatabase, lease: RefundLease, proof: RefundEvidence, now: number) {
  refundTime(now);
  return database.write(sql => {
    const row = refundRow(sql, lease.refundNo);
    requireRefundEvidence(proof, refundIdentity(row), now);
    if (!validLease(row, lease, now)) return false;
    if (row.provider_refund_no && row.provider_refund_no !== proof.providerRefundNo) throw new Error("refund provider reference changed");
    const final = proof.state === "SUCCEEDED" || proof.state === "CLOSED";
    if (final) {
      const held = sql.prepare("SELECT * FROM epay_balance_ledger WHERE entry_id=? AND merchant_id=? AND source='perpay_epay' AND entry_type='refund_hold'").get(`epay_refund_hold:${row.refund_no}`, row.merchant_id);
      if (!held || Number(held.available_delta_cents) !== -row.debit_cents || Number(held.frozen_delta_cents) !== row.debit_cents) throw new Error("refund hold differs");
      const before = readLiveBalance(sql, row.merchant_id);
      if (before.frozenCents < row.debit_cents) throw new Error("refund frozen balance is insufficient");
      const availableDelta = proof.state === "CLOSED" ? row.debit_cents : 0;
      sql.prepare(`INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,frozen_delta_cents,reason,occurred_at,source)
        VALUES(?,?,?,?,?,?,?,'perpay_epay')`).run(`epay_refund_final:${row.refund_no}`, row.merchant_id,
          proof.state === "SUCCEEDED" ? "refund_paid" : "refund_released", availableDelta, -row.debit_cents, row.reason, now);
      readLiveBalance(sql, row.merchant_id);
      appendAuditEvent(sql, { occurredAt: now, actorType: "SYSTEM", actorId: "refund-worker", action: proof.state === "SUCCEEDED" ? "epay.refund.succeeded" : "epay.refund.closed",
        outcome: "SUCCESS", subjectType: "epay_refund", subjectId: row.refund_no, details: { amountCents: row.amount_cents, responseSha256: proof.responseSha256 } });
    }
    sql.prepare("UPDATE epay_native_refund_attempts SET outcome=?,finished_at=?,response_sha256=? WHERE attempt_id=? AND outcome='STARTED'").run(proof.state, now, proof.responseSha256, lease.leaseToken);
    sql.prepare(`UPDATE epay_native_refunds SET status=?,provider_refund_no=?,response_sha256=?,lease_token=NULL,lease_until=NULL,
      next_attempt_at=?,last_error=NULL,updated_at=? WHERE refund_no=?`).run(proof.state, proof.providerRefundNo, proof.responseSha256, now + RETRY_MS, now, row.refund_no);
    return true;
  });
}
