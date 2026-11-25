import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";

const ORDER_PREFIX = "epay_fee_invoice_queue:";
const PROVIDER_KEY = "epay_fee_invoice_provider_state";
const MAX_ATTEMPTS = 30;
const MAX_DELAY_MS = 30 * 60_000;
const stateInput = z.object({
  version: z.literal(1), attempts: z.number().int().min(0).max(MAX_ATTEMPTS),
  nextAt: z.number().int().safe().nonnegative(), checkedAt: z.number().int().safe().nonnegative(),
  code: z.string().regex(/^[a-z0-9_-]{1,80}$/).nullable(),
}).strict();
export type FeeQueueState = z.infer<typeof stateInput>;

function readState(sql: DatabaseSync, key: string): FeeQueueState | null {
  const row = sql.prepare("SELECT value FROM system_metadata WHERE key=?").get(key);
  if (!row) return null;
  try { return stateInput.parse(JSON.parse(String(row.value))); }
  catch { throw new Error("invoices/fee-queue: stored queue state is invalid"); }
}
function writeState(sql: DatabaseSync, key: string, state: FeeQueueState) {
  const parsed = stateInput.parse(state);
  sql.prepare("INSERT INTO system_metadata(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
    .run(key, JSON.stringify(parsed), parsed.checkedAt);
}
export const readProviderState = (sql: DatabaseSync) => readState(sql, PROVIDER_KEY);
export const readFeeQueueState = (sql: DatabaseSync, tradeNo: string) => readState(sql, ORDER_PREFIX + tradeNo);

export function deferFeeQueue(sql: DatabaseSync, tradeNo: string | null, code: string, now: number): FeeQueueState {
  const key = tradeNo === null ? PROVIDER_KEY : ORDER_PREFIX + tradeNo;
  const previous = readState(sql, key), attempts = Math.min(MAX_ATTEMPTS, (previous?.attempts ?? 0) + 1);
  const delay = Math.min(MAX_DELAY_MS, (tradeNo === null ? 5 * 60_000 : 60_000) * 2 ** Math.min(attempts - 1, 10));
  const state: FeeQueueState = { version: 1, attempts, nextAt: now + delay, checkedAt: now, code };
  writeState(sql, key, state); return state;
}
export function clearProviderState(sql: DatabaseSync, now: number): FeeQueueState {
  const state: FeeQueueState = { version: 1, attempts: 0, nextAt: 0, checkedAt: now, code: null };
  writeState(sql, PROVIDER_KEY, state); return state;
}
export function providerQueueFailure(code: string): boolean {
  if (code === "fapiao_reconcile_required") return false;
  return code.startsWith("fapiao_") || ["invoice_provider_unavailable", "invoice_not_authorized", "invoice_unconfigured", "response_unavailable", "invalid_token", "invalid_response"].includes(code);
}
