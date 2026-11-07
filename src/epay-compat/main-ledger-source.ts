import type { DatabaseSync } from "node:sqlite";
import type { RuntimeSecretCipher } from "../settings/crypto.ts";

export const EPAY_MAIN_LEDGER_SOURCE_SCHEMA_SQL = `
  CREATE TABLE epay_main_ledger_sources (
    entry_id TEXT PRIMARY KEY REFERENCES epay_balance_ledger(entry_id),
    cipher_version INTEGER NOT NULL CHECK(cipher_version=1),
    nonce BLOB NOT NULL CHECK(length(nonce)=12),
    ciphertext BLOB NOT NULL CHECK(length(ciphertext)>0),
    authentication_tag BLOB NOT NULL CHECK(length(authentication_tag)=16)
  ) STRICT;
  CREATE TABLE epay_main_ledger_import_runs (
    singleton_key INTEGER PRIMARY KEY CHECK(singleton_key=1),
    entry_count INTEGER NOT NULL CHECK(entry_count>=0)
  ) STRICT;
`;

function recordIdentity(db: DatabaseSync, entryId: string) {
  if (typeof entryId !== "string" || !entryId || entryId.length > 128) throw new Error("invalid main ledger source ID");
  const entry = db.prepare(`SELECT l.merchant_id,b.main_merchant_id,l.entry_type,l.available_delta_cents,l.frozen_delta_cents,l.reason,l.actor_id,l.occurred_at FROM epay_balance_ledger l
    JOIN epay_merchant_bindings b ON b.epay_merchant_id=l.merchant_id
    WHERE l.entry_id=? AND l.source='main_site'`).get(entryId) as { merchant_id: number | bigint; main_merchant_id: string; entry_type: string; available_delta_cents: number | bigint; frozen_delta_cents: number | bigint; reason: string | null; actor_id: string | null; occurred_at: number | bigint } | undefined;
  const merchantId = Number(entry?.merchant_id);
  if (!entry || !Number.isSafeInteger(merchantId) || merchantId < 1 || !entry.main_merchant_id) throw new Error("main ledger source binding is unavailable");
  const available = Number(entry.available_delta_cents), frozen = Number(entry.frozen_delta_cents), occurredAt = Number(entry.occurred_at);
  if (![available, frozen, occurredAt].every(Number.isSafeInteger)) throw new Error("invalid mapped main ledger values");
  return { merchantId, mainMerchantId: entry.main_merchant_id, name: `epay:ledger-source:${merchantId}:${entryId}` as const, type: entry.entry_type, available, frozen, reason: entry.reason, actor: entry.actor_id, occurredAt };
}

function verifySource(raw: string, entryId: string, identity: ReturnType<typeof recordIdentity>): void {
  let record: unknown;
  try { record = JSON.parse(raw); } catch { throw new Error("invalid main ledger source JSON"); }
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("main ledger source identity mismatch");
  const row = record as Record<string, unknown>;
  if (row.id !== entryId || row.merchantId !== identity.mainMerchantId) throw new Error("main ledger source identity mismatch");
  if (row.type !== identity.type || row.availableDelta !== identity.available || row.frozenDelta !== identity.frozen || (row.reason ?? null) !== identity.reason || (row.actorId ?? null) !== identity.actor || typeof row.at !== "string" || Date.parse(row.at) !== identity.occurredAt) throw new Error("main ledger source values mismatch");
}

export function writeEncryptedMainLedgerSource(db: DatabaseSync, cipher: RuntimeSecretCipher, entryId: string, raw: string): void {
  const identity = recordIdentity(db, entryId);
  verifySource(raw, entryId, identity);
  const sealed = cipher.encrypt(identity.name, 1, raw);
  db.prepare("INSERT INTO epay_main_ledger_sources(entry_id,cipher_version,nonce,ciphertext,authentication_tag) VALUES (?,1,?,?,?)")
    .run(entryId, sealed.nonce, sealed.ciphertext, sealed.authenticationTag);
}

export function readEncryptedMainLedgerSource(db: DatabaseSync, cipher: RuntimeSecretCipher, entryId: string): string | null {
  const identity = recordIdentity(db, entryId);
  const row = db.prepare("SELECT nonce,ciphertext,authentication_tag FROM epay_main_ledger_sources WHERE entry_id=?").get(entryId) as { nonce: Uint8Array; ciphertext: Uint8Array; authentication_tag: Uint8Array } | undefined;
  if (!row) return null;
  const plaintext = cipher.decrypt(identity.name, 1, { cipherVersion: 1, nonce: Buffer.from(row.nonce), ciphertext: Buffer.from(row.ciphertext), authenticationTag: Buffer.from(row.authentication_tag) });
  try {
    const raw = plaintext.toString("utf8");
    verifySource(raw, entryId, identity);
    return raw;
  } finally { plaintext.fill(0); }
}
