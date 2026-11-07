import assert from "node:assert/strict";
import { it } from "node:test";
import { auditOrderLinks } from "../src/epay-compat/order-link-audit.ts";

const bindings = [{ mainMerchantId: "a", epayMerchantId: 1 }, { mainMerchantId: "b", epayMerchantId: 2 }];
const main = { id: "main", merchantId: "a", merchantOrderId: "same", amountCents: 1001, status: "paid" };
const epay = { tradeNo: "epay", merchantId: 1, outTradeNo: "same", money: "10.01", status: "PAID" };

it("compares only within an explicit merchant binding and never declares reconciliation", () => {
  const audit = auditOrderLinks(bindings, [main], [epay, { ...epay, tradeNo: "other", merchantId: 2 }]);
  assert.equal(audit.matched, 1);
  assert.equal(audit.snapshotsComparable, false);
  assert.deepEqual(audit.issues, [{ code: "epay_order_without_main_match", id: "other" }]);
});

it("reports ambiguity instead of choosing an order", () => {
  const audit = auditOrderLinks(bindings, [main, { ...main, id: "second" }], [epay]);
  assert.equal(audit.matched, 0);
  assert.deepEqual(audit.issues.map((issue) => issue.code), ["ambiguous_main_order", "ambiguous_main_order", "ambiguous_epay_order"]);
});

it("reports differences and unbound orders without using amounts to infer ownership", () => {
  const audit = auditOrderLinks(bindings, [main, { ...main, id: "unknown", merchantId: "unknown" }], [{ ...epay, money: "10.02", status: "PENDING" }]);
  assert.deepEqual(audit.issues.map((issue) => issue.code), ["unbound_main_order", "order_amount_mismatch", "order_status_difference"]);
});

it("rejects invalid money and conflicting bindings", () => {
  assert.throws(() => auditOrderLinks(bindings, [main], [{ ...epay, money: "10.001" }]));
  assert.throws(() => auditOrderLinks([...bindings, { mainMerchantId: "c", epayMerchantId: 1 }], [], []), /binding/);
});

it("counts internal order ID candidates only within a binding and checks exact amounts", () => {
  const matching = { ...epay, outTradeNo: "main" };
  assert.deepEqual(auditOrderLinks(bindings, [main], [matching]).projectionCandidates, { sameAmount: 1, amountMismatch: 0, ambiguous: 0 });
  assert.deepEqual(auditOrderLinks(bindings, [main], [{ ...matching, money: "10.02" }]).projectionCandidates, { sameAmount: 0, amountMismatch: 1, ambiguous: 0 });
  assert.deepEqual(auditOrderLinks(bindings, [main], [{ ...matching, merchantId: 2 }]).projectionCandidates, { sameAmount: 0, amountMismatch: 0, ambiguous: 0 });
  assert.deepEqual(auditOrderLinks(bindings, [main], [matching, { ...matching, tradeNo: "duplicate" }]).projectionCandidates, { sameAmount: 0, amountMismatch: 0, ambiguous: 1 });
});

it("reports provider transaction leads only within a binding without assigning orders", () => {
  const left = { ...main, tradeNo: "provider-transaction" };
  const right = { ...epay, outTradeNo: "different", apiTradeNo: "provider-transaction" };
  const result = auditOrderLinks(bindings, [left], [right]);
  assert.deepEqual(result.providerCandidates, { sameAmount: 1, amountMismatch: 0, ambiguous: 0 });
  assert.equal(result.matched, 0);
  assert.deepEqual(auditOrderLinks(bindings, [left], [{ ...right, money: "10.02" }]).providerCandidates, { sameAmount: 0, amountMismatch: 1, ambiguous: 0 });
  assert.deepEqual(auditOrderLinks(bindings, [left], [{ ...right, merchantId: 2 }]).providerCandidates, { sameAmount: 0, amountMismatch: 0, ambiguous: 0 });
  assert.deepEqual(auditOrderLinks(bindings, [left, { ...left, id: "other" }], [right]).providerCandidates, { sameAmount: 0, amountMismatch: 0, ambiguous: 1 });
  assert.deepEqual(auditOrderLinks(bindings, [left], [right, { ...right, tradeNo: "other" }]).providerCandidates, { sameAmount: 0, amountMismatch: 0, ambiguous: 1 });
  assert.deepEqual(auditOrderLinks(bindings, [left], [{ ...right, apiTradeNo: " provider-transaction " }]).providerCandidates, { sameAmount: 0, amountMismatch: 0, ambiguous: 0 });
});

it("counts cross-merchant provider ID leads, including unbound merchants, without linking orders", () => {
  const left = { ...main, tradeNo: "provider-id" };
  const right = { ...epay, apiTradeNo: "provider-id" };
  const report = auditOrderLinks(bindings, [left, { ...left, id: "unbound", merchantId: "unknown" }], [right, { ...right, tradeNo: "unbound-epay", merchantId: 3 }]);
  assert.deepEqual(report.providerCrossMerchantLeads, { main: 1, epay: 1 });
  assert.equal(report.matched, 1);
  assert.ok(report.issues.some(issue => issue.code === "unbound_main_order"));
  assert.ok(report.issues.some(issue => issue.code === "unbound_epay_order"));
  assert.deepEqual(auditOrderLinks(bindings, [left, { ...left, id: "same-owner" }], [right, { ...right, tradeNo: "same-owner" }]).providerCrossMerchantLeads, { main: 0, epay: 0 });
  assert.throws(() => auditOrderLinks(bindings, [{ ...left, merchantId: "unknown", tradeNo: 1 as never }], []), /provider transaction ID/);
  assert.throws(() => auditOrderLinks(bindings, [], [{ ...right, merchantId: 3, apiTradeNo: 1 as never }]), /provider transaction ID/);
});

it("flags possible legacy balance window truncation per bound merchant", () => {
  const mainOrders = Array.from({ length: 100 }, (_, i) => ({ ...main, id: `main-${i}`, merchantOrderId: `order-${i}` }));
  const epayOrders = Array.from({ length: 1000 }, (_, i) => ({ ...epay, tradeNo: `epay-${i}`, outTradeNo: `order-${i}` }));
  const codes = (left: typeof mainOrders, right: typeof epayOrders) => auditOrderLinks(bindings, left, right).issues.filter((issue) => issue.code.startsWith("legacy_"));
  assert.deepEqual(codes(mainOrders.slice(0, 99), epayOrders.slice(0, 999)), []);
  assert.deepEqual(codes(mainOrders, epayOrders), [
    { code: "legacy_main_order_window_may_truncate", id: "a" },
    { code: "legacy_epay_paid_window_may_truncate", id: "1" },
  ]);
  assert.deepEqual(codes(mainOrders, epayOrders.map((order) => ({ ...order, status: "PENDING" }))), [
    { code: "legacy_main_order_window_may_truncate", id: "a" },
  ]);
});
