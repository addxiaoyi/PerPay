import assert from "node:assert/strict";
import { it } from "node:test";
import { auditMainInvoiceFees } from "../src/epay-compat/main-invoice-audit.ts";

const snapshot = () => ({ orders: [{ id: "order", merchantId: "merchant", status: "paid" }],
  invoiceApplications: [{ id: "invoice", orderId: "order", merchantId: "merchant", feeCents: 5, status: "pending" }],
  ledger: [{ id: "fee", type: "invoice_fee", invoiceApplicationId: "invoice", orderId: "order", merchantId: "merchant", grossCents: 5, availableDelta: -5, frozenDelta: 0 }] });

it("matches each historical invoice fee to exactly one application, merchant and paid order", () => {
  assert.deepEqual(auditMainInvoiceFees(snapshot()), []);
  const free = snapshot(); free.invoiceApplications[0]!.feeCents = 0; free.ledger = [];
  assert.deepEqual(auditMainInvoiceFees(free), []);
  for (const mutate of [
    (source: ReturnType<typeof snapshot>) => { source.ledger[0]!.merchantId = "other"; },
    (source: ReturnType<typeof snapshot>) => { source.ledger[0]!.availableDelta = -4; },
    (source: ReturnType<typeof snapshot>) => { source.ledger[0]!.orderId = "other"; },
    (source: ReturnType<typeof snapshot>) => { source.ledger.push({ ...source.ledger[0]!, id: "duplicate" }); },
    (source: ReturnType<typeof snapshot>) => { source.ledger = []; },
    (source: ReturnType<typeof snapshot>) => { source.orders[0]!.status = "pending_payment"; },
  ]) { const source = snapshot(); mutate(source); assert.ok(auditMainInvoiceFees(source).length > 0); }
});
