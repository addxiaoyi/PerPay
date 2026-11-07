import assert from "node:assert/strict";
import { it } from "node:test";
import { auditAssociatedEvidence } from "../scripts/audit-lightpay-associated-evidence.mjs";

it("counts only exact evidence for orders missing both current merchant and order", () => {
  const payment = { merchants: [{ id: "known" }], orders: [{ id: "existing" }] };
  const bridge = { orders: [
    { id: "missing", merchantId: "old", siteId: 1, siteMerchantId: "known", providerTradeNo: "provider", callbackCount: 1 },
    { id: "existing", merchantId: "old", siteId: null, siteMerchantId: null, providerTradeNo: null, callbackCount: 0 },
    { id: "known-owner", merchantId: "known", siteId: null, siteMerchantId: null, providerTradeNo: null, callbackCount: 0 },
  ], ledger: [{ orderId: "missing", userId: "old" }, { orderId: "missing", userId: "known" }] };
  const report = auditAssociatedEvidence(payment, bridge);
  assert.deepEqual(report.counts, { unmatchedOrders: 1, withSite: 1, withSiteMerchant: 1, siteMatchesBridgeMerchant: 0, siteMerchantKnownMain: 1, withLedger: 1, ledgerMerchantMatchesBridge: 1, ledgerMerchantKnownMain: 1, withCallbackAttempts: 1, withProviderTradeNumber: 1 });
  assert.equal(report.ownershipProven, false);
  assert.equal(JSON.stringify(report).includes("provider"), false);
});
