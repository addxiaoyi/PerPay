import assert from "node:assert/strict";
import { it } from "node:test";

import { auditMainLedger } from "../src/epay-compat/main-ledger-audit.ts";

it("reconstructs separate available and frozen balances from main-site entries", () => {
  const result = auditMainLedger({ merchants: [{ id: "merchant-a", feeRate: 0.05 }, { id: "merchant-b", feeRate: 0.05123 }], ledger: [
    { id: "a", merchantId: "merchant-a", availableDelta: 1000, frozenDelta: 0 },
    { id: "b", merchantId: "merchant-a", availableDelta: -300, frozenDelta: 300 },
    { id: "c", merchantId: "orphan", availableDelta: 1, frozenDelta: 0 },
  ] });
  assert.deepEqual(result.balances, [{ merchantId: "merchant-a", availableCents: 700, frozenCents: 300 }, { merchantId: "merchant-b", availableCents: 0, frozenCents: 0 }]);
  assert.equal(result.missingMerchantReferences, 1);
  assert.equal(result.unsupportedFeePrecision, 1);
  assert.equal(result.summaryMismatches, null);
});

it("compares versioned balance summaries with the entire ledger without assuming an absent cache is zero", () => {
  const store = { merchants: [{ id: "m", feeRate: 0.05 }, { id: "empty", feeRate: 0 }], ledger: [{ id: "entry", merchantId: "m", availableDelta: 100, frozenDelta: -20 }], balanceSummaryVersion: 1, balanceSummaries: { m: { availableCents: 100, frozenCents: -20 } } };
  assert.equal(auditMainLedger(store).summaryMismatches, 0);
  assert.equal(auditMainLedger({ ...store, balanceSummaries: {} }).summaryMismatches, 1);
  assert.equal(auditMainLedger({ ...store, balanceSummaries: { m: { availableCents: 101, frozenCents: -20 }, orphan: { availableCents: 0, frozenCents: 0 } } }).summaryMismatches, 2);
  assert.throws(() => auditMainLedger({ ...store, balanceSummaries: { m: { availableCents: 100.5, frozenCents: 0 } } }), /balance summary is invalid/);
  assert.throws(() => auditMainLedger({ ...store, balanceSummaries: null }), /summaries are invalid/);
  assert.equal(auditMainLedger({ ...store, balanceSummaryVersion: 0 }).summaryMismatches, null);
});

it("rejects malformed records and duplicate entries instead of inventing balances", () => {
  const merchant = { id: "m", feeRate: 0.05 };
  const entry = { id: "entry", merchantId: "m", availableDelta: 100, frozenDelta: 0 };
  assert.throws(() => auditMainLedger({ merchants: [merchant], ledger: [entry, entry] }), /duplicate ledger ID/);
  assert.throws(() => auditMainLedger({ merchants: [merchant], ledger: [{ ...entry, availableDelta: 0.1 }] }), /invalid ledger entry/);
  assert.throws(() => auditMainLedger({ merchants: [merchant] }), /missing merchants or ledger/);
});
