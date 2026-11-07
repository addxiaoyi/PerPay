import { createHash } from "node:crypto";

type MainOrder = { id: string; merchantOrderId: string; amountCents: number; status: string; createdAt: number };
type GatewayOrder = { tradeNo: string; merchantOrderId: string; amountCents: number; receivedCents: number | null; paidAt: number | null; createdAt: number; status: string };
type InvoiceApplication = { id: string; feeCents: number; status: string };
export type LegacyBalanceInput = {
  mainAvailableCents: number;
  mainFrozenCents: number;
  feeBps: number;
  mainOrders: readonly MainOrder[];
  gatewayOrders: readonly GatewayOrder[];
  invoiceApplications: readonly InvoiceApplication[];
};

const MAIN_ORDER_WINDOW = 100;
const GATEWAY_PAID_WINDOW = 1000;
const CHARGED_INVOICE_STATUSES = new Set(["ISSUING", "ISSUED", "UNKNOWN"]);
const INVOICE_STATUSES = new Set(["PENDING", "ISSUING", "ISSUED", "UNKNOWN", "FAILED"]);

function integer(value: number, minimum = 0): bigint {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error("invalid legacy balance integer");
  return BigInt(value);
}

function safeNumber(value: bigint): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) throw new Error("legacy balance total exceeds safe integer range");
  return amount;
}

function uniqueIds(ids: readonly string[]): void {
  if (ids.some(id => !id || id.length > 150 || /[\x00-\x1f\x7f]/.test(id)) || new Set(ids).size !== ids.length) throw new Error("invalid or duplicate legacy balance record");
}

// Reproduces the existing dashboard for comparison; neither order matching nor
// its current-fee calculation authenticates a historical payment or settlement.
export function auditLegacyDashboardBalance(input: LegacyBalanceInput) {
  const mainAvailable = integer(input.mainAvailableCents, Number.MIN_SAFE_INTEGER);
  integer(input.mainFrozenCents, Number.MIN_SAFE_INTEGER);
  const feeBps = integer(input.feeBps);
  if (feeBps > 5000n) throw new Error("invalid legacy merchant fee");
  uniqueIds(input.mainOrders.map(order => order.id));
  uniqueIds(input.gatewayOrders.map(order => order.tradeNo));
  uniqueIds(input.invoiceApplications.map(invoice => invoice.id));
  for (const order of [...input.mainOrders, ...input.gatewayOrders]) {
    integer(order.amountCents);
    integer(order.createdAt);
    if (!order.merchantOrderId || !order.status) throw new Error("invalid legacy balance order");
  }
  for (const order of input.gatewayOrders) {
    if (order.receivedCents !== null) integer(order.receivedCents);
    if (order.paidAt !== null) integer(order.paidAt);
    if (!["PENDING", "PAID", "REFUNDED", "FROZEN", "CLOSED"].includes(order.status)) throw new Error("invalid legacy gateway order status");
  }
  for (const invoice of input.invoiceApplications) {
    integer(invoice.feeCents);
    if (!INVOICE_STATUSES.has(invoice.status)) throw new Error("invalid legacy invoice status");
  }

  const orderedMain = [...input.mainOrders].sort((left, right) => right.createdAt - left.createdAt);
  const paid = input.gatewayOrders.filter(order => order.status === "PAID").sort((left, right) => (right.paidAt ?? 0) - (left.paidAt ?? 0));
  const windowMain = orderedMain.slice(0, MAIN_ORDER_WINDOW);
  const windowPaid = paid.slice(0, GATEWAY_PAID_WINDOW);
  const allKnown = new Map<string, MainOrder[]>();
  for (const order of orderedMain) allKnown.set(order.merchantOrderId, [...(allKnown.get(order.merchantOrderId) ?? []), order]);
  const windowKnown = new Set(windowMain.map(order => order.merchantOrderId));
  let roundingDifferences = 0;
  const postings = paid.map(order => {
    const gross = integer(order.receivedCents ?? order.amountCents);
    const fee = (gross * feeBps + 5000n) / 10000n;
    const legacyFee = integer(Math.round(Number(gross) * (input.feeBps / 10000)));
    if (legacyFee !== fee) roundingDifferences++;
    return { tradeNo: order.tradeNo, grossCents: Number(gross), feeCents: Number(fee), legacyFeeCents: Number(legacyFee), netCents: safeNumber(gross - fee), mainMatch: allKnown.has(order.merchantOrderId) };
  });
  const byTrade = new Map(postings.map(posting => [posting.tradeNo, posting]));
  const legacyNet = windowPaid.filter(order => !windowKnown.has(order.merchantOrderId)).reduce((total, order) => {
    const posting = byTrade.get(order.tradeNo)!;
    return total + BigInt(posting.grossCents) - BigInt(posting.legacyFeeCents);
  }, 0n);
  const fullNet = postings.filter(posting => !posting.mainMatch).reduce((total, posting) => total + BigInt(posting.netCents), 0n);
  const invoiceFees = input.invoiceApplications.filter(invoice => CHARGED_INVOICE_STATUSES.has(invoice.status)).reduce((total, invoice) => total + BigInt(invoice.feeCents), 0n);
  const unmatched = paid.filter(order => !allKnown.has(order.merchantOrderId));
  const mismatched = paid.filter(order => {
    const main = allKnown.get(order.merchantOrderId);
    return main?.length === 1 && (main[0]!.amountCents !== order.amountCents || main[0]!.status.toUpperCase() !== "PAID");
  });
  const boundaryTies = (orders: readonly number[], limit: number) => orders.length > limit && orders[limit - 1] === orders[limit];
  const compareIds = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  const evidence = {
    mainOrders: [...input.mainOrders].sort((a, b) => compareIds(a.id, b.id)),
    gatewayOrders: [...input.gatewayOrders].sort((a, b) => compareIds(a.tradeNo, b.tradeNo)),
    invoiceApplications: [...input.invoiceApplications].sort((a, b) => compareIds(a.id, b.id)),
    mainAvailableCents: input.mainAvailableCents, mainFrozenCents: input.mainFrozenCents, feeBps: input.feeBps,
  };
  return {
    legacyAvailableCents: safeNumber(mainAvailable + legacyNet - invoiceFees),
    fullAvailableCents: safeNumber(mainAvailable + fullNet - invoiceFees),
    mainAvailableCents: input.mainAvailableCents, frozenCents: input.mainFrozenCents,
    gatewayNetCents: safeNumber(fullNet), invoiceFeesCents: safeNumber(invoiceFees),
    counts: { mainOrders: orderedMain.length, paidGatewayOrders: paid.length, independentlyProjectedOrders: unmatched.length, chargedInvoiceApplications: input.invoiceApplications.filter(invoice => CHARGED_INVOICE_STATUSES.has(invoice.status)).length },
    issues: {
      mainWindowTruncated: orderedMain.length > MAIN_ORDER_WINDOW,
      gatewayWindowTruncated: paid.length > GATEWAY_PAID_WINDOW,
      windowBoundaryAmbiguous: boundaryTies(orderedMain.map(order => order.createdAt), MAIN_ORDER_WINDOW) || boundaryTies(paid.map(order => order.paidAt ?? 0), GATEWAY_PAID_WINDOW),
      duplicateMainOrderNumbers: [...allKnown.values()].filter(orders => orders.length > 1).length,
      matchedOrderDifferences: mismatched.length,
      roundingDifferences,
    },
    evidenceSha256: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
    feeBasis: "current_merchant_fee" as const,
    financiallyReconciled: false as const,
  };
}
