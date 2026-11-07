import assert from "node:assert/strict";
import { it } from "node:test";
import { auditMerchantSnapshots } from "../src/epay-compat/merchant-audit.ts";

const input = () => ({
  mainPayment: { merchants: [{ id: "main-a", apiId: "api-a", feeRate: 0.05 }], ledger: [{ id: "entry", merchantId: "main-a", availableDelta: 75, frozenDelta: 25 }] },
  merchants: [{ id: 1001, money: "10.25" }, { id: 1002, money: "0.00" }],
  bindings: [{ mainMerchantId: "main-a", epayMerchantId: 1001, mainApiId: "api-a" }],
  orders: [{ tradeNo: "trade-a", outTradeNo: "outside-a", merchantId: 1001, money: "10.01", status: "PAID" }, { tradeNo: "trade-b", outTradeNo: "outside-b", merchantId: 1002, money: "1.00", status: "PENDING" }],
  invoices: [{ id: "invoice-a", tradeNo: "trade-a", merchantId: 1002, amount: "10.01" }, { id: "invoice-b", tradeNo: "missing", merchantId: 1001, amount: "1.00" }],
  invoiceApplications: [],
});

it("reports invoice amount leads without inferring issuance or ownership", () => {
  const fixture = input();
  const audit = auditMerchantSnapshots({ ...fixture, invoices: [
    { id: "same", tradeNo: "trade-a", merchantId: 1001, amount: "10.01" },
    { id: "different", tradeNo: "trade-a", merchantId: 1001, amount: "9.00" },
    { id: "negative", tradeNo: "trade-a", merchantId: 1001, amount: "-1.00" },
    { id: "precision", tradeNo: "trade-a", merchantId: 1001, amount: "1.001" },
    { id: "missing", tradeNo: "trade-a", merchantId: 1001 },
  ] });
  assert.ok(!audit.issues.some(issue => issue.id === "same"));
  assert.ok(audit.issues.some(issue => issue.id === "different" && issue.code === "invoice_order_amount_difference"));
  assert.equal(audit.issues.filter(issue => issue.code === "invoice_amount_invalid").length, 2);
  assert.ok(audit.issues.some(issue => issue.id === "missing" && issue.code === "invoice_amount_unavailable"));
  assert.equal(audit.snapshotsComparable, false);
});

it("flags duplicate external order numbers per merchant without merging across merchants", () => {
  const fixture = input();
  const audit = auditMerchantSnapshots({ ...fixture, orders: [
    { tradeNo: "one", outTradeNo: "same", merchantId: 1001, money: "1.00", status: "PAID" },
    { tradeNo: "two", outTradeNo: "same", merchantId: 1001, money: "1.00", status: "PAID" },
    { tradeNo: "other", outTradeNo: "same", merchantId: 1002, money: "1.00", status: "PAID" },
    { tradeNo: "missing", merchantId: 1001, money: "1.00", status: "PENDING" },
  ] });
  assert.deepEqual(audit.issues.filter(issue => issue.code === "duplicate_merchant_order_number").map(issue => issue.id), ["one", "two"]);
  assert.ok(audit.issues.some(issue => issue.code === "merchant_order_number_unavailable" && issue.id === "missing"));
  assert.equal(audit.snapshotsComparable, false);
});

it("distinguishes missing invoice applications from an empty collection", () => {
  const { invoiceApplications: _applications, ...withoutApplications } = input();
  const missing = auditMerchantSnapshots(withoutApplications);
  assert.ok(missing.issues.some((issue) => issue.code === "invoice_applications_unavailable"));
  assert.ok(!auditMerchantSnapshots(input()).issues.some((issue) => issue.code === "invoice_applications_unavailable"));
  assert.throws(() => auditMerchantSnapshots({ ...input(), invoiceApplications: null as never }), /invalid EPay invoice applications/);
});

