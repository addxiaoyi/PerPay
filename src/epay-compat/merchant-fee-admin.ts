import type { AppDatabase } from "../database/database.ts";
import { appendAuditEvent } from "../database/identity-store.ts";

type Database = Pick<AppDatabase, "read" | "write">;

export class MerchantFeeConflict extends Error {}

export function listMerchantFees(database: Pick<Database, "read">, after: number, limit: number) {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid merchant fee page");
  return database.read(db => {
    const rows = db.prepare("SELECT merchant_id,name,enabled,fee_rate_bps,updated_at FROM epay_merchant_accounts WHERE merchant_id>? ORDER BY merchant_id LIMIT ?").all(after, limit + 1);
    const merchants = rows.slice(0, limit).map(row => {
      const merchantId = Number(row.merchant_id), feeBps = Number(row.fee_rate_bps), version = Number(row.updated_at), enabled = Number(row.enabled);
      if (!Number.isSafeInteger(merchantId) || merchantId < 1 || typeof row.name !== "string" || !Number.isSafeInteger(feeBps) || feeBps < 0 || feeBps > 5000 || !Number.isSafeInteger(version) || version < 0 || (enabled !== 0 && enabled !== 1)) throw new Error("invalid stored merchant fee");
      return { merchantId, name: row.name, enabled: enabled === 1, feeBps, version };
    });
    return { merchants, nextAfter: rows.length > limit ? merchants.at(-1)!.merchantId : null };
  });
}

export function readMerchantFeeHistory(database: Pick<Database, "read">, merchantId: number, before: number | null, limit: number) {
  if (!Number.isSafeInteger(merchantId) || merchantId < 1 || (before !== null && (!Number.isSafeInteger(before) || before < 1)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid merchant fee history page");
  return database.read(db => {
    const rows = db.prepare(`SELECT sequence,occurred_at,actor_id,details_json FROM audit_events
      WHERE action='epay.merchant_fee.updated' AND subject_type='epay_merchant' AND subject_id=?
      AND (? IS NULL OR sequence<?) ORDER BY sequence DESC LIMIT ?`).all(String(merchantId), before, before, limit + 1);
    const changes = rows.slice(0, limit).map(row => {
      const sequence = Number(row.sequence), occurredAt = Number(row.occurred_at);
      const details: unknown = JSON.parse(String(row.details_json));
      if (!Number.isSafeInteger(sequence) || sequence < 1 || !Number.isSafeInteger(occurredAt) || occurredAt < 0 || typeof row.actor_id !== "string" || !row.actor_id || !details || typeof details !== "object" || Array.isArray(details)) throw new Error("invalid stored fee audit");
      const { oldFeeBps, newFeeBps, reason } = details as Record<string, unknown>;
      if (![oldFeeBps, newFeeBps].every(value => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 5000) || typeof reason !== "string" || !reason || reason.length > 512 || /[\x00-\x1f\x7f]/.test(reason)) throw new Error("invalid stored fee audit");
      return { sequence, occurredAt, actor: row.actor_id, oldFeeBps, newFeeBps, reason };
    });
    return { changes, nextBefore: rows.length > limit ? changes.at(-1)!.sequence : null };
  });
}

export function readMerchantFee(database: Pick<Database, "read">, merchantId: number) {
  if (!Number.isSafeInteger(merchantId) || merchantId < 1) throw new Error("invalid merchant ID");
  return database.read(db => {
    const row = db.prepare("SELECT merchant_id,fee_rate_bps,updated_at FROM epay_merchant_accounts WHERE merchant_id=?").get(merchantId);
    if (!row) return null;
    const feeBps = Number(row.fee_rate_bps), version = Number(row.updated_at);
    if (!Number.isSafeInteger(feeBps) || feeBps < 0 || feeBps > 5000 || !Number.isSafeInteger(version) || version < 0) throw new Error("invalid stored merchant fee");
    return { merchantId, feeBps, version };
  });
}

// The caller must authenticate an administrator and provide the session actor.
export function changeMerchantFee(database: Pick<Database, "write">, input: { merchantId: number; expectedFeeBps: number; expectedVersion: number; feeBps: number; reason: string; actor: string }, now: number) {
  const { merchantId, expectedFeeBps, expectedVersion, feeBps, reason, actor } = input;
  if (!Number.isSafeInteger(merchantId) || merchantId < 1 || ![expectedFeeBps, feeBps].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 5000) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || !Number.isSafeInteger(now) || now <= expectedVersion || expectedFeeBps === feeBps || !reason || reason !== reason.trim() || reason.length > 512 || /[\x00-\x1f\x7f]/.test(reason) || !actor || actor.length > 128 || /[\x00-\x1f\x7f]/.test(actor)) throw new Error("invalid merchant fee change");
  database.write(db => {
    const changed = db.prepare("UPDATE epay_merchant_accounts SET fee_rate_bps=?,updated_at=? WHERE merchant_id=? AND fee_rate_bps=? AND updated_at=?").run(feeBps, now, merchantId, expectedFeeBps, expectedVersion);
    if (Number(changed.changes) !== 1) throw new MerchantFeeConflict("merchant fee changed or is unavailable");
    appendAuditEvent(db, { occurredAt: now, actorType: "ADMIN", actorId: actor, action: "epay.merchant_fee.updated", outcome: "SUCCESS", subjectType: "epay_merchant", subjectId: String(merchantId), details: { oldFeeBps: expectedFeeBps, newFeeBps: feeBps, reason } });
  });
  return { merchantId, feeBps, version: now };
}
