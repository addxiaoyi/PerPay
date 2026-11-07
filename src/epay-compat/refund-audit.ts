import type { DatabaseSync } from "node:sqlite";

export function auditNativeRefunds(sql: DatabaseSync) {
  const row = sql.prepare(`SELECT count(*) refunds,
    coalesce(sum(CASE WHEN r.status IN ('REQUESTED','READY','PROCESSING','UNKNOWN') THEN 1 ELSE 0 END),0) pending,
    coalesce(sum(CASE WHEN r.status='UNKNOWN' THEN 1 ELSE 0 END),0) uncertain,
    coalesce(sum(CASE WHEN
      (r.status IN ('REQUESTED','REJECTED') AND h.entry_id IS NOT NULL) OR
      (r.status NOT IN ('REQUESTED','REJECTED') AND (h.entry_id IS NULL OR h.merchant_id<>r.merchant_id OR
        h.entry_type<>'refund_hold' OR h.source<>'perpay_epay' OR h.available_delta_cents<>-r.debit_cents OR h.frozen_delta_cents<>r.debit_cents)) OR
      (r.status NOT IN ('SUCCEEDED','CLOSED') AND f.entry_id IS NOT NULL) OR
      (r.status IN ('SUCCEEDED','CLOSED') AND (f.entry_id IS NULL OR f.merchant_id<>r.merchant_id OR f.source<>'perpay_epay' OR
        f.entry_type<>CASE r.status WHEN 'SUCCEEDED' THEN 'refund_paid' ELSE 'refund_released' END OR
        f.frozen_delta_cents<>-r.debit_cents OR f.available_delta_cents<>CASE r.status WHEN 'CLOSED' THEN r.debit_cents ELSE 0 END OR
        r.response_sha256 IS NULL OR NOT EXISTS(SELECT 1 FROM epay_native_refund_attempts a WHERE a.refund_no=r.refund_no AND a.outcome=r.status AND a.response_sha256=r.response_sha256)))
      THEN 1 ELSE 0 END),0) inconsistent
    FROM epay_native_refunds r
    LEFT JOIN epay_balance_ledger h ON h.entry_id='epay_refund_hold:'||r.refund_no
    LEFT JOIN epay_balance_ledger f ON f.entry_id='epay_refund_final:'||r.refund_no`).get()!;
  const totals = Object.fromEntries(Object.entries(row).map(([name, count]) => {
    const value = Number(count);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("refund audit exceeds safe integer range");
    return [name, value];
  })) as { refunds: number; pending: number; uncertain: number; inconsistent: number };
  return totals;
}
