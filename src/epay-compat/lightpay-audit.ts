import { parseLegacyCents } from "./money.ts";

interface MainMerchant { readonly id: string }
interface MainOrder { readonly id: string; readonly merchantId: string; readonly amountCents: number }
interface BridgeOrder { readonly id: string; readonly merchantId: string | null; readonly amount: string }

// These links are investigation leads, not evidence of a successful payment.
export function auditLightpayOrders(merchants: readonly MainMerchant[], orders: readonly MainOrder[], bridgeOrders: readonly BridgeOrder[], historicBindingMerchantIds: readonly string[] = []) {
  const merchantIds = new Set<string>();
  for (const merchant of merchants) {
    if (!merchant || typeof merchant.id !== "string" || !merchant.id || merchantIds.has(merchant.id)) throw new Error("invalid or duplicate main merchant");
    merchantIds.add(merchant.id);
  }
  const mainById = new Map<string, MainOrder>();
  for (const order of orders) {
    if (!order || typeof order.id !== "string" || !order.id || mainById.has(order.id) || typeof order.merchantId !== "string" || !order.merchantId || !Number.isSafeInteger(order.amountCents) || order.amountCents < 0) throw new Error("invalid or duplicate main order");
    mainById.set(order.id, order);
  }
  const counts = { bridgeOrders: 0, missingMerchant: 0, unknownMerchant: 0, noMainOrder: 0, merchantMismatch: 0, amountMismatch: 0, candidates: 0 };
  const historic = new Set<string>();
  for (const id of historicBindingMerchantIds) {
    if (typeof id !== "string" || !id || historic.has(id)) throw new Error("invalid or duplicate historic binding");
    historic.add(id);
  }
  const historicEvidence = { unknownMerchantOrdersWithBinding: 0, missingMainOrdersWithBinding: 0 };
  const bridgeIds = new Set<string>();
  for (const order of bridgeOrders) {
    if (!order || typeof order.id !== "string" || !order.id || bridgeIds.has(order.id) || typeof order.amount !== "string" || (order.merchantId !== null && typeof order.merchantId !== "string")) throw new Error("invalid or duplicate bridge order");
    bridgeIds.add(order.id);
    const amount = parseLegacyCents(order.amount);
    counts.bridgeOrders++;
    if (!order.merchantId) { counts.missingMerchant++; continue; }
    if (!merchantIds.has(order.merchantId)) {
      counts.unknownMerchant++;
      if (historic.has(order.merchantId)) historicEvidence.unknownMerchantOrdersWithBinding++;
    }
    const main = mainById.get(order.id);
    if (!main) {
      counts.noMainOrder++;
      if (historic.has(order.merchantId)) historicEvidence.missingMainOrdersWithBinding++;
      continue;
    }
    if (main.merchantId !== order.merchantId) { counts.merchantMismatch++; continue; }
    if (main.amountCents !== amount) { counts.amountMismatch++; continue; }
    // A deleted merchant cannot establish current ownership even if both records agree.
    if (merchantIds.has(order.merchantId)) counts.candidates++;
  }
  return { counts, historicEvidence, snapshotsComparable: false as const };
}
