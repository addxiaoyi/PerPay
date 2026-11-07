import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AppDatabase } from "../database/database.ts";

type Database = Pick<AppDatabase, "read" | "write">;
type JobRow = { trade_no: string; merchant_id: bigint | number; attempts: bigint | number; next_method: "POST" | "GET"; retry_base_attempts: bigint | number; retry_base_gets: bigint | number };

function integer(value: number, name: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`invalid ${name}`);
}

export function enqueuePaidCallback(db: DatabaseSync, tradeNo: string, merchantId: number, now: number): boolean {
  integer(merchantId, "merchant ID", 1);
  integer(now, "time");
  if (!tradeNo) throw new Error("invalid trade number");
  if (!db.isTransaction) throw new Error("callback enqueue requires an active transaction");
  const order = db.prepare(`SELECT trade_no FROM epay_orders WHERE trade_no = ? AND merchant_id = ?
    AND status = 'PAID' AND money_cents > 0 AND real_money_cents = money_cents`).get(tradeNo, merchantId);
  if (!order) throw new Error("order is not an exact-amount confirmed payment for this merchant");
  const inserted = db.prepare(`INSERT INTO epay_callback_jobs(trade_no, merchant_id, status, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, 'PENDING', ?, ?, ?) ON CONFLICT(trade_no) DO NOTHING`).run(tradeNo, merchantId, now, now, now);
  return Number(inserted.changes) === 1;
}

export class EPayCallbackOutbox {
  readonly #database: Database;

