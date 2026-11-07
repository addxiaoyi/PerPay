import type { DatabaseSync } from "node:sqlite";
import { appendAuditEvent } from "../database/identity-store.ts";
import { readConfirmedOrder } from "./confirmed-order.ts";

export class CallbackRetryConflict extends Error {}
export function retryMerchantCallback(sql: DatabaseSync, input: { tradeNo: string; merchantId: number; requestId: string; actor: string }, now: number) {
  if (!sql.isTransaction || !Number.isSafeInteger(now) || now < 0 || !/^[a-zA-Z0-9_-]{16,80}$/.test(input.requestId) || !input.actor || input.actor.length > 128) throw new Error("invalid callback retry command");
  const prior = sql.prepare("SELECT merchant_id,actor_id FROM epay_callback_retries WHERE trade_no=? AND request_id=?").get(input.tradeNo, input.requestId);
  if (prior) {
    if (Number(prior.merchant_id) !== input.merchantId || prior.actor_id !== input.actor) throw new CallbackRetryConflict("callback retry identity differs");
    return { queued: true, duplicate: true };
  }
  if (!readConfirmedOrder(sql, input.tradeNo, input.merchantId)) throw new CallbackRetryConflict("callback requires this merchant's confirmed native order");
  const job = sql.prepare("SELECT * FROM epay_callback_jobs WHERE trade_no=? AND merchant_id=?").get(input.tradeNo, input.merchantId);
  if (!job || now < Number(job.updated_at)) throw new CallbackRetryConflict("callback job unavailable");
  if (job.status === "LEASED") throw new CallbackRetryConflict("callback is in flight");
  if (job.status === "SUCCEEDED") return { queued: false, duplicate: true };
  if (job.status === "PENDING") return { queued: true, duplicate: true };
  const last = sql.prepare("SELECT max(requested_at) requested_at FROM epay_callback_retries WHERE trade_no=?").get(input.tradeNo);
  if (last?.requested_at !== null && now - Number(last?.requested_at) < 60000) throw new CallbackRetryConflict("callback retry is too soon");
  const gets = Number(sql.prepare("SELECT count(*) n FROM epay_callback_attempts WHERE trade_no=? AND method='GET'").get(input.tradeNo)?.n);
  sql.prepare("INSERT INTO epay_callback_retries VALUES(?,?,?,?,?,?,?)").run(input.requestId, input.tradeNo, input.merchantId, input.actor, Number(job.attempts), gets, now);
  sql.prepare(`UPDATE epay_callback_jobs SET status='PENDING',next_method='POST',next_attempt_at=?,updated_at=?,lease_token=NULL,lease_until=NULL,
    retry_base_attempts=attempts,retry_base_gets=? WHERE trade_no=?`).run(now, now, gets, input.tradeNo);
  sql.prepare("UPDATE epay_orders SET notify_status='PENDING' WHERE trade_no=? AND merchant_id=?").run(input.tradeNo, input.merchantId);
  appendAuditEvent(sql, { occurredAt: now, actorType: "SYSTEM", actorId: input.actor, action: "epay.callback.retry_requested", outcome: "SUCCESS",
    subjectType: "epay_order", subjectId: input.tradeNo, details: { previousAttempts: Number(job.attempts), requestId: input.requestId } });
  return { queued: true, duplicate: false };
}
