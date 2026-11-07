import assert from "node:assert/strict";
import { it } from "node:test";
import { auditLightpayOrders } from "../src/epay-compat/lightpay-audit.ts";

const merchants = [{ id: "m1" }, { id: "m2" }];
const orders = [{ id: "order", merchantId: "m1", amountCents: 123 }];

it("checks identity and exact amounts without declaring settlement", () => {
  const report = auditLightpayOrders(merchants, orders, [
    { id: "order", merchantId: "m1", amount: "1.23" },
    { id: "missing", merchantId: "m1", amount: "1.23" },
    { id: "unassigned", merchantId: null, amount: "1.23" },
  ]);
  assert.deepEqual(report.counts, { bridgeOrders: 3, missingMerchant: 1, unknownMerchant: 0, noMainOrder: 1, merchantMismatch: 0, amountMismatch: 0, candidates: 1 });
  assert.equal(report.snapshotsComparable, false);
});

it("does not associate different merchants or amounts", () => {
  assert.equal(auditLightpayOrders(merchants, orders, [{ id: "order", merchantId: "m2", amount: "1.23" }]).counts.merchantMismatch, 1);
  assert.equal(auditLightpayOrders(merchants, orders, [{ id: "order", merchantId: "m1", amount: "1.24" }]).counts.amountMismatch, 1);
  assert.equal(auditLightpayOrders([], orders, [{ id: "order", merchantId: "m1", amount: "1.23" }]).counts.candidates, 0);
});

it("fails closed on invalid amounts and duplicate identifiers", () => {
  assert.throws(() => auditLightpayOrders(merchants, orders, [{ id: "order", merchantId: "m1", amount: "1.001" }]));
  assert.throws(() => auditLightpayOrders(merchants, [...orders, orders[0]!], []), /duplicate/);
});

it("counts historical binding evidence without assigning ownership", () => {
  const bridge = [{ id: "missing", merchantId: "old", amount: "1.23" }];
  const report = auditLightpayOrders(merchants, orders, bridge, ["old"]);
  assert.deepEqual(report.historicEvidence, { unknownMerchantOrdersWithBinding: 1, missingMainOrdersWithBinding: 1 });
  assert.equal(report.counts.candidates, 0);
  assert.throws(() => auditLightpayOrders(merchants, orders, bridge, ["old", "old"]), /binding/);
});
