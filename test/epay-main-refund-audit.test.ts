import assert from "node:assert/strict";
import { it } from "node:test";
import { auditMainRefunds } from "../src/epay-compat/main-refund-audit.ts";

it("checks manual refund postings without claiming channel reconciliation", () => {
  const refund = { id: "refund", merchantId: "merchant", amountCents: 100, status: "recorded" };
  const entry = { id: "ledger", merchantId: "merchant", type: "manual_refund", refundId: "refund", availableDelta: -100, frozenDelta: 0 };
  const report = auditMainRefunds({ refunds: [refund], ledger: [entry] });
  assert.equal(report.unlinkedManualRefunds, 1);
  assert.equal(report.missingManualPostings, 0);
  assert.equal(report.mismatchedManualPostings, 0);
  assert.equal(report.channelRefundsVerified, false);
  assert.equal(report.financiallyReconciled, false);
  assert.equal(auditMainRefunds({ refunds: [refund], ledger: [] }).missingManualPostings, 1);
  assert.equal(auditMainRefunds({ refunds: [refund], ledger: [entry, { ...entry, id: "second" }] }).duplicateManualPostings, 1);
  assert.equal(auditMainRefunds({ refunds: [refund], ledger: [{ ...entry, merchantId: "other" }] }).mismatchedManualPostings, 1);
  assert.equal(auditMainRefunds({ refunds: [refund], ledger: [{ ...entry, availableDelta: -99 }] }).mismatchedManualPostings, 1);
  assert.equal(auditMainRefunds({ refunds: [{ ...refund, status: "pending_balance" }], ledger: [entry] }).unexpectedManualPostings, 1);
  assert.equal(auditMainRefunds({ refunds: [], ledger: [entry] }).orphanRefundReferences, 1);
  assert.equal(auditMainRefunds({ refunds: [], ledger: [{ ...entry, refundId: null }] }).missingRefundReferences, 1);
  assert.throws(() => auditMainRefunds({ refunds: [refund, refund], ledger: [] }), /duplicate main refund/);
});

it("reports recorded manual refunds that exceed their order without inferring channel settlement", () => {
  const order = { id: "order", merchantId: "merchant", amountCents: 100 };
  const refund = { id: "first", merchantId: "merchant", orderId: "order", amountCents: 60, status: "recorded" };
  const report = auditMainRefunds({ orders: [order], refunds: [refund, { ...refund, id: "second", amountCents: 41 }, { ...refund, id: "pending", amountCents: 99, status: "pending_balance" }], ledger: [] });
  assert.equal(report.oversizedRecordedRefundOrders, 1);
  assert.equal(report.missingOrderReferences, 0);
  assert.equal(report.unlinkedManualRefunds, 0);
  assert.equal(report.orderMerchantMismatches, 0);
  assert.equal(report.financiallyReconciled, false);
  assert.equal(auditMainRefunds({ refunds: [refund], ledger: [] }).oversizedRecordedRefundOrders, null);
  assert.equal(auditMainRefunds({ orders: [], refunds: [refund], ledger: [] }).missingOrderReferences, 1);
  assert.equal(auditMainRefunds({ orders: [{ ...order, merchantId: "other" }], refunds: [refund], ledger: [] }).orderMerchantMismatches, 1);
  assert.equal(auditMainRefunds({ orders: [order], refunds: [refund, { ...refund, id: "second", amountCents: 40 }], ledger: [] }).oversizedRecordedRefundOrders, 0);
  assert.throws(() => auditMainRefunds({ orders: [order, order], refunds: [], ledger: [] }), /duplicate main refund order/);
});
