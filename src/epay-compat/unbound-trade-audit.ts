import { parseLegacyCents } from "./money.ts";

type MainOrder = { tradeNo?: unknown; amountCents?: unknown };
type LegacyOrder = { merchantId: number; apiTradeNo?: unknown; money: string };

function tradeId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && value === value.trim() && !/[\x00-\x20\x7f]/.test(value) ? value : null;
}

// Matching locally stored IDs is evidence to investigate, not provider verification.
export function auditUnboundTradeEvidence(input: { mainOrders: readonly MainOrder[]; legacyOrders: readonly LegacyOrder[]; boundLegacyIds: readonly number[] }) {
  const bound = new Set(input.boundLegacyIds);
  if (bound.size !== input.boundLegacyIds.length || [...bound].some((id) => !Number.isSafeInteger(id) || id < 1)) throw new Error("invalid legacy binding");
  const main = new Map<string, MainOrder[]>();
  for (const order of input.mainOrders) {
    const id = tradeId(order.tradeNo);
    if (!id) continue;
    if (!Number.isSafeInteger(order.amountCents) || Number(order.amountCents) < 0) throw new Error("invalid main order amount");
    const matches = main.get(id) ?? [];
    matches.push(order);
    main.set(id, matches);
  }
  const legacy = new Map<string, LegacyOrder[]>();
  const allLegacyCounts = new Map<string, number>();
  const summary = { unboundOrders: 0, withoutTradeId: 0, withTradeId: 0, noMainMatch: 0, uniqueExactAmount: 0, uniqueAmountMismatch: 0, ambiguousTradeId: 0 };
  for (const order of input.legacyOrders) {
    if (!Number.isSafeInteger(order.merchantId) || order.merchantId < 1) throw new Error("invalid legacy order merchant");
    const id = tradeId(order.apiTradeNo);
    if (id) allLegacyCounts.set(id, (allLegacyCounts.get(id) ?? 0) + 1);
    if (bound.has(order.merchantId)) continue;
    const amount = parseLegacyCents(order.money);
    if (amount < 0) throw new Error("invalid legacy order amount");
    summary.unboundOrders++;
    if (!id) { summary.withoutTradeId++; continue; }
    summary.withTradeId++;
    const matches = legacy.get(id) ?? [];
    matches.push(order);
    legacy.set(id, matches);
  }
  for (const [id, orders] of legacy) {
    const matches = main.get(id) ?? [];
    if (allLegacyCounts.get(id) !== 1 || matches.length > 1) summary.ambiguousTradeId += orders.length;
    else if (matches.length === 0) summary.noMainMatch++;
    else if (parseLegacyCents(orders[0]!.money) === matches[0]!.amountCents) summary.uniqueExactAmount++;
    else summary.uniqueAmountMismatch++;
  }
  return { ...summary, provesOwnership: false as const, providerVerified: false as const, coordinatedSnapshot: false as const };
}
