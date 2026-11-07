import type { AppDatabase } from "../database/database.ts";
import type { DatabaseSync } from "node:sqlite";

export type QueryProvider = "alipay" | "wxpay";
export type QueryJob = { tradeNo: string; provider: QueryProvider; attempt: number; reservedUntil: number };
const PREFIX = "epay_payment_query:";
const QUERY_LEASE_MS = 60_000;
const PENDING_INTERVAL_MS = 15_000;
const FAILED_INTERVAL_MS = 60_000;
const RECOVERY_GRACE_MS = 120_000;
const MAX_FAILURE_AGE_MS = 300_000;

type QueryState = { version: 1; tradeNo: string; provider: QueryProvider; attempt: number; nextAt: number; lastOutcome: "reserved" | "pending" | "confirmed" | "failed"; failureSince?: number | undefined };

function queryState(value: unknown, tradeNo: string, provider: QueryProvider): QueryState | null {
  if (value === null) return null;
  const parsed: unknown = JSON.parse(String(value));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("EPay payment query state is invalid");
  const fields = parsed as Record<string, unknown>;
  if (fields.version !== 1 || fields.tradeNo !== tradeNo || fields.provider !== provider || !Number.isSafeInteger(fields.attempt) || Number(fields.attempt) < 1 || !Number.isSafeInteger(fields.nextAt) || Number(fields.nextAt) < 0 || !["reserved", "pending", "confirmed", "failed"].includes(String(fields.lastOutcome))) throw new Error("EPay payment query state is invalid");
  if (fields.failureSince !== undefined && (!Number.isSafeInteger(fields.failureSince) || Number(fields.failureSince) < 0)) throw new Error("EPay payment failure time is invalid");
  return fields as QueryState;
}

function store(sql: DatabaseSync, state: QueryState, now: number) {
  sql.prepare("INSERT INTO system_metadata(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
    .run(PREFIX + state.tradeNo, JSON.stringify(state), now);
}

export function reservePaymentQuery(database: Pick<AppDatabase, "write">, now: number): QueryJob | null {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + QUERY_LEASE_MS)) throw new Error("invalid EPay payment query time");
  return database.write(sql => {
    const rows = sql.prepare(`SELECT o.trade_no,o.type_code,m.value FROM epay_orders o
      LEFT JOIN system_metadata m ON m.key=? || o.trade_no
      WHERE o.status='PENDING' AND o.created_at<=?
        AND ((o.type_code='alipay' AND EXISTS(SELECT 1 FROM epay_alipay_submissions s WHERE s.trade_no=o.trade_no AND s.state IN ('IN_FLIGHT','UNCERTAIN')))
          OR (o.type_code='wxpay' AND EXISTS(SELECT 1 FROM epay_wechat_submissions s WHERE s.trade_no=o.trade_no AND s.state IN ('IN_FLIGHT','UNCERTAIN'))))
      ORDER BY coalesce(json_extract(m.value,'$.nextAt'),0),o.trade_no LIMIT 1`).all(PREFIX, now - 5_000);
    const row = rows[0];
    if (!row) return null;
    if (row.type_code !== "alipay" && row.type_code !== "wxpay") throw new Error("invalid EPay query provider");
    const tradeNo = String(row.trade_no), provider = row.type_code;
    const current = queryState(row.value, tradeNo, provider);
    if (current && current.nextAt > now) return null;
    const attempt = (current?.attempt ?? 0) + 1, reservedUntil = now + QUERY_LEASE_MS;
    if (!Number.isSafeInteger(attempt)) throw new Error("EPay query attempt limit exceeded");
    store(sql, { version: 1, tradeNo, provider, attempt, nextAt: reservedUntil, lastOutcome: "reserved", failureSince: current?.failureSince }, now);
    return { tradeNo, provider, attempt, reservedUntil };
  });
}

export function completePaymentQuery(database: Pick<AppDatabase, "write">, job: QueryJob, outcome: "pending" | "confirmed" | "failed", now: number): void {
  if (!Number.isSafeInteger(now) || now < job.reservedUntil - QUERY_LEASE_MS || !["pending", "confirmed", "failed"].includes(outcome)) throw new Error("invalid EPay query completion");
  database.write(sql => {
    const saved = sql.prepare("SELECT value FROM system_metadata WHERE key=?").get(PREFIX + job.tradeNo);
    const state = queryState(saved?.value ?? null, job.tradeNo, job.provider);
    if (!state || state.attempt !== job.attempt || state.nextAt !== job.reservedUntil || state.lastOutcome !== "reserved") throw new Error("EPay query reservation is stale");
    const nextAt = now + (outcome === "failed" ? FAILED_INTERVAL_MS : PENDING_INTERVAL_MS);
    if (!Number.isSafeInteger(nextAt)) throw new Error("EPay query schedule overflow");
    store(sql, { ...state, nextAt, lastOutcome: outcome, failureSince: outcome === "failed" ? state.failureSince ?? now : undefined }, now);
  });
}

// Local payment status alone cannot show that missed channel notifications are still being recovered.
export function auditPaymentQueries(sql: DatabaseSync, now: number) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid recovery audit time");
  const rows = sql.prepare(`SELECT o.trade_no,o.type_code,o.created_at,m.value,m.updated_at,
    coalesce(a.state,w.state) submission_state FROM epay_orders o
    LEFT JOIN epay_alipay_submissions a ON a.trade_no=o.trade_no
    LEFT JOIN epay_wechat_submissions w ON w.trade_no=o.trade_no
    LEFT JOIN system_metadata m ON m.key=? || o.trade_no
    WHERE o.status='PENDING' AND (a.trade_no IS NOT NULL OR w.trade_no IS NOT NULL)`).all(PREFIX);
  let overdue = 0, failed = 0, stalled = 0, invalid = 0;
  for (const row of rows) {
    try {
      if (!["alipay", "wxpay"].includes(String(row.type_code)) || !["IN_FLIGHT", "UNCERTAIN"].includes(String(row.submission_state))) throw new Error("invalid pending submission");
      const state = queryState(row.value, String(row.trade_no), row.type_code as QueryProvider);
      if (!state) { if (now - Number(row.created_at) > RECOVERY_GRACE_MS) overdue++; continue; }
      const updatedAt = Number(row.updated_at);
      if (!Number.isSafeInteger(updatedAt) || updatedAt < 0 || updatedAt > now || state.nextAt > updatedAt + QUERY_LEASE_MS || state.lastOutcome === "confirmed" || (state.failureSince !== undefined && state.failureSince > updatedAt)) throw new Error("invalid recovery deadline");
      if (now - state.nextAt > RECOVERY_GRACE_MS) overdue++;
      if (state.lastOutcome === "failed") failed++;
      if (state.failureSince !== undefined && now - state.failureSince >= MAX_FAILURE_AGE_MS) stalled++;
    } catch { invalid++; }
  }
  return { healthy: overdue + stalled + invalid === 0, pending: rows.length, overdue, failed, stalled, invalid };
}
