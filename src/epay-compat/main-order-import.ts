import type { DatabaseSync } from "node:sqlite";
import type { RuntimeSecretCipher } from "../settings/crypto.ts";
import { auditMainLedger } from "./main-ledger-audit.ts";
import { auditMainPayments } from "./main-payment-audit.ts";
import { readEncryptedMainOrder, writeEncryptedMainOrder } from "./main-order-source.ts";
import { verifyWechatMasterKeyGuard } from "./wechat-master-key.ts";
import { importMainRefundsInTransaction } from "./main-refund-import.ts";

// The caller owns the transaction and must separately establish snapshot provenance and cutoff.
export function importMainOrdersInTransaction(db: DatabaseSync, cipher: RuntimeSecretCipher, payment: unknown): number {
  return importMainOrders(db, cipher, payment, false);
}

export function preserveMainOrdersAndRefundsInTransaction(db: DatabaseSync, cipher: RuntimeSecretCipher, payment: unknown) {
  if (!db.isTransaction) throw new Error("main order and refund preservation requires a transaction");
  db.exec("SAVEPOINT epay_main_orders_and_refunds");
  try {
    const orders = importMainOrders(db, cipher, payment, true);
    const refunds = importMainRefundsInTransaction(db, cipher, payment);
    db.exec("RELEASE SAVEPOINT epay_main_orders_and_refunds");
    return { orders, refunds, financiallyReconciled: false as const };
  } catch (error) {
    db.exec("ROLLBACK TO SAVEPOINT epay_main_orders_and_refunds");
    db.exec("RELEASE SAVEPOINT epay_main_orders_and_refunds");
    throw error;
  }
}

function importMainOrders(db: DatabaseSync, cipher: RuntimeSecretCipher, payment: unknown, preserveRefunds: boolean): number {
  if (!db.isTransaction) throw new Error("main order import requires a transaction");
  verifyWechatMasterKeyGuard(db, cipher);
  const ledger = auditMainLedger(payment);
  if (ledger.missingMerchantReferences || ledger.unsupportedFeePrecision || ledger.summaryMismatches !== 0) throw new Error("main ledger is not suitable for import");
  const postings = auditMainPayments(payment);
  if (postings.missingOrderMerchantReferences !== 0 || postings.unknownOrderStatuses || postings.unpaidWithPaidAt || postings.paidWithInvalidPaidAt || postings.refundRecordsRequireReconciliation === null || (!preserveRefunds && (postings.refundOrdersRequireReconciliation || postings.refundRecordsRequireReconciliation)) || postings.invalidOrderAmounts || postings.orderAmountMismatches || postings.missingOrderReference || postings.orphanOrderReference || postings.paidWithoutLedger || postings.duplicateLedger || postings.merchantMismatch || postings.invalidAmounts || postings.amountMismatch || postings.ledgerForNonPaid) throw new Error("main payment order and ledger links are inconsistent");
  const source = payment as { merchants: Array<{ id: string; apiId?: unknown }>; orders: Array<Record<string, unknown>> };
  for (const merchant of source.merchants) {
    if (typeof merchant.apiId !== "string" || !merchant.apiId) throw new Error("main order merchant API identity is unavailable");
    const binding = db.prepare("SELECT 1 FROM epay_merchant_bindings WHERE main_merchant_id=? AND main_api_id=?").get(merchant.id, merchant.apiId);
    if (!binding) throw new Error("main order merchant binding is unresolved");
  }
  const existing = db.prepare("SELECT count(*) AS count FROM epay_main_order_sources").get();
  const prior = db.prepare("SELECT 1 FROM epay_main_order_import_runs WHERE singleton_key=1").get();
  if (!existing || Number(existing.count) !== 0 || prior) throw new Error("main order target is not empty or was already imported");
  db.exec("SAVEPOINT epay_main_order_import");
  try {
    for (const order of source.orders) {
      const raw = JSON.stringify(order);
      if (typeof raw !== "string" || typeof order.id !== "string") throw new Error("invalid main order source record");
      writeEncryptedMainOrder(db, cipher, raw);
      if (readEncryptedMainOrder(db, cipher, order.id) !== raw) throw new Error("main order source verification failed");
    }
    const count = db.prepare("SELECT count(*) AS count FROM epay_main_order_sources").get();
    if (!count || Number(count.count) !== source.orders.length) throw new Error("main order import count mismatch");
    db.prepare("INSERT INTO epay_main_order_import_runs(singleton_key,order_count) VALUES(1,?)").run(source.orders.length);
    db.exec("RELEASE SAVEPOINT epay_main_order_import");
    return source.orders.length;
  } catch (error) {
    db.exec("ROLLBACK TO SAVEPOINT epay_main_order_import");
    db.exec("RELEASE SAVEPOINT epay_main_order_import");
    throw error;
  }
}
