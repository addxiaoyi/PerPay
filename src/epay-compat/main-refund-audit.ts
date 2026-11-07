type Refund = { id: string; merchantId: string; amountCents: number; status: string; orderId?: string | null };
type Entry = { id: string; type: string; refundId?: unknown; merchantId: unknown; availableDelta: unknown; frozenDelta: unknown };

// This checks local manual postings only; it does not authenticate channel refunds.
export function auditMainRefunds(payment: unknown) {
  if (!payment || typeof payment !== "object" || Array.isArray(payment)) throw new Error("invalid main refund source");
  const source = payment as Record<string, unknown>;
  if (!Array.isArray(source.refunds) || !Array.isArray(source.ledger)) throw new Error("main refund source is incomplete");
  if (Object.hasOwn(source, "orders") && !Array.isArray(source.orders)) throw new Error("main refund orders are invalid");
  const orders = Array.isArray(source.orders) ? new Map<string, { merchantId: string; amountCents: number }>() : null;
  for (const value of Array.isArray(source.orders) ? source.orders : []) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid main refund order");
    const row = value as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id || orders!.has(row.id) || typeof row.merchantId !== "string" || !row.merchantId || !Number.isSafeInteger(row.amountCents) || Number(row.amountCents) <= 0) throw new Error("invalid or duplicate main refund order");
    orders!.set(row.id, { merchantId: row.merchantId, amountCents: Number(row.amountCents) });
  }
  const refunds = new Map<string, Refund>();
  for (const value of source.refunds) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid main refund record");
    const row = value as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id || refunds.has(row.id) || typeof row.merchantId !== "string" || !row.merchantId || !Number.isSafeInteger(row.amountCents) || Number(row.amountCents) <= 0 || typeof row.status !== "string" || !row.status) throw new Error("invalid or duplicate main refund record");
    if (row.orderId != null && (typeof row.orderId !== "string" || !row.orderId)) throw new Error("invalid main refund order reference");
    refunds.set(row.id, { id: row.id, merchantId: row.merchantId, amountCents: Number(row.amountCents), status: row.status, orderId: typeof row.orderId === "string" ? row.orderId : null });
  }
  const groups = new Map<string, Entry[]>(), ids = new Set<string>();
  let missingRefundReferences = 0, orphanRefundReferences = 0;
  for (const value of source.ledger) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid main refund ledger record");
    const entry = value as Entry;
    if (typeof entry.id !== "string" || !entry.id || ids.has(entry.id)) throw new Error("invalid or duplicate main refund ledger ID");
    ids.add(entry.id);
    if (entry.type !== "manual_refund") continue;
    if (typeof entry.refundId !== "string" || !entry.refundId) { missingRefundReferences++; continue; }
    if (!refunds.has(entry.refundId)) { orphanRefundReferences++; continue; }
    const group = groups.get(entry.refundId) ?? [];
    group.push(entry);
    groups.set(entry.refundId, group);
  }
  let missingManualPostings = 0, duplicateManualPostings = 0, unexpectedManualPostings = 0, mismatchedManualPostings = 0;
  let missingOrderReferences = 0, orderMerchantMismatches = 0, oversizedRecordedRefundOrders = 0, unlinkedManualRefunds = 0;
  const recordedByOrder = new Map<string, bigint>();
  for (const refund of refunds.values()) {
    if (!refund.orderId) unlinkedManualRefunds++;
    const entries = groups.get(refund.id) ?? [];
    if (refund.status === "recorded" && entries.length === 0) missingManualPostings++;
    if (entries.length > 1) duplicateManualPostings++;
    if (refund.status !== "recorded" && entries.length) unexpectedManualPostings++;
    if (orders && refund.orderId) {
      const order = orders.get(refund.orderId);
      if (!order) missingOrderReferences++;
      else if (order.merchantId !== refund.merchantId) orderMerchantMismatches++;
      else if (refund.status === "recorded") recordedByOrder.set(refund.orderId, (recordedByOrder.get(refund.orderId) ?? 0n) + BigInt(refund.amountCents));
    }
    for (const entry of entries) {
      if (entry.merchantId !== refund.merchantId || entry.availableDelta !== -refund.amountCents || entry.frozenDelta !== 0) mismatchedManualPostings++;
    }
  }
  if (orders) for (const [orderId, total] of recordedByOrder) if (total > BigInt(orders.get(orderId)!.amountCents)) oversizedRecordedRefundOrders++;
  return { refundCount: refunds.size, unlinkedManualRefunds, missingRefundReferences, orphanRefundReferences, missingManualPostings, duplicateManualPostings, unexpectedManualPostings, mismatchedManualPostings, missingOrderReferences: orders ? missingOrderReferences : null, orderMerchantMismatches: orders ? orderMerchantMismatches : null, oversizedRecordedRefundOrders: orders ? oversizedRecordedRefundOrders : null, channelRefundsVerified: false as const, financiallyReconciled: false as const };
}
