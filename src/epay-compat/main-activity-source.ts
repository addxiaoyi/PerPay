import type { DatabaseSync } from "node:sqlite";
import type { RuntimeSecretCipher } from "../settings/crypto.ts";
import { readEncryptedMainOrder } from "./main-order-source.ts";
import { verifyWechatMasterKeyGuard } from "./wechat-master-key.ts";

// Preserved records are historical evidence, not executable callback jobs.
export const EPAY_MAIN_ACTIVITY_SOURCE_SCHEMA_SQL = `
  CREATE TABLE epay_main_activity_sources (
    kind TEXT NOT NULL CHECK(kind IN ('settlements','callbacks','syncJobs')),
    source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 128),
    merchant_id INTEGER NOT NULL REFERENCES epay_merchant_accounts(merchant_id),
    order_id TEXT REFERENCES epay_main_order_sources(order_id),
    nonce BLOB NOT NULL CHECK(length(nonce)=12),
    ciphertext BLOB NOT NULL CHECK(length(ciphertext)>0),
    authentication_tag BLOB NOT NULL CHECK(length(authentication_tag)=16),
    PRIMARY KEY(kind,source_id)
  ) STRICT;
  CREATE TABLE epay_main_activity_import_runs (
    singleton_key INTEGER PRIMARY KEY CHECK(singleton_key=1),
    settlement_count INTEGER NOT NULL CHECK(settlement_count>=0),
    callback_count INTEGER NOT NULL CHECK(callback_count>=0),
    sync_job_count INTEGER NOT NULL CHECK(sync_job_count>=0)
  ) STRICT;
`;

type Kind = "settlements" | "callbacks" | "syncJobs";
const kinds: Kind[] = ["settlements", "callbacks", "syncJobs"];

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
}

function activityName(kind: Kind, id: string, merchantId: number): `epay:config:${string}` {
  return `epay:config:main-activity:${kind}:${merchantId}:${id}`;
}

export function readMainActivity(db: DatabaseSync, cipher: RuntimeSecretCipher, kind: Kind, id: string, scope?: { mainMerchantId: string; mainApiId: string; epayMerchantId: number }): string | null {
  if (!kinds.includes(kind) || !identifier(id)) throw new Error("invalid activity identity");
  const row = db.prepare(`SELECT s.*,b.main_merchant_id FROM epay_main_activity_sources s
    JOIN epay_merchant_bindings b ON b.epay_merchant_id=s.merchant_id
    JOIN epay_merchant_accounts m ON m.merchant_id=s.merchant_id
    WHERE s.kind=? AND s.source_id=? AND (? IS NULL OR (b.main_merchant_id=? AND b.main_api_id=? AND s.merchant_id=? AND m.enabled=1))`)
    .get(kind, id, scope?.mainMerchantId ?? null, scope?.mainMerchantId ?? null, scope?.mainApiId ?? null, scope?.epayMerchantId ?? null) as
    { merchant_id: bigint | number; main_merchant_id: string; order_id: string | null; nonce: Uint8Array; ciphertext: Uint8Array; authentication_tag: Uint8Array } | undefined;
  if (!row) return null;
  const merchantId = Number(row.merchant_id);
  if (!Number.isSafeInteger(merchantId) || merchantId < 1) throw new Error("invalid activity merchant");
  const plain = cipher.decrypt(activityName(kind, id, merchantId), 1, { cipherVersion: 1, nonce: Buffer.from(row.nonce), ciphertext: Buffer.from(row.ciphertext), authenticationTag: Buffer.from(row.authentication_tag) });
  try {
    const raw = plain.toString("utf8"), item: unknown = JSON.parse(raw);
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid activity source");
    const record = item as Record<string, unknown>;
    if (record.id !== id || ((kind !== "syncJobs" || record.merchantId != null) && record.merchantId !== row.main_merchant_id) || (kind !== "settlements" && record.orderId !== row.order_id) || (kind === "settlements" && row.order_id !== null)) throw new Error("activity source identity mismatch");
    return raw;
  } finally { plain.fill(0); }
}

