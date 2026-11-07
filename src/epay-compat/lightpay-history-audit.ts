import { parseLegacyCents } from "./money.ts";

interface Merchant { readonly id: string }
interface Order { readonly id: string; readonly merchantId: string; readonly amountCents: number }
interface Snapshot { readonly merchants: readonly Merchant[]; readonly orders: readonly Order[] }
interface BridgeOrder { readonly id: string; readonly merchantId: string | null; readonly amount: string }

export function auditLightpayHistory(current: Snapshot, history: readonly Snapshot[], bridgeOrders: readonly BridgeOrder[]) {
  function index(snapshot: Snapshot) {
    if (!Array.isArray(snapshot.merchants) || !Array.isArray(snapshot.orders)) throw new Error("invalid historical snapshot");
    const merchants = new Set<string>();
    for (const row of snapshot.merchants) {
      if (!row || typeof row.id !== "string" || !row.id || merchants.has(row.id)) throw new Error("invalid or duplicate merchant in snapshot");
      merchants.add(row.id);
    }
    const orders = new Map<string, Order>();
    for (const row of snapshot.orders) {
      if (!row || typeof row.id !== "string" || !row.id || typeof row.merchantId !== "string" || !row.merchantId || !Number.isSafeInteger(row.amountCents) || row.amountCents < 0 || orders.has(row.id)) throw new Error("invalid or duplicate order in snapshot");
      orders.set(row.id, row);
    }
    return { merchants, orders };
  }
  const now = index(current);
  const prior = history.map(index);
  const bridgeIds = new Set<string>();
  const evidence = { missingBoth: 0, historicMerchant: 0, historicOrderId: 0, exactOrderCandidate: 0, conflictingOrderEvidence: 0 };
  for (const row of bridgeOrders) {
    if (!row || typeof row.id !== "string" || !row.id || bridgeIds.has(row.id) || (row.merchantId !== null && typeof row.merchantId !== "string") || typeof row.amount !== "string") throw new Error("invalid or duplicate bridge order");
    bridgeIds.add(row.id);
    const amount = parseLegacyCents(row.amount);
    if (!row.merchantId || now.merchants.has(row.merchantId) || now.orders.has(row.id)) continue;
    evidence.missingBoth++;
    let foundMerchant = false;
    let foundOrder = false;
    let exact = false;
    let conflict = false;
    for (const snapshot of prior) {
      if (snapshot.merchants.has(row.merchantId)) foundMerchant = true;
      const order = snapshot.orders.get(row.id);
      if (!order) continue;
      foundOrder = true;
      if (order.merchantId === row.merchantId && order.amountCents === amount) exact = true;
      else conflict = true;
    }
    if (foundMerchant) evidence.historicMerchant++;
    if (foundOrder) evidence.historicOrderId++;
    if (exact) evidence.exactOrderCandidate++;
    if (conflict) evidence.conflictingOrderEvidence++;
  }
  return { evidence, snapshotCount: prior.length, snapshotsComparable: false as const };
}
