import type { DatabaseSync } from "node:sqlite";

type Account = { merchant_id: number; balance_cents: number };
type Entry = { entry_id: string; merchant_id: number; entry_type: string; available_delta_cents: number; frozen_delta_cents: number; reason: string | null; actor_id: string | null; occurred_at: number; source: string };

export interface BalanceCheckpoint {
  readonly accounts: readonly Account[];
  readonly ledger: readonly Entry[];
}

function checkedInteger(value: unknown, minimum: number): number {
  if (typeof value !== "number" && typeof value !== "bigint") throw new Error("invalid balance checkpoint integer");
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted < minimum) throw new Error("invalid balance checkpoint integer");
  return converted;
}

// Both queries must see the same SQLite snapshot, including when another process writes.
export function captureBalanceCheckpoint(db: DatabaseSync): BalanceCheckpoint {
  if (!db.isTransaction) throw new Error("balance checkpoint requires a transaction");
  const accounts = db.prepare("SELECT merchant_id, balance_cents FROM epay_merchant_accounts ORDER BY merchant_id").all().map((row) => ({ merchant_id: checkedInteger(row.merchant_id, 1), balance_cents: checkedInteger(row.balance_cents, 0) }));
  const ledger = db.prepare("SELECT entry_id, merchant_id, entry_type, available_delta_cents, frozen_delta_cents, reason, actor_id, occurred_at, source FROM epay_balance_ledger ORDER BY entry_id").all().map((row) => ({ ...row, merchant_id: checkedInteger(row.merchant_id, 1), available_delta_cents: checkedInteger(row.available_delta_cents, Number.MIN_SAFE_INTEGER), frozen_delta_cents: checkedInteger(row.frozen_delta_cents, Number.MIN_SAFE_INTEGER), occurred_at: checkedInteger(row.occurred_at, 0) })) as Entry[];
  return { accounts, ledger };
}

function indexCheckpoint(checkpoint: BalanceCheckpoint) {
  if (!checkpoint || !Array.isArray(checkpoint.accounts) || !Array.isArray(checkpoint.ledger)) throw new Error("invalid balance checkpoint");
  const accounts = new Map<number, bigint>();
  for (const account of checkpoint.accounts) {
    const id = checkedInteger(account.merchant_id, 1);
    const balance = checkedInteger(account.balance_cents, 0);
    if (accounts.has(id)) throw new Error("duplicate checkpoint merchant");
    accounts.set(id, BigInt(balance));
  }
  const entries = new Map<string, Entry>();
  for (const entry of checkpoint.ledger) {
    if (typeof entry.entry_id !== "string" || !entry.entry_id || entries.has(entry.entry_id) || typeof entry.source !== "string" || !entry.source || typeof entry.entry_type !== "string" || !entry.entry_type || (entry.reason !== null && typeof entry.reason !== "string") || (entry.actor_id !== null && typeof entry.actor_id !== "string")) throw new Error("invalid or duplicate checkpoint entry");
    const merchant = checkedInteger(entry.merchant_id, 1);
    const available = checkedInteger(entry.available_delta_cents, Number.MIN_SAFE_INTEGER);
    const frozen = checkedInteger(entry.frozen_delta_cents, Number.MIN_SAFE_INTEGER);
    const occurredAt = checkedInteger(entry.occurred_at, 0);
    if (!accounts.has(merchant)) throw new Error("checkpoint entry merchant missing");
    entries.set(entry.entry_id, { ...entry, merchant_id: merchant, available_delta_cents: available, frozen_delta_cents: frozen, occurred_at: occurredAt });
  }
  return { accounts, entries };
}

// This compares movements from an explicit baseline, not the correctness of that baseline.
export function auditBalanceMovements(baseline: BalanceCheckpoint, current: BalanceCheckpoint) {
  const before = indexCheckpoint(baseline);
  const after = indexCheckpoint(current);
  let missingMerchants = 0, newMerchants = 0, changedEntries = 0, removedEntries = 0, balanceMismatches = 0;
  const deltas = new Map<number, bigint>();
  for (const id of before.accounts.keys()) if (!after.accounts.has(id)) missingMerchants++;
  for (const id of after.accounts.keys()) if (!before.accounts.has(id)) newMerchants++;
  for (const [id, entry] of before.entries) {
    const next = after.entries.get(id);
    if (!next) { removedEntries++; continue; }
    if (entry.merchant_id !== next.merchant_id || entry.entry_type !== next.entry_type || entry.available_delta_cents !== next.available_delta_cents || entry.frozen_delta_cents !== next.frozen_delta_cents || entry.reason !== next.reason || entry.actor_id !== next.actor_id || entry.occurred_at !== next.occurred_at || entry.source !== next.source) changedEntries++;
  }
  for (const [id, entry] of after.entries) {
    if (before.entries.has(id)) continue;
    deltas.set(entry.merchant_id, (deltas.get(entry.merchant_id) ?? 0n) + BigInt(entry.available_delta_cents));
  }
  for (const [id, balance] of before.accounts) {
    const actual = after.accounts.get(id);
    if (actual !== undefined && actual !== balance + (deltas.get(id) ?? 0n)) balanceMismatches++;
  }
  return { merchantsCompared: before.accounts.size - missingMerchants, missingMerchants, newMerchants, changedEntries, removedEntries, balanceMismatches, baselineVerified: false as const, financiallyReconciled: false as const };
}
