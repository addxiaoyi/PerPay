import assert from "node:assert/strict";
import { it } from "node:test";
import { auditMainSourceCoverage } from "../src/epay-compat/main-source-coverage.ts";

it("reports missing and unmapped historical collections without leaking records", () => {
  const payment = { merchants: [], orders: [], ledger: [], refunds: [], callbacks: [{ secret: "private" }], settlements: [{ id: "private-id" }], channels: {}, future: { token: "private" } };
  const report = auditMainSourceCoverage(payment);
  assert.deepEqual(report.unmappedCollections, [{ name: "settlements", count: 1 }, { name: "callbacks", count: 1 }]);
  assert.ok(report.missingCollections.includes("syncJobs"));
  assert.deepEqual(report.unknownFields, ["future"]);
  assert.equal(report.complete, false);
  assert.equal(report.financiallyReconciled, false);
  assert.doesNotMatch(JSON.stringify(report), /private/);
  assert.throws(() => auditMainSourceCoverage({ ...payment, settlements: {} }), /invalid main payment collection/);
  assert.throws(() => auditMainSourceCoverage(null), /invalid main payment source/);
});
