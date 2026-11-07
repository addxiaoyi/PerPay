type Issue = { code: string; id: string };
type Settlement = { id: string; merchantId: string; amountCents: number; status: string };
type Posting = { merchantId: unknown; availableDelta: unknown; frozenDelta: unknown; type: string };
const postingTypes = new Set(["settlement_freeze", "settlement_unfreeze", "manual_payout"]);

// Historical records are inspected as evidence, not as proof of an actual payout.
export function auditMainSettlements(payment: unknown): Issue[] {
  if (!payment || typeof payment !== "object" || Array.isArray(payment)) throw new Error("invalid main settlement source");
  const source = payment as Record<string, unknown>;
  if (!Array.isArray(source.ledger) || !Array.isArray(source.merchants)) throw new Error("main settlement source is incomplete");
  if (!Object.hasOwn(source, "settlements")) return [{ code: "main_settlements_unavailable", id: "snapshot" }];
  if (!Array.isArray(source.settlements)) throw new Error("invalid main settlements");
  const merchants = new Set<string>();
  for (const value of source.merchants) {
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { id?: unknown }).id !== "string") throw new Error("invalid main settlement merchant");
    const id = (value as { id: string }).id;
    if (!id || merchants.has(id)) throw new Error("invalid or duplicate main settlement merchant");
    merchants.add(id);
  }
  const settlements = new Map<string, Settlement>();
  const issues: Issue[] = [];
  for (const value of source.settlements) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid main settlement record");
    const row = value as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id || settlements.has(row.id) || typeof row.merchantId !== "string" || !row.merchantId || !Number.isSafeInteger(row.amountCents) || Number(row.amountCents) <= 0 || typeof row.status !== "string" || !row.status) throw new Error("invalid or duplicate main settlement record");
    const settlement = { id: row.id, merchantId: row.merchantId, amountCents: Number(row.amountCents), status: row.status };
    settlements.set(row.id, settlement);
    if (!merchants.has(row.merchantId)) issues.push({ code: "main_settlement_missing_merchant", id: row.id });
    if (!["pending", "paid", "rejected"].includes(row.status)) issues.push({ code: "main_settlement_unknown_status", id: row.id });
  }
  const postings = new Map<string, Posting[]>();
  const ledgerIds = new Set<string>();
  for (const value of source.ledger) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid main settlement ledger entry");
    const row = value as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id || ledgerIds.has(row.id)) throw new Error("invalid or duplicate main settlement ledger ID");
    ledgerIds.add(row.id);
    if (typeof row.type !== "string" || !postingTypes.has(row.type)) continue;
    if (typeof row.settlementId !== "string" || !row.settlementId) { issues.push({ code: "main_settlement_posting_missing_reference", id: row.id }); continue; }
    if (!settlements.has(row.settlementId)) { issues.push({ code: "main_settlement_posting_orphan", id: row.id }); continue; }
    const group = postings.get(row.settlementId) ?? [];
    group.push({ type: row.type, merchantId: row.merchantId, availableDelta: row.availableDelta, frozenDelta: row.frozenDelta });
    postings.set(row.settlementId, group);
  }
  for (const settlement of settlements.values()) {
    const group = postings.get(settlement.id) ?? [];
    const expected = settlement.status === "paid" ? ["settlement_freeze", "manual_payout"] : settlement.status === "rejected" ? ["settlement_freeze", "settlement_unfreeze"] : settlement.status === "pending" ? ["settlement_freeze"] : null;
    if (expected && (group.length !== expected.length || expected.some(type => group.filter(entry => entry.type === type).length !== 1))) issues.push({ code: "main_settlement_posting_count_mismatch", id: settlement.id });
    for (const entry of group) {
      const available = entry.type === "settlement_freeze" ? -settlement.amountCents : entry.type === "settlement_unfreeze" ? settlement.amountCents : 0;
      const frozen = entry.type === "settlement_freeze" ? settlement.amountCents : -settlement.amountCents;
      if (entry.merchantId !== settlement.merchantId || entry.availableDelta !== available || entry.frozenDelta !== frozen) issues.push({ code: "main_settlement_posting_mismatch", id: settlement.id });
    }
  }
  return issues;
}