export function preserveMainActivityInTransaction(db: DatabaseSync, cipher: RuntimeSecretCipher, payment: unknown) {
  if (!db.isTransaction) throw new Error("activity import requires a transaction");
  verifyWechatMasterKeyGuard(db, cipher);
  if (!payment || typeof payment !== "object" || Array.isArray(payment)) throw new Error("invalid activity source");
  const source = payment as Record<string, unknown>;
  if (!Array.isArray(source.merchants) || !Array.isArray(source.orders) || kinds.some(kind => !Array.isArray(source[kind]))) throw new Error("activity source is incomplete");
  const merchants = new Map<string, number>();
  for (const value of source.merchants) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid activity merchant");
    const row = value as Record<string, unknown>;
    if (!identifier(row.id) || !identifier(row.apiId) || merchants.has(row.id)) throw new Error("invalid activity merchant identity");
    const binding = db.prepare("SELECT epay_merchant_id FROM epay_merchant_bindings WHERE main_merchant_id=? AND main_api_id=?").get(row.id, row.apiId);
    const merchantId = Number(binding?.epay_merchant_id);
    if (!Number.isSafeInteger(merchantId) || merchantId < 1) throw new Error("activity merchant binding is unresolved");
    merchants.set(row.id, merchantId);
  }
  const orders = new Map<string, { mainMerchant: string; merchantId: number }>();
  for (const value of source.orders) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid activity order");
    const row = value as Record<string, unknown>;
    if (!identifier(row.id) || !identifier(row.merchantId) || orders.has(row.id)) throw new Error("invalid activity order identity");
    const merchantId = merchants.get(row.merchantId);
    const stored = db.prepare("SELECT merchant_id FROM epay_main_order_sources WHERE order_id=?").get(row.id);
    if (!merchantId || Number(stored?.merchant_id) !== merchantId || readEncryptedMainOrder(db, cipher, row.id) !== JSON.stringify(row)) throw new Error("activity order binding is unresolved");
    orders.set(row.id, { mainMerchant: row.merchantId, merchantId });
  }
  if (db.prepare("SELECT 1 FROM epay_main_activity_import_runs WHERE singleton_key=1").get() || db.prepare("SELECT 1 FROM epay_main_activity_sources LIMIT 1").get()) throw new Error("activity target is not empty or was already imported");
  db.exec("SAVEPOINT epay_main_activity_import");
  try {
    const counts = { settlements: 0, callbacks: 0, syncJobs: 0 };
    for (const kind of kinds) for (const value of source[kind] as unknown[]) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid activity record");
      const row = value as Record<string, unknown>;
      if (!identifier(row.id)) throw new Error("invalid activity record ID");
      const order = kind === "settlements" ? undefined : identifier(row.orderId) ? orders.get(row.orderId) : undefined;
      if (kind !== "settlements" && !order) throw new Error("activity order binding is unresolved");
      const merchantId = kind === "syncJobs" ? order!.merchantId : identifier(row.merchantId) ? merchants.get(row.merchantId) : undefined;
      if (!merchantId || (order && (merchantId !== order.merchantId || ((kind === "callbacks" || row.merchantId != null) && row.merchantId !== order.mainMerchant)))) throw new Error("activity merchant and order mismatch");
      const raw = JSON.stringify(row), sealed = cipher.encrypt(activityName(kind, row.id, merchantId), 1, raw);
      db.prepare("INSERT INTO epay_main_activity_sources VALUES(?,?,?,?,?,?,?)").run(kind, row.id, merchantId, order ? row.orderId as string : null, sealed.nonce, sealed.ciphertext, sealed.authenticationTag);
      if (readMainActivity(db, cipher, kind, row.id) !== raw) throw new Error("activity source verification failed");
      counts[kind]++;
    }
    db.prepare("INSERT INTO epay_main_activity_import_runs VALUES(1,?,?,?)").run(counts.settlements, counts.callbacks, counts.syncJobs);
    db.exec("RELEASE SAVEPOINT epay_main_activity_import");
    return { counts, replayEnabled: false as const, financiallyReconciled: false as const };
  } catch (error) {
    db.exec("ROLLBACK TO SAVEPOINT epay_main_activity_import");
    db.exec("RELEASE SAVEPOINT epay_main_activity_import");
    throw error;
  }
}
