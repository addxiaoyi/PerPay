function merchantId(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid merchant identifier");
  return value;
}

function orderId(value) {
  if (typeof value !== "string" || !value) throw new Error("invalid order identifier");
  return value;
}

export function summarizeUnboundOrders(tables) {
  const bound = new Set();
  for (const row of tables.MerchantBinding) {
    const id = merchantId(row.epayMerchantId);
    if (bound.has(id)) throw new Error("duplicate merchant binding");
    bound.add(id);
  }
  const allOrders = new Map();
  const unbound = new Map();
  const statuses = { PENDING: 0, PAID: 0, CLOSED: 0, other: 0 };
  let withProviderReference = 0;
  for (const row of tables.Order) {
    const id = orderId(row.tradeNo);
    if (allOrders.has(id)) throw new Error("duplicate order identifier");
    const merchant = merchantId(row.merchantId);
    allOrders.set(id, merchant);
    if (bound.has(merchant)) continue;
    unbound.set(id, merchant);
    const status = Object.hasOwn(statuses, row.status) && row.status !== "other" ? row.status : "other";
    statuses[status]++;
    if (typeof row.apiTradeNo === "string" && row.apiTradeNo.trim()) withProviderReference++;
  }
  let notifications = 0;
  for (const row of tables.NotifyLog) {
    if (unbound.has(orderId(row.tradeNo))) notifications++;
  }
  const invoices = { rows: 0, matchingOrder: 0, missingOrder: 0, merchantMismatch: 0 };
  const applications = { rows: 0, matchingOrder: 0, missingOrder: 0, merchantMismatch: 0 };
  for (const [rows, counts] of [[tables.Invoice, invoices], [tables.InvoiceApplication, applications]]) {
    for (const row of rows) {
      const merchant = merchantId(row.merchantId);
      if (bound.has(merchant)) continue;
      counts.rows++;
      const linkedMerchant = allOrders.get(orderId(row.tradeNo));
      if (linkedMerchant === undefined) counts.missingOrder++;
      else if (linkedMerchant !== merchant) counts.merchantMismatch++;
      else counts.matchingOrder++;
    }
  }
  return { orders: unbound.size, statuses, withProviderReference, notifications, invoices, applications, ownershipProven: false, providerVerified: false };
}
