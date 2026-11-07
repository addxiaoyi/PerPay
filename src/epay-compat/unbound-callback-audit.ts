type MainMerchant = { id: string; callbackUrl?: unknown; username?: unknown; displayName?: unknown };
type MainOrder = { merchantId: string; callbackUrl?: unknown; notifyUrl?: unknown };
type LegacyOrder = { merchantId: number; notifyUrl: unknown };
type LegacyMerchant = { id: number; name: unknown };

function callback(value: unknown): string | null {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
    return url.href;
  } catch { return null; }
}

// URL equality is a lead only: shared endpoints and changed configurations cannot establish ownership.
export function auditUnboundCallbackEvidence(input: {
  merchants: readonly MainMerchant[];
  orders: readonly MainOrder[];
  legacyOrders: readonly LegacyOrder[];
  legacyMerchants: readonly LegacyMerchant[];
  boundLegacyIds: readonly number[];
}) {
  const merchants = new Set<string>();
  const owners = new Map<string, Set<string>>();
  const names = new Map<string, Set<string>>();
  const validName = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128 && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
  const add = (merchantId: string, raw: unknown) => {
    const url = callback(raw);
    if (!url) return;
    const matches = owners.get(url) ?? new Set<string>();
    matches.add(merchantId);
    owners.set(url, matches);
  };
  for (const merchant of input.merchants) {
    if (!merchant.id || merchants.has(merchant.id)) throw new Error("invalid or duplicate main merchant");
    merchants.add(merchant.id);
    add(merchant.id, merchant.callbackUrl);
    for (const name of [merchant.username, merchant.displayName]) {
      if (!validName(name)) continue;
      const matches = names.get(name) ?? new Set<string>();
      matches.add(merchant.id);
      names.set(name, matches);
    }
  }
  for (const order of input.orders) {
    if (!merchants.has(order.merchantId)) continue;
    add(order.merchantId, order.callbackUrl);
    add(order.merchantId, order.notifyUrl);
  }
  const bound = new Set(input.boundLegacyIds);
  if (bound.size !== input.boundLegacyIds.length || [...bound].some((id) => !Number.isSafeInteger(id) || id < 1)) throw new Error("invalid legacy binding");
  const legacyNames = new Map<number, string | null>();
  for (const merchant of input.legacyMerchants) {
    if (!Number.isSafeInteger(merchant.id) || merchant.id < 1 || legacyNames.has(merchant.id)) throw new Error("invalid or duplicate legacy merchant");
    legacyNames.set(merchant.id, validName(merchant.name) ? merchant.name : null);
  }
  const legacy = new Map<number, { orders: number; urls: Set<string>; candidates: Set<string> }>();
  for (const order of input.legacyOrders) {
    if (!Number.isSafeInteger(order.merchantId) || order.merchantId < 1) throw new Error("invalid legacy order merchant");
    if (bound.has(order.merchantId)) continue;
    const entry = legacy.get(order.merchantId) ?? { orders: 0, urls: new Set<string>(), candidates: new Set<string>() };
    entry.orders++;
    const url = callback(order.notifyUrl);
    if (url) {
      entry.urls.add(url);
      for (const owner of owners.get(url) ?? []) entry.candidates.add(owner);
    }
    legacy.set(order.merchantId, entry);
  }
  const summary = { unboundMerchants: legacy.size, unboundOrders: 0, withUniqueCandidate: 0, withMultipleCandidates: 0, withoutCandidate: 0, usableCallbackUrls: 0, nameOnlyUnique: 0, nameOnlyMultiple: 0, nameNoMatch: 0, callbackAndNameUnique: 0, callbackAndNameMultiple: 0, callbackAndNameNoMatch: 0 };
  for (const [id, entry] of legacy) {
    if (!legacyNames.has(id)) throw new Error("legacy order references missing merchant");
    summary.unboundOrders += entry.orders;
    summary.usableCallbackUrls += entry.urls.size;
    if (entry.candidates.size === 0) summary.withoutCandidate++;
    else if (entry.candidates.size === 1) summary.withUniqueCandidate++;
    else summary.withMultipleCandidates++;
    const name = legacyNames.get(id);
    const nameCandidates = name ? names.get(name) ?? new Set<string>() : new Set<string>();
    if (nameCandidates.size === 0) summary.nameNoMatch++;
    else if (nameCandidates.size === 1) summary.nameOnlyUnique++;
    else summary.nameOnlyMultiple++;
    const intersection = [...nameCandidates].filter((candidate) => entry.candidates.has(candidate)).length;
    if (intersection === 0) summary.callbackAndNameNoMatch++;
    else if (intersection === 1) summary.callbackAndNameUnique++;
    else summary.callbackAndNameMultiple++;
  }
  return { ...summary, provesOwnership: false as const, coordinatedSnapshot: false as const };
}
