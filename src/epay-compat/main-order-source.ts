import type { DatabaseSync } from "node:sqlite";
import type { RuntimeSecretCipher } from "../settings/crypto.ts";

export const EPAY_MAIN_ORDER_SOURCE_SCHEMA_SQL = `
  CREATE TABLE epay_main_order_sources (
    order_id TEXT PRIMARY KEY CHECK(length(order_id) BETWEEN 1 AND 128),
    merchant_id INTEGER NOT NULL REFERENCES epay_merchant_accounts(merchant_id),
    merchant_order_id TEXT NOT NULL CHECK(length(merchant_order_id) BETWEEN 1 AND 128),
    amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
    status TEXT NOT NULL CHECK(length(status) BETWEEN 1 AND 64),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    nonce BLOB NOT NULL CHECK(length(nonce)=12),
    ciphertext BLOB NOT NULL CHECK(length(ciphertext)>0),
    authentication_tag BLOB NOT NULL CHECK(length(authentication_tag)=16)
  ) STRICT;
  CREATE INDEX epay_main_orders_merchant_time_idx ON epay_main_order_sources(merchant_id,created_at DESC,order_id DESC);
  CREATE TABLE epay_main_order_import_runs (
    singleton_key INTEGER PRIMARY KEY CHECK(singleton_key=1),
    order_count INTEGER NOT NULL CHECK(order_count>=0)
  ) STRICT;
`;

type Order = { id: string; merchantId: string; merchantOrderId: string; amountCents: number; status: string; createdAt: string };

function parseOrder(raw: string): Order & { createdMillis: number } {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("invalid main order source JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid main order source");
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id || row.id.length > 128 || typeof row.merchantId !== "string" || !row.merchantId || typeof row.merchantOrderId !== "string" || !row.merchantOrderId || row.merchantOrderId.length > 128 || typeof row.status !== "string" || !row.status || row.status.length > 64 || !Number.isSafeInteger(row.amountCents) || Number(row.amountCents) < 0 || typeof row.createdAt !== "string") throw new Error("invalid main order fields");
  const parts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?(?:Z|([+-])(\d\d):(\d\d))$/.exec(row.createdAt);
  if (!parts) throw new Error("invalid main order timestamp");
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  const createdMillis = Date.parse(row.createdAt);
  if (year < 1970 || month < 1 || month > 12 || day < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59 || Number(parts[8] ?? 0) > 23 || Number(parts[9] ?? 0) > 59 || !Number.isSafeInteger(createdMillis) || createdMillis < 0) throw new Error("invalid main order timestamp");
  return { id: row.id, merchantId: row.merchantId, merchantOrderId: row.merchantOrderId, amountCents: Number(row.amountCents), status: row.status, createdAt: row.createdAt, createdMillis };
}

export function writeEncryptedMainOrder(db: DatabaseSync, cipher: RuntimeSecretCipher, raw: string): void {
  const order = parseOrder(raw);
  const binding = db.prepare("SELECT epay_merchant_id FROM epay_merchant_bindings WHERE main_merchant_id=?").get(order.merchantId);
  const merchantId = Number(binding?.epay_merchant_id);
  if (!Number.isSafeInteger(merchantId) || merchantId < 1) throw new Error("main order merchant binding is unresolved");
  const sealed = cipher.encrypt(`epay:order-source:${merchantId}:${order.id}`, 1, raw);
  db.prepare("INSERT INTO epay_main_order_sources VALUES (?,?,?,?,?,?,?,?,?)").run(order.id, merchantId, order.merchantOrderId, order.amountCents, order.status, order.createdMillis, sealed.nonce, sealed.ciphertext, sealed.authenticationTag);
}

export function readEncryptedMainOrder(db: DatabaseSync, cipher: RuntimeSecretCipher, orderId: string, scope?: { mainMerchantId: string; mainApiId: string; epayMerchantId: number }): string | null {
  const row = db.prepare(`SELECT o.*,b.main_merchant_id FROM epay_main_order_sources o JOIN epay_merchant_bindings b ON b.epay_merchant_id=o.merchant_id
    JOIN epay_merchant_accounts m ON m.merchant_id=o.merchant_id
    WHERE o.order_id=? AND (? IS NULL OR (b.main_merchant_id=? AND b.main_api_id=? AND o.merchant_id=? AND m.enabled=1))`)
    .get(orderId, scope?.mainMerchantId ?? null, scope?.mainMerchantId ?? null, scope?.mainApiId ?? null, scope?.epayMerchantId ?? null) as { merchant_id: number | bigint; main_merchant_id: string; merchant_order_id: string; amount_cents: number | bigint; status: string; created_at: number | bigint; nonce: Uint8Array; ciphertext: Uint8Array; authentication_tag: Uint8Array } | undefined;
  if (!row) return null;
  const merchantId = Number(row.merchant_id);
  if (!Number.isSafeInteger(merchantId) || merchantId < 1) throw new Error("invalid main order merchant");
  const plain = cipher.decrypt(`epay:order-source:${merchantId}:${orderId}`, 1, { cipherVersion: 1, nonce: Buffer.from(row.nonce), ciphertext: Buffer.from(row.ciphertext), authenticationTag: Buffer.from(row.authentication_tag) });
  try {
    const raw = plain.toString("utf8"), order = parseOrder(raw);
    if (order.id !== orderId || order.merchantId !== row.main_merchant_id || order.merchantOrderId !== row.merchant_order_id || order.amountCents !== Number(row.amount_cents) || order.status !== row.status || order.createdMillis !== Number(row.created_at)) throw new Error("main order source values mismatch");
    return raw;
  } finally { plain.fill(0); }
}
