import type { DatabaseSync } from "node:sqlite";

const MAX_SOURCE_AGE_MS = 90_000;

export function sourceSynchronizationReady(db: DatabaseSync, now: number): boolean {
  const row = db.prepare("SELECT value FROM system_metadata WHERE key='epay_source_sync'").get();
  if (!row) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(String(row.value)); } catch { return false; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const status = parsed as Record<string, unknown>;
  const capturedAt = typeof status.capturedAt === "string" ? Date.parse(status.capturedAt) : NaN;
  if (status.version !== 1 || status.ok !== true || !Number.isSafeInteger(capturedAt) || capturedAt > now || now - capturedAt > MAX_SOURCE_AGE_MS || !Number.isSafeInteger(status.appliedAt) || Number(status.appliedAt) < capturedAt || Number(status.appliedAt) > now || typeof status.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(status.sourceSha256)) return false;
  for (const [table, field] of [["epay_main_sync_runs", "mainSequence"], ["epay_legacy_sync_runs", "legacySequence"]] as const) {
    const latest = db.prepare(`SELECT sequence,captured_at FROM ${table} ORDER BY sequence DESC LIMIT 1`).get();
    if (!latest || Number(latest.sequence) !== status[field] || Number(latest.captured_at) > capturedAt) return false;
  }
  return true;
}
