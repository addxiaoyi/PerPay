import assert from "node:assert/strict";
import { it } from "node:test";
import { auditLightpayHistory } from "../src/epay-compat/lightpay-history-audit.ts";

it("counts historical identity evidence once per missing bridge order", () => {
  const current = { merchants: [], orders: [] };
  const bridge = [{ id: "one", merchantId: "old", amount: "1.23" }];
  const previous = { merchants: [{ id: "old" }], orders: [{ id: "one", merchantId: "old", amountCents: 123 }] };
  const audit = auditLightpayHistory(current, [previous, previous], bridge);
  assert.deepEqual(audit.evidence, { missingBoth: 1, historicMerchant: 1, historicOrderId: 1, exactOrderCandidate: 1, conflictingOrderEvidence: 0 });
  assert.equal(audit.snapshotsComparable, false);
});

it("keeps conflicting history separate and rejects duplicates", () => {
  const current = { merchants: [], orders: [] };
  const bridge = [{ id: "one", merchantId: "old", amount: "1.23" }];
  const previous = { merchants: [], orders: [{ id: "one", merchantId: "other", amountCents: 123 }] };
  assert.equal(auditLightpayHistory(current, [previous], bridge).evidence.conflictingOrderEvidence, 1);
  assert.throws(() => auditLightpayHistory(current, [previous], [...bridge, ...bridge]), /duplicate/);
});
