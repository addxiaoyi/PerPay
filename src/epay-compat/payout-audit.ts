import type { DatabaseSync } from "node:sqlite";

export function auditPayouts(sql: DatabaseSync, now: number) {
  if (!sql.prepare("SELECT 1 FROM sqlite_schema WHERE name='epay_payouts' AND type='table'").get()) return { total: 0, processing: 0, overdue: 0, inconsistent: 0 };
  const summary = sql.prepare(`SELECT count(*) total,
    coalesce(sum(CASE WHEN p.status IN ('UNKNOWN','PROCESSING','WAIT_USER_CONFIRM') THEN 1 ELSE 0 END),0) processing,
    coalesce(sum(CASE WHEN p.status='UNKNOWN' AND p.submitted_at<? THEN 1 ELSE 0 END),0) overdue,
    coalesce(sum(CASE WHEN s.settlement_id IS NULL OR a.account_id IS NULL OR s.merchant_id<>p.merchant_id OR a.merchant_id<>p.merchant_id
      OR s.amount_cents<>p.amount_cents OR a.kind<>p.channel
      OR (p.status='SUCCEEDED' AND s.status<>'PAID')
      OR (p.status IN ('FAILED','REJECTED') AND s.status<>'REJECTED')
      OR (p.status NOT IN ('SUCCEEDED','FAILED','REJECTED') AND s.status<>'PENDING')
      OR NOT EXISTS(SELECT 1 FROM epay_balance_ledger h WHERE h.entry_id='epay_settlement_hold:'||p.settlement_id AND h.merchant_id=p.merchant_id AND h.entry_type='settlement_freeze' AND h.source='perpay_epay' AND h.available_delta_cents=-p.amount_cents AND h.frozen_delta_cents=p.amount_cents)
      OR (p.status IN ('SUCCEEDED','FAILED','REJECTED') AND NOT EXISTS(SELECT 1 FROM epay_balance_ledger f WHERE f.entry_id='epay_settlement_final:'||p.settlement_id AND f.merchant_id=p.merchant_id AND f.frozen_delta_cents=-p.amount_cents AND f.source='perpay_epay' AND f.available_delta_cents=CASE p.status WHEN 'SUCCEEDED' THEN 0 ELSE p.amount_cents END))
      OR (p.status IN ('SUCCEEDED','FAILED') AND NOT EXISTS(SELECT 1 FROM epay_payout_attempts t WHERE t.settlement_id=p.settlement_id AND t.outcome=p.status AND t.response_sha256=p.response_sha256))
      THEN 1 ELSE 0 END),0) inconsistent
    FROM epay_payouts p LEFT JOIN epay_native_settlements s ON s.settlement_id=p.settlement_id
    LEFT JOIN epay_payout_accounts a ON a.account_id=p.account_id`).get(now - 300_000)!;
  return { total: Number(summary.total), processing: Number(summary.processing), overdue: Number(summary.overdue), inconsistent: Number(summary.inconsistent) };
}
