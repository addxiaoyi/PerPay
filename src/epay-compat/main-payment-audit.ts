interface PaymentOrder {
  id: string;
  merchantId: string;
  status: string;
  amountCents: number;
  platformFeeCents: number;
  merchantNetCents: number;
  paidAt?: unknown;
  refundStatus?: unknown;
}

interface LedgerEntry {
  id: string;
  merchantId: string;
  type: string;
  orderId?: string;
  availableDelta: number;
  frozenDelta: number;
  grossCents?: number;
  platformFeeCents?: number;
  merchantNetCents?: number;
}

const ORDER_STATUSES = new Set(["pending_sync", "pending_payment", "failed", "closed", "expired", "paid", "refund_processing", "refunded"]);
const PAID_STATUSES = new Set(["paid", "refund_processing", "refunded"]);

function cents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function validPaidAt(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const parts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?(?:Z|([+-])(\d\d):(\d\d))$/.exec(value);
  if (!parts) return false;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 1970 && month >= 1 && month <= 12 && day >= 1 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && hour <= 23 && minute <= 59 && second <= 59 && Number(parts[8] ?? 0) <= 23 && Number(parts[9] ?? 0) <= 59 && Number.isSafeInteger(Date.parse(value)) && Date.parse(value) >= 0;
}

// Reports inconsistencies only; no order is assigned or modified.
export function auditMainPayments(payment: unknown) {
  if (!payment || typeof payment !== "object" || Array.isArray(payment)) throw new Error("main payment store is invalid");
  const store = payment as Record<string, unknown>;
  if (!Array.isArray(store.orders) || !Array.isArray(store.ledger)) throw new Error("main payment store is missing orders or ledger");
  if (Object.hasOwn(store, "refunds") && !Array.isArray(store.refunds)) throw new Error("main payment refunds are invalid");
  const refundRecordsRequireReconciliation = Array.isArray(store.refunds) ? store.refunds.length : null;
  let merchantIds: Set<string> | null = null;
  if (Object.hasOwn(store, "merchants")) {
    if (!Array.isArray(store.merchants)) throw new Error("main payment merchants are invalid");
    merchantIds = new Set<string>();
    for (const merchant of store.merchants) {
      if (!merchant || typeof merchant.id !== "string" || !merchant.id || merchantIds.has(merchant.id)) throw new Error("invalid or duplicate main merchant");
      merchantIds.add(merchant.id);
    }
  }
  const orders = new Map<string, PaymentOrder>();
  let missingOrderMerchantReferences = 0;
  let unknownOrderStatuses = 0;
  let unpaidWithPaidAt = 0;
  let paidWithInvalidPaidAt = 0;
  let refundOrdersRequireReconciliation = 0;
  let invalidOrderAmounts = 0;
  let orderAmountMismatches = 0;
  for (const order of store.orders as PaymentOrder[]) {
    if (!order || typeof order.id !== "string" || !order.id || orders.has(order.id) || typeof order.merchantId !== "string" || !order.merchantId || typeof order.status !== "string" || !order.status) throw new Error("invalid or duplicate main order");
    if (merchantIds && !merchantIds.has(order.merchantId)) missingOrderMerchantReferences++;
    if (!ORDER_STATUSES.has(order.status)) unknownOrderStatuses++;
    if (ORDER_STATUSES.has(order.status) && !PAID_STATUSES.has(order.status) && order.paidAt != null && order.paidAt !== "") unpaidWithPaidAt++;
    if (PAID_STATUSES.has(order.status) && !validPaidAt(order.paidAt)) paidWithInvalidPaidAt++;
    if (order.status === "refund_processing" || order.status === "refunded" || (order.refundStatus != null && order.refundStatus !== "")) refundOrdersRequireReconciliation++;
    if (![order.amountCents, order.platformFeeCents, order.merchantNetCents].every(cents) || order.amountCents <= 0 || order.platformFeeCents < 0 || order.merchantNetCents < 0) invalidOrderAmounts++;
    else if (order.amountCents - order.platformFeeCents !== order.merchantNetCents) orderAmountMismatches++;
    orders.set(order.id, order);
  }
  const entries = new Map<string, LedgerEntry[]>();
  const ids = new Set<string>();
  let missingOrderReference = 0;
  let orphanOrderReference = 0;
  for (const entry of store.ledger as LedgerEntry[]) {
    if (!entry || typeof entry.id !== "string" || !entry.id || ids.has(entry.id)) throw new Error("invalid or duplicate main ledger entry");
    ids.add(entry.id);
    if (entry.type !== "payment_paid") continue;
    if (typeof entry.orderId !== "string" || !entry.orderId) { missingOrderReference++; continue; }
    if (!orders.has(entry.orderId)) { orphanOrderReference++; continue; }
    const group = entries.get(entry.orderId) ?? [];
    group.push(entry);
    entries.set(entry.orderId, group);
  }
  let paidWithoutLedger = 0;
  let duplicateLedger = 0;
  let merchantMismatch = 0;
  let invalidAmounts = 0;
  let amountMismatch = 0;
  let ledgerForNonPaid = 0;
  for (const order of orders.values()) {
    const group = entries.get(order.id) ?? [];
    if (["paid", "refunded", "refund_processing"].includes(order.status) && group.length === 0) paidWithoutLedger++;
    if (group.length > 1) duplicateLedger++;
    // Refund state is separate from the original paid ledger posting.
    if (group.length && !["paid", "refunded", "refund_processing"].includes(order.status)) ledgerForNonPaid++;
    for (const entry of group) {
      if (entry.merchantId !== order.merchantId) merchantMismatch++;
      const amounts = [order.amountCents, order.platformFeeCents, order.merchantNetCents, entry.availableDelta, entry.frozenDelta, entry.grossCents, entry.platformFeeCents, entry.merchantNetCents];
      if (!amounts.every(cents) || order.amountCents <= 0 || order.platformFeeCents < 0 || order.merchantNetCents < 0) { invalidAmounts++; continue; }
      if (order.amountCents - order.platformFeeCents !== order.merchantNetCents || entry.grossCents !== order.amountCents || entry.platformFeeCents !== order.platformFeeCents || entry.merchantNetCents !== order.merchantNetCents || entry.availableDelta !== order.merchantNetCents || entry.frozenDelta !== 0) amountMismatch++;
    }
  }
  return { orderCount: orders.size, missingOrderMerchantReferences: merchantIds ? missingOrderMerchantReferences : null, unknownOrderStatuses, unpaidWithPaidAt, paidWithInvalidPaidAt, refundOrdersRequireReconciliation, refundRecordsRequireReconciliation, invalidOrderAmounts, orderAmountMismatches, paymentLedgerCount: [...entries.values()].reduce((count, group) => count + group.length, 0) + missingOrderReference + orphanOrderReference, missingOrderReference, orphanOrderReference, paidWithoutLedger, duplicateLedger, merchantMismatch, invalidAmounts, amountMismatch, ledgerForNonPaid, financiallyReconciled: false as const };
}
