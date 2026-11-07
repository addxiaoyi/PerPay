import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planMainPaymentDelta } from "../src/epay-compat/main-delta.ts";

type Row = Record<string, unknown>;
type Snapshot = Record<string, unknown> & Record<"merchants" | "orders" | "ledger" | "refunds" | "settlements" | "callbacks" | "syncJobs" | "paymentEvents" | "orderMirrors" | "accessTokens" | "invoiceApplications", Row[]>;

function snapshot(overrides: Record<string, unknown> = {}): Snapshot {
  return {
    merchants: [{ id: "merchant-1", apiId: "api-1", feeRate: 0.05, enabled: true }],
    orders: [{ id: "order-1", merchantId: "merchant-1", amountCents: 1000, platformFeeCents: 50, merchantNetCents: 950, status: "pending_payment", createdAt: "2026-11-05T00:00:00.000Z" }],
    ledger: [], refunds: [], settlements: [], callbacks: [], syncJobs: [], paymentEvents: [], orderMirrors: [], accessTokens: [], invoiceApplications: [],
    ...overrides,
  };
}

describe("main payment delta planning", () => {
  it("returns only new records and safe operational updates", () => {
    const baseline = snapshot();
    const current = snapshot({
      orders: [{ ...baseline.orders[0], status: "paid", paidAt: "2026-11-05T00:01:00.000Z", tradeNo: "trade-1" }],
      ledger: [{ id: "ledger-1", merchantId: "merchant-1", type: "payment_paid", orderId: "order-1", availableDelta: 950, frozenDelta: 0 }],
      callbacks: [{ id: "callback-1", merchantId: "merchant-1", orderId: "order-1", status: "queued" }],
    });

    const delta = planMainPaymentDelta(baseline, current);

    assert.equal(delta.safe, true);
    assert.deepEqual(delta.collections.ledger.added.map(row => row.id), ["ledger-1"]);
    assert.deepEqual(delta.collections.callbacks.added.map(row => row.id), ["callback-1"]);
    assert.deepEqual(delta.collections.orders.changed.map(row => row.id), ["order-1"]);
    assert.deepEqual(delta.collections.orders.changed[0]?.columns, ["paidAt", "status", "tradeNo"]);
    assert.equal(delta.issues.length, 0);
  });

  it("blocks deletion or mutation of financial records", () => {
    const baseline = snapshot({ ledger: [{ id: "ledger-1", merchantId: "merchant-1", type: "payment_paid", availableDelta: 950, frozenDelta: 0 }] });
    const deleted = snapshot();
    assert.equal(planMainPaymentDelta(baseline, deleted).safe, false);
    assert.match(planMainPaymentDelta(baseline, deleted).issues[0]?.code ?? "", /record_removed/);

    const changed = snapshot({ ledger: [{ ...baseline.ledger[0], availableDelta: 1 }] });
    const result = planMainPaymentDelta(baseline, changed);
    assert.equal(result.safe, false);
    assert.ok(result.issues.some(issue => issue.code === "immutable_record_changed"));
  });

  it("blocks cross-merchant identity changes and financial order edits", () => {
    const baseline = snapshot();
    const moved = snapshot({ orders: [{ ...baseline.orders[0], merchantId: "merchant-2" }] });
    const changedAmount = snapshot({ orders: [{ ...baseline.orders[0], amountCents: 2000, merchantNetCents: 1900 }] });

    const movedResult = planMainPaymentDelta(baseline, moved);
    const amountResult = planMainPaymentDelta(baseline, changedAmount);
    assert.ok(movedResult.issues.some(issue => issue.code === "merchant_identity_changed"));
    assert.ok(amountResult.issues.some(issue => issue.code === "financial_order_changed"));
  });

  it("accepts native sync jobs without a redundant merchantId and detects their cross-merchant reassignment", () => {
    const baseline = snapshot({ syncJobs: [{ id: "sync-1", orderId: "order-1", kind: "channel_projection", status: "queued" }] });
    const current = snapshot({ syncJobs: [{ ...baseline.syncJobs[0], status: "succeeded", attempts: 1 }] });
    assert.equal(planMainPaymentDelta(baseline, current).safe, true);
    current.syncJobs[0]!.orderId = "other-order";
    assert.equal(planMainPaymentDelta(baseline, current).safe, false);
  });

  it("rejects a paid order losing or changing its previously assigned transaction identity", () => {
    const baseline = snapshot();
    Object.assign(baseline.orders[0]!, { status: "paid", tradeNo: "trade-1", paymentEventKey: "event-1", paidAt: "2026-11-05T00:01:00.000Z" });
    for (const fields of [{ tradeNo: "" }, { paymentEventKey: "event-2" }, { paidAt: "2026-11-05T00:02:00.000Z" }]) {
      const current = snapshot({ orders: [{ ...baseline.orders[0], ...fields }] });
      assert.equal(planMainPaymentDelta(baseline, current).safe, false);
    }
  });

  it("blocks channel configuration drift and reports incomplete collections without throwing", () => {
    const baseline = snapshot({ channels: { alipay: { enabled: true, appId: "app-1" } } });
    const current = snapshot({ channels: { alipay: { enabled: true, appId: "app-2" } } });
    assert.equal(planMainPaymentDelta(baseline, current).safe, false);
    delete (current as Row).ledger;
    const delta = planMainPaymentDelta(baseline, current);
    assert.equal(delta.safe, false);
    assert.ok(delta.issues.some(issue => issue.code === "collection_missing"));
  });

  it("allows settlement decisions without changing their original merchant or amount", () => {
    const baseline = snapshot({ settlements: [{ id: "settlement-1", merchantId: "merchant-1", amountCents: 50, status: "pending", note: "original" }] });
    const current = structuredClone(baseline);
    Object.assign(current.settlements[0]!, { status: "rejected", reviewedBy: "admin", reviewedAt: "2026-11-05T00:02:00Z", reference: null });
    assert.equal(planMainPaymentDelta(baseline, current).safe, true);
    current.settlements[0]!.amountCents = 49;
    assert.equal(planMainPaymentDelta(baseline, current).safe, false);
    current.settlements[0]!.amountCents = 50;
    current.settlements[0]!.status = "pending";
    assert.equal(planMainPaymentDelta({ ...baseline, settlements: [{ ...baseline.settlements[0], status: "paid" }] }, current).safe, false);
  });
});
