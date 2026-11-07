import assert from "node:assert/strict";
import { it } from "node:test";
import { auditUnboundTradeEvidence } from "../src/epay-compat/unbound-trade-audit.ts";

it("summarizes exact transaction IDs without assigning ownership", () => {
  const mainOrders = [{ tradeNo: "exact", amountCents: 101 }, { tradeNo: "wrong", amountCents: 99 }, { tradeNo: "duplicate", amountCents: 100 }, { tradeNo: "duplicate", amountCents: 100 }];
  const legacyOrders = [{ merchantId: 1, apiTradeNo: "exact", money: "1.01" }, { merchantId: 1, apiTradeNo: "wrong", money: "1.01" }, { merchantId: 1, apiTradeNo: "duplicate", money: "1.00" }, { merchantId: 1, apiTradeNo: "missing", money: "1.00" }, { merchantId: 1, apiTradeNo: null, money: "1.00" }, { merchantId: 2, apiTradeNo: "exact", money: "1.01" }];
  const report = auditUnboundTradeEvidence({ mainOrders, legacyOrders, boundLegacyIds: [2] });
  assert.deepEqual(report, { unboundOrders: 5, withoutTradeId: 1, withTradeId: 4, noMainMatch: 1, uniqueExactAmount: 0, uniqueAmountMismatch: 1, ambiguousTradeId: 2, provesOwnership: false, providerVerified: false, coordinatedSnapshot: false });
  assert.equal(auditUnboundTradeEvidence({ mainOrders, legacyOrders: legacyOrders.slice(0, -1), boundLegacyIds: [2] }).uniqueExactAmount, 1);
  assert.doesNotMatch(JSON.stringify(report), /exact|duplicate|missing/);
  assert.throws(() => auditUnboundTradeEvidence({ mainOrders: [{ tradeNo: "x", amountCents: 1.5 }], legacyOrders, boundLegacyIds: [] }), /amount/);
});
