import type { AppDatabase } from "../database/database.ts";
import type { DatabaseSync } from "node:sqlite";

export type QueryProvider = "alipay" | "wxpay";
export type QueryJob = { tradeNo: string; provider: QueryProvider; attempt: number; reservedUntil: number };
const PREFIX = "epay_payment_query:";
const QUERY_LEASE_MS = 60_000;
const PENDING_INTERVAL_MS = 15_000;
const FAILED_INTERVAL_MS = 60_000;

type QueryState = { version: 1; tradeNo: string; provider: QueryProvider; attempt: number; nextAt: number; lastOutcome: "reserved" | "pending" | "confirmed" | "failed" };

function queryState(value: unknown, tradeNo: string, provider: QueryProvider): QueryState | null {
  if (value === null) return null;
  const parsed: unknown = JSON.parse(String(value));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("EPay payment query state is invalid");
  const fields = parsed as Record<string, unknown>;
  if (fields.version !== 1 || fields.tradeNo !== tradeNo || fields.provider !== provider || !Number.isSafeInteger(fields.attempt) || Number(fields.attempt) < 1 || !Number.isSafeInteger(fields.nextAt) || Number(fields.nextAt) < 0 || !["reserved", "pending", "confirmed", "failed"].includes(String(fields.lastOutcome))) throw new Error("EPay payment query state is invalid");
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
    store(sql, { version: 1, tradeNo, provider, attempt, nextAt: reservedUntil, lastOutcome: "reserved" }, now);
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
    store(sql, { ...state, nextAt, lastOutcome: outcome }, now);
  });
}
