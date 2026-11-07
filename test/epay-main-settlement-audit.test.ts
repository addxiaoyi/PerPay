import assert from "node:assert/strict";
import { it } from "node:test";
import { auditMainSettlements } from "../src/epay-compat/main-settlement-audit.ts";

const fixture = () => ({
  merchants: [{ id: "merchant-a" }],
  settlements: [
    { id: "pending", merchantId: "merchant-a", amountCents: 100, status: "pending" },
    { id: "paid", merchantId: "merchant-a", amountCents: 200, status: "paid" },
    { id: "rejected", merchantId: "merchant-a", amountCents: 300, status: "rejected" },
  ],
  ledger: [
    { id: "f1", settlementId: "pending", merchantId: "merchant-a", type: "settlement_freeze", availableDelta: -100, frozenDelta: 100 },
    { id: "f2", settlementId: "paid", merchantId: "merchant-a", type: "settlement_freeze", availableDelta: -200, frozenDelta: 200 },
    { id: "p2", settlementId: "paid", merchantId: "merchant-a", type: "manual_payout", availableDelta: 0, frozenDelta: -200 },
    { id: "f3", settlementId: "rejected", merchantId: "merchant-a", type: "settlement_freeze", availableDelta: -300, frozenDelta: 300 },
    { id: "u3", settlementId: "rejected", merchantId: "merchant-a", type: "settlement_unfreeze", availableDelta: 300, frozenDelta: -300 },
  ],
});

it("checks settlement freeze and final postings without inferring payout", () => {
  assert.deepEqual(auditMainSettlements(fixture()), []);
  assert.deepEqual(auditMainSettlements({ merchants: [], ledger: [] }), [{ code: "main_settlements_unavailable", id: "snapshot" }]);
});

it("reports missing, duplicated, orphaned and mismatched settlement postings", () => {
  const source = fixture();
  source.ledger.splice(2, 1);
  source.ledger.push({ ...source.ledger[0]!, id: "duplicate" });
  source.ledger.push({ ...source.ledger[0]!, id: "orphan", settlementId: "absent" });
  source.ledger.push({ ...source.ledger[0]!, id: "unlinked", settlementId: "" });
  source.ledger[3]!.merchantId = "merchant-b";
  const issues = auditMainSettlements(source);
  for (const [code, id] of [["main_settlement_posting_count_mismatch", "paid"], ["main_settlement_posting_count_mismatch", "pending"], ["main_settlement_posting_orphan", "orphan"], ["main_settlement_posting_missing_reference", "unlinked"], ["main_settlement_posting_mismatch", "rejected"]]) assert.ok(issues.some(issue => issue.code === code && issue.id === id), `${code}: ${id}`);
});

it("reports unknown status and missing ownership, and rejects malformed records", () => {
  const source = fixture();
  source.settlements[0]!.status = "other";
  source.settlements[0]!.merchantId = "missing";
  const issues = auditMainSettlements(source);
  assert.ok(issues.some(issue => issue.code === "main_settlement_unknown_status" && issue.id === "pending"));
  assert.ok(issues.some(issue => issue.code === "main_settlement_missing_merchant" && issue.id === "pending"));
  assert.throws(() => auditMainSettlements({ ...source, settlements: {} }), /invalid main settlements/);
  assert.throws(() => auditMainSettlements({ ...source, settlements: [source.settlements[0], source.settlements[0]] }), /duplicate/);
});

it("rejects duplicate ledger IDs across settlement and other postings", () => {
  const source = fixture();
  source.ledger.push({ ...source.ledger[0]!, type: "payment" });
  assert.throws(() => auditMainSettlements(source), /duplicate main settlement ledger ID/);
});

it("rejects empty and duplicate merchant identities", () => {
  const source = fixture();
  assert.throws(() => auditMainSettlements({ ...source, merchants: [{ id: "" }] }), /invalid or duplicate main settlement merchant/);
  assert.throws(() => auditMainSettlements({ ...source, merchants: [...source.merchants, source.merchants[0]] }), /invalid or duplicate main settlement merchant/);
});