  constructor(database: Database) { this.#database = database; }

  enqueue(tradeNo: string, merchantId: number, now: number): boolean {
    return this.#database.write((db) => enqueuePaidCallback(db, tradeNo, merchantId, now));
  }

  claim(now: number, leaseMilliseconds: number, maximumAttempts: number) {
    integer(now, "time");
    integer(leaseMilliseconds, "lease duration", 1);
    integer(maximumAttempts, "maximum attempts", 1);
    if (leaseMilliseconds > 120_000 || maximumAttempts > 100 || !Number.isSafeInteger(now + leaseMilliseconds)) throw new Error("invalid callback claim policy");
    return this.#database.write((db) => {
      db.prepare(`UPDATE epay_orders SET notify_status = 'FAILED'
        WHERE EXISTS (SELECT 1 FROM epay_callback_jobs j WHERE j.trade_no = epay_orders.trade_no
          AND j.merchant_id = epay_orders.merchant_id AND j.status = 'LEASED' AND j.lease_until <= ?
          AND ((j.next_method = 'POST' AND j.attempts - j.retry_base_attempts >= ?) OR (j.next_method = 'GET' AND
            (SELECT count(*) FROM epay_callback_attempts a WHERE a.trade_no = j.trade_no AND a.method = 'GET') - j.retry_base_gets >= ?)))`).run(now, maximumAttempts, maximumAttempts);
      db.prepare(`UPDATE epay_orders SET notify_status = 'FAILED'
        WHERE EXISTS (SELECT 1 FROM epay_callback_jobs j WHERE j.trade_no = epay_orders.trade_no
          AND j.merchant_id = epay_orders.merchant_id AND j.status = 'PENDING'
          AND ((j.next_method = 'POST' AND j.attempts - j.retry_base_attempts >= ?) OR (j.next_method = 'GET' AND
            (SELECT count(*) FROM epay_callback_attempts a WHERE a.trade_no = j.trade_no AND a.method = 'GET') - j.retry_base_gets >= ?)))`).run(maximumAttempts, maximumAttempts);
      db.prepare(`UPDATE epay_callback_attempts SET outcome = 'EXPIRED', finished_at = ?
        WHERE outcome = 'STARTED' AND trade_no IN (SELECT trade_no FROM epay_callback_jobs WHERE status = 'LEASED' AND lease_until <= ?)` ).run(now, now);
      db.prepare(`UPDATE epay_callback_jobs SET status = 'FAILED', lease_token = NULL, lease_until = NULL, updated_at = ?
        WHERE status = 'LEASED' AND lease_until <= ? AND ((next_method = 'POST' AND attempts - retry_base_attempts >= ?) OR
          (next_method = 'GET' AND (SELECT count(*) FROM epay_callback_attempts a WHERE a.trade_no = epay_callback_jobs.trade_no AND a.method = 'GET') - retry_base_gets >= ?))`).run(now, now, maximumAttempts, maximumAttempts);
      db.prepare(`UPDATE epay_callback_jobs SET status = 'FAILED', updated_at = ?
        WHERE status = 'PENDING' AND ((next_method = 'POST' AND attempts - retry_base_attempts >= ?) OR
          (next_method = 'GET' AND (SELECT count(*) FROM epay_callback_attempts a WHERE a.trade_no = epay_callback_jobs.trade_no AND a.method = 'GET') - retry_base_gets >= ?))`).run(now, maximumAttempts, maximumAttempts);
      const job = db.prepare(`SELECT trade_no, merchant_id, attempts, next_method, retry_base_attempts, retry_base_gets FROM epay_callback_jobs
        WHERE ((next_method = 'POST' AND attempts - retry_base_attempts < ?) OR (next_method = 'GET' AND
          (SELECT count(*) FROM epay_callback_attempts a WHERE a.trade_no = epay_callback_jobs.trade_no AND a.method = 'GET') - retry_base_gets < ?))
          AND ((status = 'PENDING' AND next_attempt_at <= ?) OR (status = 'LEASED' AND lease_until <= ?))
        ORDER BY next_attempt_at, trade_no LIMIT 1`).get(maximumAttempts, maximumAttempts, now, now) as JobRow | undefined;
      if (!job) return null;
      const token = randomUUID();
      const attemptId = randomUUID();
      const attemptNumber = Number(job.attempts) + 1;
      db.prepare(`UPDATE epay_callback_jobs SET status = 'LEASED', attempts = ?, lease_token = ?, lease_until = ?, updated_at = ? WHERE trade_no = ?`)
        .run(attemptNumber, token, now + leaseMilliseconds, now, job.trade_no);
      const mainOrder = !!db.prepare("SELECT 1 FROM epay_main_native_orders WHERE trade_no=?").get(job.trade_no);
      const wireFormat = mainOrder ? job.next_method === "POST" ? "main_form" : "main_json" : job.next_method === "POST" ? "epay_form" : "epay_query";
      db.prepare(`INSERT INTO epay_callback_attempts(attempt_id, trade_no, attempt_number, started_at, outcome, method, wire_format) VALUES (?, ?, ?, ?, 'STARTED', ?, ?)`)
        .run(attemptId, job.trade_no, attemptNumber, now, job.next_method, wireFormat);
      const order = db.prepare(`UPDATE epay_orders SET notify_status = 'PENDING', notify_count = notify_count + 1, notify_last_at = ?
        WHERE trade_no = ? AND merchant_id = ?`).run(now, job.trade_no, job.merchant_id);
      if (Number(order.changes) !== 1) throw new Error("callback order not found");
      return { tradeNo: job.trade_no, merchantId: Number(job.merchant_id), attemptId, leaseToken: token, attemptNumber, method: job.next_method };
    });
  }

  complete(input: { tradeNo: string; attemptId: string; leaseToken: string; now: number; acknowledged: boolean; retryable?: boolean; retryDelayMilliseconds: number; maximumAttempts: number; httpStatus?: number; errorCode?: string }): void {
    integer(input.now, "time");
    integer(input.retryDelayMilliseconds, "retry delay", 1);
    integer(input.maximumAttempts, "maximum attempts", 1);
    if (input.maximumAttempts > 100 || !Number.isSafeInteger(input.now + input.retryDelayMilliseconds)) throw new Error("invalid callback retry policy");
    if (input.httpStatus !== undefined && (!Number.isInteger(input.httpStatus) || input.httpStatus < 100 || input.httpStatus > 599)) throw new Error("invalid HTTP status");
    if (input.errorCode !== undefined && !/^[a-z0-9_]{1,64}$/.test(input.errorCode)) throw new Error("invalid error code");
    this.#database.write((db) => {
      const job = db.prepare(`SELECT j.trade_no, j.merchant_id, j.attempts, j.next_method, j.retry_base_attempts, j.retry_base_gets, a.started_at FROM epay_callback_jobs j
        JOIN epay_callback_attempts a ON a.trade_no = j.trade_no AND a.attempt_number = j.attempts
        WHERE j.trade_no = ? AND j.status = 'LEASED' AND j.lease_token = ? AND j.lease_until > ? AND a.attempt_id = ? AND a.outcome = 'STARTED'`)
        .get(input.tradeNo, input.leaseToken, input.now, input.attemptId) as (JobRow & { started_at: bigint | number }) | undefined;
      if (!job) throw new Error("callback lease is stale or does not match");
      if (BigInt(input.now) < BigInt(job.started_at)) throw new Error("callback completion predates attempt");
      const mainOrder = !!db.prepare("SELECT 1 FROM epay_main_native_orders WHERE trade_no=?").get(input.tradeNo);
      const fallback = !input.acknowledged && job.next_method === 'POST' && (mainOrder
        ? input.retryable !== false
        : Number(job.attempts) - Number(job.retry_base_attempts) >= input.maximumAttempts && (input.httpStatus === 405 || input.httpStatus === 415));
      const methodAttempts = job.next_method === 'POST' ? Number(job.attempts) - Number(job.retry_base_attempts) : Number((db.prepare("SELECT count(*) AS count FROM epay_callback_attempts WHERE trade_no = ? AND method = 'GET'").get(input.tradeNo) as { count: number | bigint }).count) - Number(job.retry_base_gets);
      const retry = !input.acknowledged && (fallback || (input.retryable !== false && methodAttempts < input.maximumAttempts));
      const outcome = input.acknowledged ? "SUCCESS" : retry ? "RETRY" : "FAILED";
      db.prepare(`UPDATE epay_callback_attempts SET outcome = ?, finished_at = ?, http_status = ?, error_code = ? WHERE attempt_id = ?`)
        .run(outcome, input.now, input.httpStatus ?? null, input.errorCode ?? null, input.attemptId);
      db.prepare(`UPDATE epay_callback_jobs SET status = ?, next_attempt_at = ?, next_method = ?, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE trade_no = ?`)
        .run(input.acknowledged ? "SUCCEEDED" : retry ? "PENDING" : "FAILED", retry ? input.now + input.retryDelayMilliseconds : input.now, fallback ? "GET" : job.next_method, input.now, input.tradeNo);
      const order = db.prepare(`UPDATE epay_orders SET notify_status = ? WHERE trade_no = ? AND merchant_id = ?`)
        .run(input.acknowledged ? "SUCCESS" : retry ? "PENDING" : "FAILED", input.tradeNo, job.merchant_id);
      if (Number(order.changes) !== 1) throw new Error("callback order not found");
    });
  }
}
