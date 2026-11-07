import type { DatabaseSync } from "node:sqlite";
import { auditMainLedger } from "./main-ledger-audit.ts";

// This compares current configured rates, not the rates applied to historical orders.
export function auditImportedMerchantFees(db: DatabaseSync, payment: unknown) {
  if (!db.isTransaction) throw new Error("merchant fee audit requires a transaction");
  auditMainLedger(payment);
  const merchants = (payment as { merchants: Array<{ id: string; apiId?: unknown; feeRate: number }> }).merchants;
  const byId = new Map(merchants.map(merchant => [merchant.id, merchant]));
  const apiCounts = new Map<string, number>();
  const matchedBindings = new Map<string, number>();
  for (const merchant of merchants) {
    if (typeof merchant.apiId === "string" && merchant.apiId) apiCounts.set(merchant.apiId, (apiCounts.get(merchant.apiId) ?? 0) + 1);
  }
  const rows = db.prepare(`SELECT m.merchant_id, m.fee_rate_bps, b.main_merchant_id, b.main_api_id
    FROM epay_merchant_accounts m LEFT JOIN epay_merchant_bindings b ON b.epay_merchant_id=m.merchant_id`).all() as Array<{
      merchant_id: number | bigint; fee_rate_bps: number | bigint; main_merchant_id: string | null; main_api_id: string | null;
    }>;
  let unbound = 0, missingMain = 0, identityMismatch = 0, ambiguousApi = 0, unsupportedPrecision = 0, compared = 0, mismatched = 0;
  for (const row of rows) {
    const rate = Number(row.fee_rate_bps);
    if (!Number.isSafeInteger(rate) || rate < 0 || rate > 5000) throw new Error("invalid imported merchant fee");
    if (row.main_merchant_id === null || row.main_api_id === null) { unbound++; continue; }
    const merchant = byId.get(row.main_merchant_id);
    if (!merchant) { missingMain++; continue; }
    if (!row.main_api_id || merchant.apiId !== row.main_api_id) { identityMismatch++; continue; }
    if (apiCounts.get(row.main_api_id) !== 1) { ambiguousApi++; continue; }
    matchedBindings.set(merchant.id, (matchedBindings.get(merchant.id) ?? 0) + 1);
    const bps = merchant.feeRate * 10000;
    if (Math.abs(bps - Math.round(bps)) > 1e-8) { unsupportedPrecision++; continue; }
    compared++;
    if (rate !== Math.round(bps)) mismatched++;
  }
  const mainUnmapped = merchants.filter(merchant => !matchedBindings.has(merchant.id)).length;
  const mainAmbiguousBindings = merchants.filter(merchant => (matchedBindings.get(merchant.id) ?? 0) > 1).length;
  return { merchants: rows.length, mainMerchants: merchants.length, mainUnmapped, mainAmbiguousBindings, compared, mismatched, unbound, missingMain, identityMismatch, ambiguousApi, unsupportedPrecision, sharedCutoffVerified: false as const, historicalFeesVerified: false as const };
}