it("summarizes bound merchants without declaring snapshots financially reconciled", () => {
  const result = auditMerchantSnapshots(input());
  assert.deepEqual(result.summaries[0], { mainMerchantId: "main-a", epayMerchantId: 1001, balance: { merchantId: "main-a", availableCents: 75, frozenCents: 25 }, epayRecordedBalanceCents: 1025, orderCount: 1, paidOrderCount: 1, paidOrderCents: 1001, invoiceCount: 1, invoiceApplicationCount: 0 });
  assert.equal(result.snapshotsComparable, false);
  assert.deepEqual(result.issues.map((issue) => issue.code), ["unbound_order", "invoice_merchant_mismatch", "unbound_invoice", "invoice_missing_order", "unbound_epay_merchant", "main_balance_summary_unverified", "main_settlements_unavailable"]);
});

it("counts invoices and applications separately and detects application ownership errors", () => {
  const fixture = input();
  const audit = auditMerchantSnapshots({ ...fixture, invoiceApplications: [
    { id: "invoice-b", tradeNo: "trade-a", merchantId: 1001 },
    { id: "application-mismatch", tradeNo: "trade-a", merchantId: 1002 },
  ] });
  assert.equal(audit.summaries[0]?.invoiceCount, 1);
  assert.equal(audit.summaries[0]?.invoiceApplicationCount, 1);
  assert.ok(audit.issues.some((issue) => issue.code === "invoice_application_merchant_mismatch"));
  assert.ok(audit.issues.some((issue) => issue.code === "unbound_invoice_application"));
});

it("detects mismatched or unavailable invoice application order references", () => {
  const fixture = input();
  const orders = fixture.orders.map(order => ({ ...order, outTradeNo: `external-${order.tradeNo}` }));
  const audit = auditMerchantSnapshots({ ...fixture, orders, invoiceApplications: [
    { id: "matching", tradeNo: "trade-a", merchantId: 1001, outTradeNo: "external-trade-a", feeCents: 100, status: "ISSUED" },
    { id: "mismatched", tradeNo: "trade-a", merchantId: 1001, outTradeNo: "external-trade-b" },
    { id: "missing", tradeNo: "trade-a", merchantId: 1001 },
  ] });
  assert.ok(audit.issues.some(issue => issue.code === "invoice_application_order_reference_mismatch" && issue.id === "mismatched"));
  assert.ok(audit.issues.some(issue => issue.code === "invoice_application_order_reference_unavailable" && issue.id === "missing"));
  assert.ok(!audit.issues.some(issue => issue.id === "matching"));
  assert.equal(audit.snapshotsComparable, false);
});

it("flags missing or invalid application fees and unknown states without calculating a balance", () => {
  const application = { tradeNo: "trade-a", merchantId: 1001, outTradeNo: "outside-a" };
  const audit = auditMerchantSnapshots({ ...input(), invoiceApplications: [
    { ...application, id: "valid", feeCents: 0, status: "ISSUING" },
    { ...application, id: "pending", feeCents: 0, status: "PENDING" },
    { ...application, id: "string", feeCents: "25", status: "FAILED" },
    { ...application, id: "missing" },
    { ...application, id: "invalid", feeCents: -1, status: "OTHER" },
    { ...application, id: "fraction", feeCents: 0.5, status: "UNKNOWN" },
  ] });
  assert.ok(!audit.issues.some(issue => issue.id === "valid"));
  assert.ok(!audit.issues.some(issue => issue.id === "pending"));
  assert.ok(!audit.issues.some(issue => issue.id === "string"));
  for (const [id, code] of [["missing", "invoice_application_fee_unavailable"], ["missing", "invoice_application_status_unavailable"], ["invalid", "invoice_application_fee_invalid"], ["invalid", "invoice_application_status_unrecognized"], ["fraction", "invoice_application_fee_invalid"]]) {
    assert.ok(audit.issues.some(issue => issue.id === id && issue.code === code));
  }
  assert.equal(audit.snapshotsComparable, false);
});

it("reports a mismatch between the cached balance and its ledger", () => {
  const fixture = input();
  const audit = auditMerchantSnapshots({ ...fixture, mainPayment: { ...fixture.mainPayment, balanceSummaryVersion: 1, balanceSummaries: { "main-a": { availableCents: 76, frozenCents: 25 } } } });
  assert.ok(audit.issues.some((issue) => issue.code === "main_balance_summary_mismatch" && issue.id === "1"));
});

