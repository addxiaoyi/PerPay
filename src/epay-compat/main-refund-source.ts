import type { DatabaseSync } from "node:sqlite";
import type { RuntimeSecretCipher } from "../settings/crypto.ts";

export const EPAY_MAIN_REFUND_SOURCE_SCHEMA_SQL = `
  CREATE TABLE epay_main_refund_sources (
    refund_id TEXT PRIMARY KEY CHECK(length(refund_id) BETWEEN 1 AND 128),
    merchant_id INTEGER NOT NULL REFERENCES epay_merchant_accounts(merchant_id),
    nonce BLOB NOT NULL CHECK(length(nonce)=12),
    ciphertext BLOB NOT NULL CHECK(length(ciphertext)>0),
    authentication_tag BLOB NOT NULL CHECK(length(authentication_tag)=16)
  ) STRICT;
  CREATE TABLE epay_main_refund_import_runs (
    singleton_key INTEGER PRIMARY KEY CHECK(singleton_key=1),
    refund_count INTEGER NOT NULL CHECK(refund_count>=0)
  ) STRICT;
`;

function parseRefund(raw: string): { id: string; merchantId: string; orderId: string | null; amountCents: number; status: string } {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("invalid main refund source JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid main refund source");
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id || row.id.length > 128 || typeof row.merchantId !== "string" || !row.merchantId || row.merchantId.length > 128 ||
    (row.orderId != null && (typeof row.orderId !== "string" || !row.orderId || row.orderId.length > 128)) ||
    !Number.isSafeInteger(row.amountCents) || Number(row.amountCents) <= 0 || typeof row.status !== "string" || !row.status || row.status.length > 64) {
    throw new Error("invalid main refund fields");
  }
  return { id: row.id, merchantId: row.merchantId, orderId: row.orderId == null ? null : row.orderId as string, amountCents: Number(row.amountCents), status: row.status };
}

export function writeEncryptedMainRefund(db: DatabaseSync, cipher: RuntimeSecretCipher, raw: string): void {
  const refund = parseRefund(raw);
  const binding = db.prepare("SELECT epay_merchant_id FROM epay_merchant_bindings WHERE main_merchant_id=?").get(refund.merchantId);
  const merchantId = Number(binding?.epay_merchant_id);
  if (!Number.isSafeInteger(merchantId) || merchantId < 1) throw new Error("main refund merchant binding is unresolved");
  const sealed = cipher.encrypt(`epay:refund-source:${merchantId}:${refund.id}`, 1, raw);
  db.prepare("INSERT INTO epay_main_refund_sources VALUES (?,?,?,?,?)").run(refund.id, merchantId, sealed.nonce, sealed.ciphertext, sealed.authenticationTag);
}

export function readEncryptedMainRefund(db: DatabaseSync, cipher: RuntimeSecretCipher, refundId: string, scope?: { mainMerchantId: string; mainApiId: string; epayMerchantId: number }): string | null {
  const row = db.prepare(`SELECT r.*, b.main_merchant_id FROM epay_main_refund_sources r
    JOIN epay_merchant_bindings b ON b.epay_merchant_id=r.merchant_id
    JOIN epay_merchant_accounts m ON m.merchant_id=r.merchant_id
    WHERE r.refund_id=? AND (? IS NULL OR (b.main_merchant_id=? AND b.main_api_id=? AND r.merchant_id=? AND m.enabled=1))`)
    .get(refundId, scope?.mainMerchantId ?? null, scope?.mainMerchantId ?? null, scope?.mainApiId ?? null, scope?.epayMerchantId ?? null) as { merchant_id: number | bigint; main_merchant_id: string; nonce: Uint8Array; ciphertext: Uint8Array; authentication_tag: Uint8Array } | undefined;
  if (!row) return null;
  const merchantId = Number(row.merchant_id);
  if (!Number.isSafeInteger(merchantId) || merchantId < 1) throw new Error("invalid main refund merchant");
  const plain = cipher.decrypt(`epay:refund-source:${merchantId}:${refundId}`, 1, { cipherVersion: 1, nonce: Buffer.from(row.nonce), ciphertext: Buffer.from(row.ciphertext), authenticationTag: Buffer.from(row.authentication_tag) });
  try {
    const raw = plain.toString("utf8"), refund = parseRefund(raw);
    if (refund.id !== refundId || refund.merchantId !== row.main_merchant_id) throw new Error("main refund source values mismatch");
    return raw;
  } finally { plain.fill(0); }
}
