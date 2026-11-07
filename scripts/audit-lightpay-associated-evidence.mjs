import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

// Exact matches are investigation leads, not proof of a merchant's ownership.
export function auditAssociatedEvidence(payment, bridge) {
  if (!payment || !Array.isArray(payment.merchants) || !Array.isArray(payment.orders) || !Array.isArray(bridge.orders) || !Array.isArray(bridge.ledger)) throw new Error("missing payment or bridge records");
  const merchantIds = new Set(payment.merchants.map((merchant) => merchant.id));
  const orderIds = new Set(payment.orders.map((order) => order.id));
  if ([...merchantIds, ...orderIds].some((id) => typeof id !== "string" || !id) || merchantIds.size !== payment.merchants.length || orderIds.size !== payment.orders.length) throw new Error("invalid or duplicate main-site identifiers");
  const ledgerByOrder = new Map();
  for (const entry of bridge.ledger) {
    if (typeof entry.orderId !== "string" || !entry.orderId) continue;
    const list = ledgerByOrder.get(entry.orderId) ?? [];
    list.push(entry);
    ledgerByOrder.set(entry.orderId, list);
  }
  const counts = { unmatchedOrders: 0, withSite: 0, withSiteMerchant: 0, siteMatchesBridgeMerchant: 0, siteMerchantKnownMain: 0, withLedger: 0, ledgerMerchantMatchesBridge: 0, ledgerMerchantKnownMain: 0, withCallbackAttempts: 0, withProviderTradeNumber: 0 };
  const bridgeIds = new Set();
  for (const order of bridge.orders) {
    if (!order || typeof order.id !== "string" || !order.id || bridgeIds.has(order.id) || (order.merchantId !== null && typeof order.merchantId !== "string") || !Object.hasOwn(order, "siteId") || !Number.isSafeInteger(Number(order.callbackCount)) || Number(order.callbackCount) < 0) throw new Error("invalid bridge order");
    bridgeIds.add(order.id);
    if (orderIds.has(order.id) || (order.merchantId && merchantIds.has(order.merchantId))) continue;
    counts.unmatchedOrders++;
    if (order.siteId !== null) counts.withSite++;
    if (typeof order.siteMerchantId === "string" && order.siteMerchantId) {
      counts.withSiteMerchant++;
      if (order.siteMerchantId === order.merchantId) counts.siteMatchesBridgeMerchant++;
      if (merchantIds.has(order.siteMerchantId)) counts.siteMerchantKnownMain++;
    }
    const entries = ledgerByOrder.get(order.id) ?? [];
    if (entries.length) counts.withLedger++;
    if (entries.some((entry) => typeof entry.userId === "string" && entry.userId && entry.userId === order.merchantId)) counts.ledgerMerchantMatchesBridge++;
    if (entries.some((entry) => typeof entry.userId === "string" && merchantIds.has(entry.userId))) counts.ledgerMerchantKnownMain++;
    if (Number(order.callbackCount) > 0) counts.withCallbackAttempts++;
    if (typeof order.providerTradeNo === "string" && order.providerTradeNo.trim()) counts.withProviderTradeNumber++;
  }
  return { counts, snapshotsComparable: false, ownershipProven: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [databasePath, storePath] = process.argv.slice(2);
  if (!databasePath || !storePath) throw new Error("expected LightPay database and main-site store paths");
  const store = JSON.parse(readFileSync(storePath, "utf8"));
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const orders = db.prepare(`SELECT o.id,o.merchant_id AS merchantId,o.site_id AS siteId,s.merchant_id AS siteMerchantId,o.trade_no AS providerTradeNo,
      (SELECT count(*) FROM callback_attempts c WHERE c.order_id=o.id) AS callbackCount
      FROM orders o LEFT JOIN sites s ON s.id=o.site_id`).all();
    const ledger = db.prepare("SELECT l.order_id AS orderId,m.user_id AS userId FROM merchant_ledger l LEFT JOIN merchants m ON m.id=l.merchant_id").all();
    console.log(JSON.stringify(auditAssociatedEvidence(store.payment, { orders, ledger })));
  } finally { db.close(); }
}
