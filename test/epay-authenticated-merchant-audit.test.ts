import assert from "node:assert/strict";
import { it } from "node:test";
import { auditAuthenticatedMerchantSnapshot } from "../src/epay-compat/authenticated-merchant-audit.ts";

const fixture = () => ({
  payment: { merchants: [{ id: "main-secret", apiId: "api-secret", feeRate: 0.05 }], ledger: [], orders: [] },
  tables: {
    Merchant: [{ id: 10, money: "1.00" }, { id: 11, money: "0.00" }],
    MerchantBinding: [{ mainMerchantId: "main-secret", mainApiId: "api-secret", epayMerchantId: 10 }],
    Order: [{ tradeNo: "order-secret", outTradeNo: "external-secret", apiTradeNo: null, merchantId: 11, money: "1.00", status: "PAID" }],
    Invoice: [],
    InvoiceApplication: [],
  },
});

it("reports ownership gaps without exposing identifiers or balances", () => {
  const { payment, tables } = fixture();
  const report = auditAuthenticatedMerchantSnapshot(payment, tables);
  assert.equal(report.issues.unbound_order, 1);
  assert.equal(report.orderLinks.issues.unbound_epay_order, 1);
  assert.equal(report.productionReady, false);
  assert.equal(report.financiallyReconciled, false);
  assert.doesNotMatch(JSON.stringify(report), /secret|1\.00/);
});

it("rejects incomplete and malformed snapshot rows", () => {
  const { payment, tables } = fixture();
  assert.throws(() => auditAuthenticatedMerchantSnapshot(payment, { ...tables, InvoiceApplication: undefined as never }), /missing snapshot table/);
  assert.throws(() => auditAuthenticatedMerchantSnapshot(payment, { ...tables, Order: [{ ...tables.Order[0]!, apiTradeNo: undefined }] }), /invalid snapshot apiTradeNo/);
  assert.throws(() => auditAuthenticatedMerchantSnapshot(payment, { ...tables, Merchant: [{ id: "1.5", money: "1.00" }] }), /invalid snapshot id/);
});

it("exposes only the count of cross-merchant provider ID leads", () => {
  const { payment, tables } = fixture();
  const orders = [
    { ...tables.Order[0]!, apiTradeNo: "provider-secret", merchantId: 10 },
    { ...tables.Order[0]!, tradeNo: "other-secret", apiTradeNo: "provider-secret", merchantId: 11 },
  ];
  const report = auditAuthenticatedMerchantSnapshot(payment, { ...tables, Order: orders });
  assert.deepEqual(report.orderLinks.providerCrossMerchantLeads, { main: 0, epay: 1 });
  assert.doesNotMatch(JSON.stringify(report), /secret/);
  assert.equal(report.productionReady, false);
});

it("counts duplicate merchant order numbers without exposing identifiers", () => {
  const { payment, tables } = fixture();
  const first = tables.Order[0]!;
  const report = auditAuthenticatedMerchantSnapshot(payment, { ...tables, Order: [first, { ...first, tradeNo: "second-secret" }] });
  assert.equal(report.issues.duplicate_merchant_order_number, 2);
  assert.doesNotMatch(JSON.stringify(report), /secret/);
  assert.equal(report.productionReady, false);
});

it("reports invoice application order reference mismatches without exposing identifiers", () => {
  const { payment, tables } = fixture();
  const report = auditAuthenticatedMerchantSnapshot(payment, { ...tables, InvoiceApplication: [
    { id: "invoice-secret", tradeNo: "order-secret", outTradeNo: "wrong-secret", merchantId: 11 },
  ] });
  assert.equal(report.issues.invoice_application_order_reference_mismatch, 1);
  assert.doesNotMatch(JSON.stringify(report), /secret/);
  assert.throws(() => auditAuthenticatedMerchantSnapshot(payment, { ...tables, InvoiceApplication: [
    { id: "invoice-secret", tradeNo: "order-secret", merchantId: 11 },
  ] }), /invalid snapshot outTradeNo/);
});

it("counts invoice amount differences without exposing amounts or identifiers", () => {
  const { payment, tables } = fixture();
  const report = auditAuthenticatedMerchantSnapshot(payment, { ...tables, Invoice: [
    { id: "invoice-secret", tradeNo: "order-secret", merchantId: 11, amount: "0.50" },
    { id: "invalid-secret", tradeNo: "order-secret", merchantId: 11, amount: "1.001" },
    { id: "missing-secret", tradeNo: "order-secret", merchantId: 11 },
  ] });
  assert.equal(report.issues.invoice_order_amount_difference, 1);
  assert.equal(report.issues.invoice_amount_invalid, 1);
  assert.equal(report.issues.invoice_amount_unavailable, 1);
  assert.doesNotMatch(JSON.stringify(report), /secret|0\.50|1\.001/);
  assert.equal(report.financiallyReconciled, false);
});
