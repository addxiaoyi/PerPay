import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { RuntimeSecretCipher } from "../settings/crypto.ts";
import { readCurrentMainPayment } from "./main-delta-store.ts";
import { canonicalSource } from "./source-drift.ts";
import { verifyWechatMasterKeyGuard } from "./wechat-master-key.ts";
import { readLiveBalance, safeCents } from "./live-balance.ts";
import { planLegacyDelta, validateLegacyTables, validateLegacyColumns, type LegacyTables, type LegacyColumns } from "./legacy-delta-plan.ts";
import { legacyMappings, mappedLegacyRow, projectLegacyLiabilities, verifyLegacyOrder } from "./legacy-projection.ts";
export type { LegacyTables, LegacyColumns } from "./legacy-delta-plan.ts";

type Payload = { tables: LegacyTables; columns: LegacyColumns; mainPayment: unknown; sourceOffsetMinutes: number };
type Capture = { tables: LegacyTables; columns: LegacyColumns; expectedSha256: string; capturedAt: number; appliedAt: number; responseSha256: string };
const digest = (value: unknown) => createHash("sha256").update(canonicalSource(value)).digest("hex");
const secretName = (sequence: number, hash: string) => `epay:config:legacy-delta:${sequence}:${hash}` as const;
const MAX_APPLY_DELAY_MS = 30_000;

export function readLegacyCursor(db: DatabaseSync, cipher: RuntimeSecretCipher) {
  verifyWechatMasterKeyGuard(db, cipher);
  const row = db.prepare("SELECT * FROM epay_legacy_sync_runs ORDER BY sequence DESC LIMIT 1").get();
  if (!row) throw new Error("legacy synchronization cursor is missing");
  const sequence = Number(row.sequence), sourceSha256 = String(row.source_sha256);
  const raw = cipher.decrypt(secretName(sequence, sourceSha256), 1, { cipherVersion: 1, nonce: Buffer.from(row.nonce as Uint8Array), ciphertext: Buffer.from(row.ciphertext as Uint8Array), authenticationTag: Buffer.from(row.authentication_tag as Uint8Array) });
  try {
    const payload = JSON.parse(raw.toString("utf8")) as Payload;
    if (digest(payload) !== sourceSha256) throw new Error("legacy synchronization cursor hash differs");
    validateLegacyTables(payload.tables);
    validateLegacyColumns(payload.tables, payload.columns);
    return { ...payload, sequence, sourceSha256, capturedAt: Number(row.captured_at) };
  } finally { raw.fill(0); }
}

function appendCursor(db: DatabaseSync, cipher: RuntimeSecretCipher, payload: Payload, proof: { sequence: number; previous: string; capturedAt: number; appliedAt: number; responseSha256: string; postedEntries: number }) {
  const sourceSha256 = digest(payload), sealed = cipher.encrypt(secretName(proof.sequence, sourceSha256), 1, JSON.stringify(payload));
  db.prepare("INSERT INTO epay_legacy_sync_runs VALUES(?,?,?,?,?,?,?,?,?,?)").run(proof.sequence, proof.previous, sourceSha256, proof.responseSha256, proof.capturedAt, proof.appliedAt, proof.postedEntries, sealed.nonce, sealed.ciphertext, sealed.authenticationTag);
  return { sequence: proof.sequence, sourceSha256, postedEntries: proof.postedEntries, duplicate: false };
}

export function initializeLegacyCursor(db: DatabaseSync, cipher: RuntimeSecretCipher, initial: { tables: LegacyTables; columns: LegacyColumns; capturedAt: number; sourceOffsetMinutes: number }) {
  if (!db.isTransaction) throw new Error("legacy synchronization requires a transaction");
  verifyWechatMasterKeyGuard(db, cipher); validateLegacyTables(initial.tables);
  validateLegacyColumns(initial.tables, initial.columns);
  if (db.prepare("SELECT 1 FROM epay_legacy_sync_runs").get() || !Number.isSafeInteger(initial.capturedAt) || initial.capturedAt < 0 || !Number.isInteger(initial.sourceOffsetMinutes) || Math.abs(initial.sourceOffsetMinutes) > 840) throw new Error("legacy synchronization initial cursor is invalid");
  if (!db.prepare("SELECT 1 FROM epay_balance_openings WHERE opened_at=?").get(initial.capturedAt)) throw new Error("legacy synchronization cutoff differs from balance opening");
  for (const row of initial.tables.Order) {
    verifyLegacyOrder(db, row);
    const stored = db.prepare("SELECT * FROM epay_orders WHERE trade_no=?").get(String(row.tradeNo))!;
    const mapped = mappedLegacyRow("Order", row, initial.sourceOffsetMinutes);
    if (Object.entries(mapped).some(([key, value]) => typeof stored[key] === "bigint" ? value === null || BigInt(value as number) !== stored[key] : stored[key] !== value)) throw new Error("legacy synchronization initial target state differs");
  }
  const payload: Payload = { tables: initial.tables, columns: initial.columns, mainPayment: readCurrentMainPayment(db, cipher).payment, sourceOffsetMinutes: initial.sourceOffsetMinutes };
  return appendCursor(db, cipher, payload, { sequence: 1, previous: "0".repeat(64), capturedAt: initial.capturedAt, appliedAt: initial.capturedAt, responseSha256: digest(payload), postedEntries: 0 });
}

