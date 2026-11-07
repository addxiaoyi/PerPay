import assert from "node:assert/strict";
import { it } from "node:test";
import { auditCallbackTargets } from "../src/epay-compat/callback-target-audit.ts";

it("counts incompatible callback targets without exposing merchant IDs or URLs", () => {
  const report = auditCallbackTargets([
    { merchantId: 1, notifyUrl: "https://example.test/callback?x=1", status: "PENDING" },
    { merchantId: 1, notifyUrl: "http://example.test/private", status: "PENDING" },
    { merchantId: 1, notifyUrl: "https://user:pass@example.test/private", status: "PAID" },
    { merchantId: 2, notifyUrl: "https://127.0.0.1/private", status: "PENDING" },
    { merchantId: 2, notifyUrl: "not a URL", status: "CLOSED" },
    { merchantId: 3, notifyUrl: "https://example.test/callback?%73ign=old", status: "PENDING" },
  ]);
  assert.deepEqual(report, { incompatibleOrders: 5, pendingIncompatibleOrders: 3, affectedMerchants: 3, dnsVerified: false, deliveryVerified: false });
  assert.doesNotMatch(JSON.stringify(report), /example|private|user|pass/);
  assert.throws(() => auditCallbackTargets([{ merchantId: 1, notifyUrl: null, status: "PENDING" }]), /invalid callback audit order/);
});
