interface MainMerchant {
  id: string;
  feeRate: number;
}

interface MainLedgerEntry {
  id: string;
  merchantId: string;
  availableDelta: number;
  frozenDelta: number;
}

export interface MainLedgerAudit {
  merchantCount: number;
  ledgerCount: number;
  missingMerchantReferences: number;
  unsupportedFeePrecision: number;
  summaryMismatches: number | null;
  balances: ReadonlyArray<{ merchantId: string; availableCents: number; frozenCents: number }>;
}

export function auditMainLedger(payment: unknown): MainLedgerAudit {
  if (!payment || typeof payment !== "object" || Array.isArray(payment)) throw new Error("main payment store is invalid");
  const store = payment as Record<string, unknown>;
  if (!Array.isArray(store.merchants) || !Array.isArray(store.ledger)) throw new Error("main payment store is missing merchants or ledger");
  const merchants = store.merchants as MainMerchant[];
  const entries = store.ledger as MainLedgerEntry[];
  const balances = new Map<string, { merchantId: string; availableCents: number; frozenCents: number }>();
  let unsupportedFeePrecision = 0;
  for (const merchant of merchants) {
    if (!merchant || typeof merchant.id !== "string" || !merchant.id || balances.has(merchant.id)) throw new Error("main payment store has an invalid or duplicate merchant ID");
    if (typeof merchant.feeRate !== "number" || !Number.isFinite(merchant.feeRate) || merchant.feeRate < 0 || merchant.feeRate > 0.5) throw new Error("main payment store has an invalid merchant fee rate");
    const basisPoints = merchant.feeRate * 10000;
    if (Math.abs(basisPoints - Math.round(basisPoints)) > 1e-8) unsupportedFeePrecision++;
    balances.set(merchant.id, { merchantId: merchant.id, availableCents: 0, frozenCents: 0 });
  }
  const ids = new Set<string>();
  let missingMerchantReferences = 0;
  for (const entry of entries) {
    if (!entry || typeof entry.id !== "string" || !entry.id || ids.has(entry.id)) throw new Error("main payment store has an invalid or duplicate ledger ID");
    ids.add(entry.id);
    if (typeof entry.merchantId !== "string" || !entry.merchantId || !Number.isSafeInteger(entry.availableDelta) || !Number.isSafeInteger(entry.frozenDelta)) throw new Error("main payment store has an invalid ledger entry");
    const balance = balances.get(entry.merchantId);
    if (!balance) { missingMerchantReferences++; continue; }
    balance.availableCents += entry.availableDelta;
    balance.frozenCents += entry.frozenDelta;
    if (!Number.isSafeInteger(balance.availableCents) || !Number.isSafeInteger(balance.frozenCents)) throw new Error("main payment ledger balance exceeds the safe integer range");
  }
  let summaryMismatches: number | null = null;
  if (store.balanceSummaryVersion === 1) {
    const summaries = store.balanceSummaries;
    if (!summaries || typeof summaries !== "object" || Array.isArray(summaries)) throw new Error("main payment balance summaries are invalid");
    summaryMismatches = 0;
    const cached = summaries as Record<string, unknown>;
    for (const [merchantId, balance] of balances) {
      const value = Object.hasOwn(cached, merchantId) ? cached[merchantId] : undefined;
      if (value === undefined) {
        if (balance.availableCents !== 0 || balance.frozenCents !== 0) summaryMismatches++;
        continue;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("main payment balance summary is invalid");
      const summary = value as Record<string, unknown>;
      if (!Number.isSafeInteger(summary.availableCents) || !Number.isSafeInteger(summary.frozenCents)) throw new Error("main payment balance summary is invalid");
      if (summary.availableCents !== balance.availableCents || summary.frozenCents !== balance.frozenCents) summaryMismatches++;
    }
    for (const merchantId of Object.keys(cached)) if (!balances.has(merchantId)) summaryMismatches++;
  }
  return { merchantCount: merchants.length, ledgerCount: entries.length, missingMerchantReferences, unsupportedFeePrecision, summaryMismatches, balances: [...balances.values()] };
}