it("includes settlement ownership and posting discrepancies in the merchant report", () => {
  const fixture = input();
  const payment = { ...fixture.mainPayment,
    settlements: [{ id: "settlement-a", merchantId: "main-a", amountCents: 25, status: "paid" }],
    ledger: [...fixture.mainPayment.ledger, { id: "settlement-freeze", merchantId: "main-a", type: "settlement_freeze", settlementId: "settlement-a", availableDelta: -25, frozenDelta: 25 }],
  };
  const report = auditMerchantSnapshots({ ...fixture, mainPayment: payment });
  assert.ok(report.issues.some(issue => issue.code === "main_settlement_posting_count_mismatch" && issue.id === "settlement-a"));
  assert.ok(!report.issues.some(issue => issue.code === "main_settlements_unavailable"));
  assert.equal(report.snapshotsComparable, false);
});

it("rejects duplicate identifiers, bindings and imprecise money", () => {
  const duplicate = input();
  duplicate.bindings.push({ mainMerchantId: "main-a", epayMerchantId: 1002, mainApiId: "api-a" });
  assert.throws(() => auditMerchantSnapshots(duplicate), /duplicate merchant binding/);
  const invalid = input();
  invalid.orders[0]!.money = "1.001";
  assert.throws(() => auditMerchantSnapshots(invalid));
});

it("reports missing or invalid recorded balances and missing binding identities", () => {
  const fixture = input();
  const audit = auditMerchantSnapshots({ ...fixture, merchants: [{ id: 1001 }, { id: 1002, money: "1.001" }], bindings: [{ mainMerchantId: "main-a", epayMerchantId: 1001 }] });
  assert.equal(audit.summaries[0]?.epayRecordedBalanceCents, null);
  assert.ok(audit.issues.some((issue) => issue.code === "epay_balance_unavailable" && issue.id === "1001"));
  assert.ok(audit.issues.some((issue) => issue.code === "epay_balance_invalid" && issue.id === "1002"));
  assert.ok(audit.issues.some((issue) => issue.code === "binding_api_id_unavailable"));
  assert.equal(audit.snapshotsComparable, false);
});

it("reports API identity mismatches without automatically reassigning a binding", () => {
  const fixture = input();
  const payment = fixture.mainPayment as { merchants: Array<{ id: string; feeRate: number; apiId?: string }>; ledger: typeof fixture.mainPayment.ledger };
  payment.merchants[0]!.apiId = "api-a";
  const mismatched = auditMerchantSnapshots({ ...fixture, bindings: [{ mainMerchantId: "main-a", epayMerchantId: 1001, mainApiId: "api-other" }] });
  assert.ok(mismatched.issues.some((issue) => issue.code === "binding_api_id_mismatch"));
  const missing = auditMerchantSnapshots({ ...fixture, bindings: [{ mainMerchantId: "deleted-id", epayMerchantId: 1001, mainApiId: "api-a" }] });
  assert.ok(missing.issues.some((issue) => issue.code === "missing_binding_api_id_matches_other_merchant"));
  assert.equal(missing.summaries[0]?.balance, null);
  const absent = auditMerchantSnapshots({ ...fixture, bindings: [{ mainMerchantId: "deleted-id", epayMerchantId: 1001, mainApiId: "api-absent" }] });
  assert.ok(absent.issues.some((issue) => issue.code === "missing_binding_api_id_not_found"));
});

it("reports unknown order states and zero-amount paid orders without inferring settlement", () => {
  const fixture = input();
  fixture.orders.push({ tradeNo: "unknown", outTradeNo: "unknown", merchantId: 1001, money: "3.00", status: "NEW_PROVIDER_STATE" });
  fixture.orders.push({ tradeNo: "zero", outTradeNo: "zero", merchantId: 1002, money: "0.00", status: "PAID" });
  const audit = auditMerchantSnapshots(fixture);
  assert.ok(audit.issues.some((issue) => issue.code === "unknown_order_status" && issue.id === "unknown"));
  assert.ok(audit.issues.some((issue) => issue.code === "zero_amount_paid_order" && issue.id === "zero"));
  assert.equal(audit.snapshotsComparable, false);
  const invalid = input();
  invalid.orders[0]!.merchantId = 0;
  assert.throws(() => auditMerchantSnapshots(invalid), /invalid or duplicate EPay order/);
});
