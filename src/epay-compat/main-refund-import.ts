import type { DatabaseSync } from "node:sqlite";
import type { RuntimeSecretCipher } from "../settings/crypto.ts";
import { readEncryptedMainRefund, writeEncryptedMainRefund } from "./main-refund-source.ts";
import { verifyWechatMasterKeyGuard } from "./wechat-master-key.ts";

// Source provenance, financial reconciliation and the migration cutoff are separate gates.
export function importMainRefundsInTransaction(db: DatabaseSync, cipher: RuntimeSecretCipher, payment: unknown): number {
  if (!db.isTransaction) throw new Error("main refund import requires a transaction");
  verifyWechatMasterKeyGuard(db, cipher);
  if (!payment || typeof payment !== "object" || Array.isArray(payment)) throw new Error("invalid main refund source");
  const source = payment as Record<string, unknown>;
  if (!Array.isArray(source.merchants) || !Array.isArray(source.orders) || !Array.isArray(source.refunds)) throw new Error("main refund source is incomplete");
  const merchants = new Set<string>();
  for (const value of source.merchants) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid main refund merchant");
    const row = value as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id || merchants.has(row.id) || typeof row.apiId !== "string" || !row.apiId) throw new Error("invalid or duplicate main refund merchant");
    if (!db.prepare("SELECT 1 FROM epay_merchant_bindings WHERE main_merchant_id=? AND main_api_id=?").get(row.id, row.apiId)) throw new Error("main refund merchant binding is unresolved");
    merchants.add(row.id);
  }
  const orders = new Map<string, { merchantId: string; amountCents: number }>();
  for (const value of source.orders) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid main refund order");
    const row = value as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id || orders.has(row.id) || typeof row.merchantId !== "string" || !merchants.has(row.merchantId) || !Number.isSafeInteger(row.amountCents) || Number(row.amountCents) <= 0) throw new Error("invalid or duplicate main refund order");
    orders.set(row.id, { merchantId: row.merchantId, amountCents: Number(row.amountCents) });
  }
  const existing = db.prepare("SELECT count(*) AS count FROM epay_main_refund_sources").get();
  if (!existing || Number(existing.count) !== 0 || db.prepare("SELECT 1 FROM epay_main_refund_import_runs WHERE singleton_key=1").get()) throw new Error("main refund target is not empty or was already imported");
  db.exec("SAVEPOINT epay_main_refund_import");
  try {
    for (const value of source.refunds) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid main refund record");
      const row = value as Record<string, unknown>;
      if (typeof row.id !== "string" || !row.id || typeof row.merchantId !== "string" || !merchants.has(row.merchantId) || !Number.isSafeInteger(row.amountCents) || Number(row.amountCents) <= 0) throw new Error("invalid main refund record");
      if (row.orderId != null) {
        if (typeof row.orderId !== "string" || !row.orderId) throw new Error("invalid main refund order reference");
        const order = orders.get(row.orderId);
        if (!order || order.merchantId !== row.merchantId || Number(row.amountCents) > order.amountCents) throw new Error("main refund order link is inconsistent");
      }
      const raw = JSON.stringify(row);
      if (typeof raw !== "string") throw new Error("invalid main refund source record");
      writeEncryptedMainRefund(db, cipher, raw);
      if (readEncryptedMainRefund(db, cipher, row.id) !== raw) throw new Error("main refund source verification failed");
    }
    const count = db.prepare("SELECT count(*) AS count FROM epay_main_refund_sources").get();
    if (!count || Number(count.count) !== source.refunds.length) throw new Error("main refund import count mismatch");
    db.prepare("INSERT INTO epay_main_refund_import_runs VALUES(1,?)").run(source.refunds.length);
    db.exec("RELEASE SAVEPOINT epay_main_refund_import");
    return source.refunds.length;
  } catch (error) {
    db.exec("ROLLBACK TO SAVEPOINT epay_main_refund_import");
    db.exec("RELEASE SAVEPOINT epay_main_refund_import");
    throw error;
  }
}
