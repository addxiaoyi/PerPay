import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeUnboundOrders } from "../scripts/unbound-order-summary.mjs";

test("summarizes unbound records without disclosing identifiers or assigning ownership", () => {
  const tables = {
    MerchantBinding: [{ epayMerchantId: 2 }],
    Order: [{ tradeNo: "private-a", merchantId: 1, status: "PAID", apiTradeNo: "provider" }, { tradeNo: "private-b", merchantId: 2, status: "PENDING" }, { tradeNo: "private-c", merchantId: 1, status: "unexpected" }],
    NotifyLog: [{ tradeNo: "private-a" }, { tradeNo: "private-b" }],
    Invoice: [{ merchantId: 1, tradeNo: "private-a" }, { merchantId: 1, tradeNo: "private-b" }, { merchantId: 1, tradeNo: "missing" }],
    InvoiceApplication: [{ merchantId: 2, tradeNo: "private-b" }],
  };
  const summary = summarizeUnboundOrders(tables);
  assert.deepEqual(summary, { orders: 2, statuses: { PENDING: 0, PAID: 1, CLOSED: 0, other: 1 }, withProviderReference: 1, notifications: 1, invoices: { rows: 3, matchingOrder: 1, missingOrder: 1, merchantMismatch: 1 }, applications: { rows: 0, matchingOrder: 0, missingOrder: 0, merchantMismatch: 0 }, ownershipProven: false, providerVerified: false });
  assert.doesNotMatch(JSON.stringify(summary), /private|provider"/);
  assert.throws(() => summarizeUnboundOrders({ ...tables, MerchantBinding: [{ epayMerchantId: 2 }, { epayMerchantId: 2 }] }), /duplicate/);
  assert.throws(() => summarizeUnboundOrders({ ...tables, Order: [...tables.Order, tables.Order[0]] }), /duplicate/);
  assert.throws(() => summarizeUnboundOrders({ ...tables, MerchantBinding: [{ epayMerchantId: "2" }] }), /identifier/);
});
