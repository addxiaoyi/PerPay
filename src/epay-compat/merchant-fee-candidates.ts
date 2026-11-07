import { readAuthenticatedEPaySnapshot } from "./authenticated-snapshot.ts";
import { auditMainLedger } from "./main-ledger-audit.ts";

type SnapshotOptions = Parameters<typeof readAuthenticatedEPaySnapshot>[0];
type FeeIssue = { merchantId: number; reason: "unbound" | "missing_main" | "identity_mismatch" | "ambiguous_api" | "unsupported_precision" };

function merchantId(value: unknown): number {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) throw new Error("invalid EPay merchant ID");
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("invalid EPay merchant ID");
  return id;
}

// These are current-rate candidates from two snapshots, not reconciled historical rates.
export function deriveMerchantFeeCandidates(options: SnapshotOptions, snapshotId: string, payment: unknown) {
  auditMainLedger(payment);
  const snapshot = readAuthenticatedEPaySnapshot({ ...options, requireColumnMetadata: true }, snapshotId);
  const main = (payment as { merchants: Array<{ id: string; apiId?: unknown; feeRate: number }> }).merchants;
  const mainById = new Map(main.map(merchant => [merchant.id, merchant]));
  const apiCounts = new Map<string, number>();
  for (const merchant of main) {
    if (typeof merchant.apiId === "string" && merchant.apiId) apiCounts.set(merchant.apiId, (apiCounts.get(merchant.apiId) ?? 0) + 1);
  }
  const merchantIds = new Set<number>();
  for (const merchant of snapshot.tables.Merchant) {
    const id = merchantId(merchant.id);
    if (merchantIds.has(id)) throw new Error("duplicate EPay merchant");
    merchantIds.add(id);
  }
  const byMerchant = new Map<number, { mainId: string; apiId: string }>();
  const usedMain = new Set<string>();
  for (const binding of snapshot.tables.MerchantBinding) {
    const id = merchantId(binding.epayMerchantId);
    if (!merchantIds.has(id) || typeof binding.mainMerchantId !== "string" || !binding.mainMerchantId || typeof binding.mainApiId !== "string" || !binding.mainApiId || byMerchant.has(id) || usedMain.has(binding.mainMerchantId)) throw new Error("invalid or duplicate merchant binding");
    byMerchant.set(id, { mainId: binding.mainMerchantId, apiId: binding.mainApiId });
    usedMain.add(binding.mainMerchantId);
  }
  const rates: Record<string, number> = Object.create(null) as Record<string, number>;
  const unresolved: FeeIssue[] = [];
  for (const merchantId of merchantIds) {
    const binding = byMerchant.get(merchantId);
    if (!binding) { unresolved.push({ merchantId, reason: "unbound" }); continue; }
    const merchant = mainById.get(binding.mainId);
    if (!merchant) { unresolved.push({ merchantId, reason: "missing_main" }); continue; }
    if (merchant.apiId !== binding.apiId) { unresolved.push({ merchantId, reason: "identity_mismatch" }); continue; }
    if (apiCounts.get(binding.apiId) !== 1) { unresolved.push({ merchantId, reason: "ambiguous_api" }); continue; }
    const bps = merchant.feeRate * 10000;
    if (Math.abs(bps - Math.round(bps)) > 1e-8) { unresolved.push({ merchantId, reason: "unsupported_precision" }); continue; }
    rates[String(merchantId)] = Math.round(bps);
  }
  return { rates, unresolved, sharedCutoffVerified: false as const, historicalFeesVerified: false as const };
}
