import { parseLegacyCents } from "./money.ts";

interface Binding { readonly mainMerchantId: string; readonly epayMerchantId: number }
interface MainOrder { readonly id: string; readonly merchantId: string; readonly merchantOrderId: string; readonly amountCents: number; readonly status: string; readonly tradeNo?: string | null }
interface EPayOrder { readonly tradeNo: string; readonly merchantId: number; readonly outTradeNo: string; readonly money: string; readonly status: string; readonly apiTradeNo?: string | null }
interface Issue { readonly code: string; readonly id: string }
const LEGACY_MAIN_ORDER_WINDOW = 100;
const LEGACY_EPAY_PAID_WINDOW = 1000;

// Matching reflects the legacy dashboard's deduplication, not proof of settlement.
export function auditOrderLinks(bindings: readonly Binding[], mainOrders: readonly MainOrder[], epayOrders: readonly EPayOrder[]) {
  const mainBindings = new Map<string, number>();
  const epayBindings = new Map<number, string>();
  for (const binding of bindings) {
    if (!binding.mainMerchantId || !Number.isSafeInteger(binding.epayMerchantId) || binding.epayMerchantId < 1 || mainBindings.has(binding.mainMerchantId) || epayBindings.has(binding.epayMerchantId)) throw new Error("invalid or duplicate merchant binding");
    mainBindings.set(binding.mainMerchantId, binding.epayMerchantId);
    epayBindings.set(binding.epayMerchantId, binding.mainMerchantId);
  }
  const issues: Issue[] = [];
  const mainIds = new Set<string>();
  const epayIds = new Set<string>();
  const mainKeys = new Map<string, MainOrder[]>();
  const internalKeys = new Map<string, MainOrder>();
  const epayKeys = new Map<string, EPayOrder[]>();
  const mainProviderKeys = new Map<string, MainOrder[]>();
  const epayProviderKeys = new Map<string, EPayOrder[]>();
  const mainCounts = new Map<string, number>();
  const epayPaidCounts = new Map<number, number>();
  const mainProviderOwners = new Map<string, Set<string>>();
  const epayProviderOwners = new Map<string, Set<number>>();
  const key = (merchantId: string, orderNo: string) => JSON.stringify([merchantId, orderNo]);
  for (const order of mainOrders) {
    if (!order.id || mainIds.has(order.id) || !order.merchantId || !order.merchantOrderId || !Number.isSafeInteger(order.amountCents) || order.amountCents < 0 || !order.status) throw new Error("invalid or duplicate main order");
    mainIds.add(order.id);
    if (order.tradeNo !== undefined && order.tradeNo !== null && typeof order.tradeNo !== "string") throw new Error("invalid main provider transaction ID");
    if (order.tradeNo && order.tradeNo.trim() === order.tradeNo) {
      const owners = mainProviderOwners.get(order.tradeNo) ?? new Set<string>();
      owners.add(order.merchantId);
      mainProviderOwners.set(order.tradeNo, owners);
    }
    if (!mainBindings.has(order.merchantId)) { issues.push({ code: "unbound_main_order", id: order.id }); continue; }
    mainCounts.set(order.merchantId, (mainCounts.get(order.merchantId) ?? 0) + 1);
    if (order.tradeNo && order.tradeNo.trim() === order.tradeNo) {
      const providerKey = key(order.merchantId, order.tradeNo);
      mainProviderKeys.set(providerKey, [...(mainProviderKeys.get(providerKey) ?? []), order]);
    }
    internalKeys.set(key(order.merchantId, order.id), order);
    const orderKey = key(order.merchantId, order.merchantOrderId);
    mainKeys.set(orderKey, [...(mainKeys.get(orderKey) ?? []), order]);
  }
  for (const order of epayOrders) {
    if (!order.tradeNo || epayIds.has(order.tradeNo) || !Number.isSafeInteger(order.merchantId) || order.merchantId < 1 || !order.outTradeNo || typeof order.money !== "string" || !order.status) throw new Error("invalid or duplicate EPay order");
    if (parseLegacyCents(order.money) < 0) throw new Error("negative EPay order amount");
    epayIds.add(order.tradeNo);
    if (order.apiTradeNo !== undefined && order.apiTradeNo !== null && typeof order.apiTradeNo !== "string") throw new Error("invalid EPay provider transaction ID");
    if (order.apiTradeNo && order.apiTradeNo.trim() === order.apiTradeNo) {
      const owners = epayProviderOwners.get(order.apiTradeNo) ?? new Set<number>();
      owners.add(order.merchantId);
      epayProviderOwners.set(order.apiTradeNo, owners);
    }
    const mainMerchant = epayBindings.get(order.merchantId);
    if (!mainMerchant) { issues.push({ code: "unbound_epay_order", id: order.tradeNo }); continue; }
    if (order.status === "PAID") epayPaidCounts.set(order.merchantId, (epayPaidCounts.get(order.merchantId) ?? 0) + 1);
    if (order.apiTradeNo && order.apiTradeNo.trim() === order.apiTradeNo) {
      const providerKey = key(mainMerchant, order.apiTradeNo);
      epayProviderKeys.set(providerKey, [...(epayProviderKeys.get(providerKey) ?? []), order]);
    }
    const orderKey = key(mainMerchant, order.outTradeNo);
    epayKeys.set(orderKey, [...(epayKeys.get(orderKey) ?? []), order]);
  }
  for (const binding of bindings) {
    if ((mainCounts.get(binding.mainMerchantId) ?? 0) >= LEGACY_MAIN_ORDER_WINDOW) issues.push({ code: "legacy_main_order_window_may_truncate", id: binding.mainMerchantId });
    if ((epayPaidCounts.get(binding.epayMerchantId) ?? 0) >= LEGACY_EPAY_PAID_WINDOW) issues.push({ code: "legacy_epay_paid_window_may_truncate", id: String(binding.epayMerchantId) });
  }
  let matched = 0;
  const providerCandidates = { sameAmount: 0, amountMismatch: 0, ambiguous: 0 };
  for (const [providerKey, epay] of epayProviderKeys) {
    const main = mainProviderKeys.get(providerKey);
    if (!main) continue;
    if (main.length !== 1 || epay.length !== 1) { providerCandidates.ambiguous++; continue; }
    if (main[0]!.amountCents === parseLegacyCents(epay[0]!.money)) providerCandidates.sameAmount++;
    else providerCandidates.amountMismatch++;
  }
  const projectionCandidates = { sameAmount: 0, amountMismatch: 0, ambiguous: 0 };
  for (const [orderKey, epay] of epayKeys) {
    const main = internalKeys.get(orderKey);
    if (!main) continue;
    if (epay.length !== 1) { projectionCandidates.ambiguous++; continue; }
    if (main.amountCents === parseLegacyCents(epay[0]!.money)) projectionCandidates.sameAmount++;
    else projectionCandidates.amountMismatch++;
  }
  for (const orderKey of new Set([...mainKeys.keys(), ...epayKeys.keys()])) {
    const main = mainKeys.get(orderKey) ?? [];
    const epay = epayKeys.get(orderKey) ?? [];
    if (main.length > 1 || epay.length > 1) {
      for (const order of main) issues.push({ code: "ambiguous_main_order", id: order.id });
      for (const order of epay) issues.push({ code: "ambiguous_epay_order", id: order.tradeNo });
      continue;
    }
    if (!main.length) { issues.push({ code: "epay_order_without_main_match", id: epay[0]!.tradeNo }); continue; }
    if (!epay.length) { issues.push({ code: "main_order_without_epay_match", id: main[0]!.id }); continue; }
    const left = main[0]!;
    const right = epay[0]!;
    matched++;
    if (left.amountCents !== parseLegacyCents(right.money)) issues.push({ code: "order_amount_mismatch", id: right.tradeNo });
    if (left.status.toUpperCase() !== right.status.toUpperCase()) issues.push({ code: "order_status_difference", id: right.tradeNo });
  }
  // Provider namespaces may differ, so these collisions are leads, not ownership proof.
  const providerCrossMerchantLeads = {
    main: [...mainProviderOwners.values()].filter(owners => owners.size > 1).length,
    epay: [...epayProviderOwners.values()].filter(owners => owners.size > 1).length,
  };
  return { matched, issues, projectionCandidates, providerCandidates, providerCrossMerchantLeads, snapshotsComparable: false as const };
}
