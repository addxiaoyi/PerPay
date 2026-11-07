import assert from "node:assert/strict";
import { it } from "node:test";
import { auditUnboundCallbackEvidence } from "../src/epay-compat/unbound-callback-audit.ts";

it("summarizes exact callback leads without assigning merchants or revealing URLs", () => {
  const input = {
    merchants: [{ id: "a", username: "owner-a", callbackUrl: "https://merchant.test/callback?secret=x" }, { id: "b", displayName: "owner-b", callbackUrl: "https://shared.test/hook" }, { id: "c", callbackUrl: "https://shared.test/hook" }],
    orders: [{ merchantId: "a", notifyUrl: "https://old.test/hook" }, { merchantId: "missing", notifyUrl: "https://unowned.test/hook" }],
    legacyOrders: [{ merchantId: 1, notifyUrl: "https://old.test/hook" }, { merchantId: 1, notifyUrl: "https://merchant.test/callback?secret=x" }, { merchantId: 2, notifyUrl: "https://shared.test/hook" }, { merchantId: 3, notifyUrl: "http://old.test/hook" }, { merchantId: 4, notifyUrl: "https://old.test/hook" }],
    legacyMerchants: [{ id: 1, name: "owner-a" }, { id: 2, name: "owner-b" }, { id: 3, name: "unknown" }, { id: 4, name: "owner-a" }],
    boundLegacyIds: [4],
  };
  const report = auditUnboundCallbackEvidence(input);
  assert.deepEqual(report, { unboundMerchants: 3, unboundOrders: 4, withUniqueCandidate: 1, withMultipleCandidates: 1, withoutCandidate: 1, usableCallbackUrls: 3, nameOnlyUnique: 2, nameOnlyMultiple: 0, nameNoMatch: 1, callbackAndNameUnique: 2, callbackAndNameMultiple: 0, callbackAndNameNoMatch: 1, provesOwnership: false, coordinatedSnapshot: false });
  assert.doesNotMatch(JSON.stringify(report), /merchant\.test|secret|old\.test/);
  assert.throws(() => auditUnboundCallbackEvidence({ ...input, boundLegacyIds: [4, 4] }), /binding/);
  assert.throws(() => auditUnboundCallbackEvidence({ ...input, merchants: [input.merchants[0]!, input.merchants[0]!] }), /duplicate/);
});
