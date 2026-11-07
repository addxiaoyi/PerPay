const mappedCollections = new Set(["merchants", "orders", "ledger", "refunds"]);
const expectedCollections = ["merchants", "orders", "ledger", "refunds", "settlements", "callbacks", "syncJobs", "paymentEvents", "orderMirrors", "accessTokens", "invoiceApplications"] as const;
const knownNonCollections = new Set(["channels", "balanceSummaryVersion", "balanceSummaries"]);

// Counts describe coverage, not financial correctness or proof of a common cutoff.
export function auditMainSourceCoverage(payment: unknown) {
  if (!payment || typeof payment !== "object" || Array.isArray(payment)) throw new Error("invalid main payment source");
  const source = payment as Record<string, unknown>;
  const missingCollections: string[] = [];
  const unmappedCollections: Array<{ name: string; count: number }> = [];
  for (const name of expectedCollections) {
    if (!Object.hasOwn(source, name)) { missingCollections.push(name); continue; }
    const rows = source[name];
    if (!Array.isArray(rows)) throw new Error(`invalid main payment collection: ${name}`);
    if (!mappedCollections.has(name)) unmappedCollections.push({ name, count: rows.length });
  }
  const unknownFields = Object.keys(source).filter(name => !expectedCollections.includes(name as typeof expectedCollections[number]) && !knownNonCollections.has(name)).sort();
  return { missingCollections, unmappedCollections, unknownFields, complete: false as const, financiallyReconciled: false as const };
}