// Legacy callbacks stay with the old owner. This transaction only mirrors records and liabilities.
export function applyLegacyDelta(db: DatabaseSync, cipher: RuntimeSecretCipher, capture: Capture) {
  if (!db.isTransaction) throw new Error("legacy synchronization requires a transaction");
  if (![capture.capturedAt, capture.appliedAt].every(Number.isSafeInteger) || capture.capturedAt < 0 || capture.appliedAt < capture.capturedAt || capture.appliedAt - capture.capturedAt > MAX_APPLY_DELAY_MS || !/^[a-f0-9]{64}$/.test(capture.responseSha256)) throw new Error("legacy synchronization capture proof is invalid");
  const prior = readLegacyCursor(db, cipher);
  if (prior.sourceSha256 !== capture.expectedSha256) throw new Error("legacy synchronization cursor changed");
  if (capture.capturedAt < prior.capturedAt) throw new Error("legacy synchronization cutoff regressed");
  validateLegacyTables(capture.tables); validateLegacyColumns(capture.tables, capture.columns);
  if (canonicalSource(prior.columns) !== canonicalSource(capture.columns)) throw new Error("legacy synchronization source schema changed");
  const changes = planLegacyDelta(prior.tables, capture.tables);
  const payload: Payload = { tables: capture.tables, columns: capture.columns, mainPayment: readCurrentMainPayment(db, cipher).payment, sourceOffsetMinutes: prior.sourceOffsetMinutes };
  if (digest(payload) === prior.sourceSha256) return { sequence: prior.sequence, sourceSha256: prior.sourceSha256, postedEntries: 0, duplicate: true };
  const before = projectLegacyLiabilities(prior.tables, prior.mainPayment, prior.sourceOffsetMinutes);
  const after = projectLegacyLiabilities(payload.tables, payload.mainPayment, prior.sourceOffsetMinutes);
  db.exec("SAVEPOINT epay_legacy_delta");
  try {
    for (const change of changes) {
      const spec = legacyMappings[change.kind], mapped = mappedLegacyRow(change.kind, change.after, prior.sourceOffsetMinutes);
      if (change.kind === "Order") verifyLegacyOrder(db, change.after);
      if (change.before) {
        const previous = mappedLegacyRow(change.kind, change.before, prior.sourceOffsetMinutes);
        const stored = db.prepare(`SELECT * FROM ${spec.table} WHERE ${spec.key}=?`).get(change.id);
        if (!stored || Object.entries(previous).some(([key, value]) => typeof stored[key] === "bigint" ? BigInt(value as number) !== stored[key] : stored[key] !== value)) throw new Error("legacy synchronization target record diverged");
        const fields = Object.keys(mapped).filter(key => key !== spec.key);
        db.prepare(`UPDATE ${spec.table} SET ${fields.map(key => `${key}=?`).join(",")} WHERE ${spec.key}=?`).run(...fields.map(key => mapped[key]!), change.id);
      } else {
        const fields = Object.keys(mapped);
        db.prepare(`INSERT INTO ${spec.table}(${fields.join(",")}) VALUES(${fields.map(() => "?").join(",")})`).run(...fields.map(key => mapped[key] as SQLInputValue));
      }
    }
    const postings = before.map(merchant => {
      const next = after.find(row => row.mainMerchantId === merchant.mainMerchantId && row.mainApiId === merchant.mainApiId);
      const binding = db.prepare("SELECT epay_merchant_id FROM epay_merchant_bindings WHERE main_merchant_id=? AND main_api_id=?").get(merchant.mainMerchantId, merchant.mainApiId);
      if (!next || next.feeBps !== merchant.feeBps || !binding) throw new Error("legacy synchronization merchant fee or binding differs");
      const merchantId = Number(binding.epay_merchant_id);
      readLiveBalance(db, merchantId);
      return { merchantId, delta: safeCents(BigInt(next.project(merchantId)) - BigInt(merchant.project(merchantId))) };
    }).filter(posting => posting.delta !== 0);
    const run = appendCursor(db, cipher, payload, { sequence: prior.sequence + 1, previous: prior.sourceSha256, capturedAt: capture.capturedAt, appliedAt: capture.appliedAt, responseSha256: capture.responseSha256, postedEntries: postings.length });
    for (const posting of postings) {
      db.prepare(`INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,frozen_delta_cents,reason,occurred_at,source)
        VALUES(?,?,'legacy_synchronization',?,0,'旧支付系统订单与开票状态同步',?,'legacy_epay_delta')`)
        .run(`legacy-sync:${run.sequence}:${posting.merchantId}`, posting.merchantId, posting.delta, capture.capturedAt);
      readLiveBalance(db, posting.merchantId);
    }
    db.exec("RELEASE SAVEPOINT epay_legacy_delta");
    return run;
  } catch (error) {
    db.exec("ROLLBACK TO SAVEPOINT epay_legacy_delta; RELEASE SAVEPOINT epay_legacy_delta");
    throw error;
  }
}
