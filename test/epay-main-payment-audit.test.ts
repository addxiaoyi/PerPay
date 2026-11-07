import assert from "node:assert/strict";
import { it } from "node:test";
import { auditMainPayments } from "../src/epay-compat/main-payment-audit.ts";

it("flags unrecognized order states rather than treating them as unpaid", () => {
  const order = { id: "order", merchantId: "merchant", status: "PAID" };
  const report = auditMainPayments({ merchants: [{ id: "merchant" }], orders: [order], ledger: [] });
  assert.equal(report.unknownOrderStatuses, 1);
  for (const status of ["pending_sync", "pending_payment", "failed", "closed", "expired", "paid", "refund_processing", "refunded"]) {
    assert.equal(auditMainPayments({ orders: [{ ...order, status }], ledger: [] }).unknownOrderStatuses, 0);
  }
  assert.equal(auditMainPayments({ orders: [{ ...order, status: "expired", paidAt: "2024-01-01T00:00:00Z" }], ledger: [] }).unpaidWithPaidAt, 1);
  assert.equal(auditMainPayments({ orders: [{ ...order, status: "expired", paidAt: null }], ledger: [] }).unpaidWithPaidAt, 0);
  for (const paidAt of [undefined, null, "", "not-a-date", "2024-02-30T00:00:00Z", "2024-01-01 00:00:00", 123]) {
    assert.equal(auditMainPayments({ orders: [{ ...order, status: "paid", paidAt }], ledger: [] }).paidWithInvalidPaidAt, 1);
  }
  assert.equal(auditMainPayments({ orders: [{ ...order, status: "paid", paidAt: "2024-01-01T00:00:00Z" }], ledger: [] }).paidWithInvalidPaidAt, 0);
  for (const status of ["refund_processing", "refunded"]) {
    assert.equal(auditMainPayments({ orders: [{ ...order, status }], ledger: [] }).refundOrdersRequireReconciliation, 1);
  }
  assert.equal(auditMainPayments({ orders: [{ ...order, status: "paid", refundStatus: "pending" }], ledger: [] }).refundOrdersRequireReconciliation, 1);
  assert.equal(auditMainPayments({ orders: [], ledger: [] }).refundRecordsRequireReconciliation, null);
  assert.equal(auditMainPayments({ orders: [], ledger: [], refunds: [] }).refundRecordsRequireReconciliation, 0);
  assert.equal(auditMainPayments({ orders: [], ledger: [], refunds: [{ id: "refund" }] }).refundRecordsRequireReconciliation, 1);
  assert.throws(() => auditMainPayments({ orders: [], ledger: [], refunds: null }), /refunds are invalid/);
});

const order = { id: "o", merchantId: "m", status: "paid", amountCents: 1000, platformFeeCents: 50, merchantNetCents: 950 };
const entry = { id: "l", merchantId: "m", type: "payment_paid", orderId: "o", availableDelta: 950, frozenDelta: 0, grossCents: 1000, platformFeeCents: 50, merchantNetCents: 950 };

it("checks exact recorded fees and postings without claiming reconciliation", () => {
  const report = auditMainPayments({ orders: [order], ledger: [entry] });
  assert.equal(report.amountMismatch, 0);
  assert.equal(report.financiallyReconciled, false);
  assert.equal(auditMainPayments({ orders: [{ ...order, status: "refunded" }], ledger: [entry] }).ledgerForNonPaid, 0);
});

it("reports orphan, duplicate, missing, cross-merchant and mismatched postings", () => {
  const report = auditMainPayments({ orders: [order, { ...order, id: "missing" }, { ...order, id: "pending", status: "pending_payment" }], ledger: [
    entry, { ...entry, id: "l2", merchantId: "other", availableDelta: 1 },
    { ...entry, id: "l3", orderId: "pending" }, { ...entry, id: "l4", orderId: "unknown" }, { ...entry, id: "l5", orderId: undefined },
  ] });
  assert.equal(report.paidWithoutLedger, 1);
  assert.equal(report.duplicateLedger, 1);
  assert.equal(report.merchantMismatch, 1);
  assert.equal(report.amountMismatch, 1);
  assert.equal(report.orphanOrderReference, 1);
  assert.equal(report.missingOrderReference, 1);
  assert.equal(report.ledgerForNonPaid, 1);
});

it("requires the original payment posting for refunded and refund-processing orders", () => {
  for (const status of ["refunded", "refund_processing"]) {
    const historicalOrder = { ...order, status };
    assert.equal(auditMainPayments({ orders: [historicalOrder], ledger: [] }).paidWithoutLedger, 1);
    const report = auditMainPayments({ orders: [historicalOrder], ledger: [entry] });
    assert.equal(report.paidWithoutLedger, 0);
    assert.equal(report.ledgerForNonPaid, 0);
  }
});

it("reports orders whose merchant is absent from the source snapshot", () => {
  const pending = { ...order, status: "pending_payment" };
  assert.equal(auditMainPayments({ orders: [pending], ledger: [] }).missingOrderMerchantReferences, null);
  assert.equal(auditMainPayments({ merchants: [], orders: [pending], ledger: [] }).missingOrderMerchantReferences, 1);
  assert.equal(auditMainPayments({ merchants: [{ id: "m" }], orders: [pending], ledger: [] }).missingOrderMerchantReferences, 0);
  assert.throws(() => auditMainPayments({ merchants: [{ id: "m" }, { id: "m" }], orders: [], ledger: [] }), /duplicate main merchant/);
});

it("fails closed on duplicated IDs and flags imprecise or absent historical amounts", () => {
  assert.throws(() => auditMainPayments({ orders: [order, order], ledger: [] }), /duplicate main order/);
  assert.throws(() => auditMainPayments({ orders: [order], ledger: [entry, entry] }), /duplicate main ledger entry/);
  assert.equal(auditMainPayments({ orders: [{ ...order, platformFeeCents: undefined }], ledger: [entry] }).invalidAmounts, 1);
});

it("checks unpaid order amounts without relying on a ledger entry", () => {
  const pending = { ...order, status: "pending_payment" };
  for (const changes of [{ amountCents: 0 }, { amountCents: 1.5 }, { platformFeeCents: undefined }, { merchantNetCents: -1 }]) {
    assert.equal(auditMainPayments({ orders: [{ ...pending, ...changes }], ledger: [] }).invalidOrderAmounts, 1);
  }
  assert.equal(auditMainPayments({ orders: [{ ...pending, merchantNetCents: 951 }], ledger: [] }).orderAmountMismatches, 1);
  assert.equal(auditMainPayments({ orders: [pending], ledger: [] }).invalidOrderAmounts, 0);
});
