import type { DatabaseSync } from "node:sqlite";

export function callbackHealth(sql: DatabaseSync, now: number) {
  const overdueBefore = now - 10 * 60 * 1000;
  const row = sql.prepare(`SELECT count(*) total,
    count(*) FILTER (WHERE status='SUCCEEDED') delivered,
    count(*) FILTER (WHERE status='FAILED') failed,
    count(*) FILTER (WHERE (status='PENDING' AND next_attempt_at<?) OR (status='LEASED' AND lease_until<?)) delayed,
    count(*) FILTER (WHERE status IN ('PENDING','LEASED') AND created_at<?) awaitingMerchant
    FROM epay_callback_jobs`).get(overdueBefore, overdueBefore, overdueBefore)!;
  return {
    total: Number(row.total), delivered: Number(row.delivered), failed: Number(row.failed),
    delayed: Number(row.delayed), awaitingMerchant: Number(row.awaitingMerchant),
  };
}
