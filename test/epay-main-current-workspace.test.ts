import assert from "node:assert/strict";
import { it } from "node:test";
import { createHash } from "node:crypto";
import { balanceFixture } from "./epay-live-balance-fixture.ts";
import { installBalanceOpenings, planBalanceOpenings } from "../src/epay-compat/balance-opening.ts";
import { applyMainPaymentDelta, readCurrentMainPayment } from "../src/epay-compat/main-delta-store.ts";
import { createMainOrdersWorkspace } from "../src/epay-compat/main-orders-workspace.ts";
import { canonicalSource } from "../src/epay-compat/source-drift.ts";

const CUTOFF = 1_800_000_000_000;
const order = { id: "old-main", merchantId: "main-1", merchantOrderId: "original", amountCents: 100, platformFeeCents: 5, merchantNetCents: 95, status: "pending_payment", createdAt: "2026-01-01T00:00:00.000Z" };

it("uses synchronized order, callback and refund states while preserving historical sources and merchant scope", async () => {
  const f = await balanceFixture({ orders: [order] });
  try {
    f.db.write(sql => {
      installBalanceOpenings(sql, f.cipher, planBalanceOpenings(sql, f.cipher, "a".repeat(64)), CUTOFF);
      const baseline = readCurrentMainPayment(sql, f.cipher);
      const current = structuredClone(baseline.payment);
      Object.assign(current.orders[0]!, { status: "paid", paidAt: new Date(CUTOFF + 500).toISOString(), tradeNo: "trusted-old-trade" });
      current.ledger.push({ id: "late-main-posting", merchantId: "main-1", orderId: order.id, type: "payment_paid", availableDelta: 95, frozenDelta: 0, grossCents: 100, platformFeeCents: 5, merchantNetCents: 95, at: new Date(CUTOFF + 500).toISOString() });
      current.callbacks = [{ id: "callback", merchantId: "main-1", orderId: order.id, status: "succeeded", createdAt: new Date(CUTOFF + 500).toISOString(), secret: "never-expose" }];
      current.refunds = [{ id: "refund", merchantId: "main-1", amountCents: 5, status: "pending", reference: "private-reference" }];
      current.balanceSummaries = { "main-1": { availableCents: 95, frozenCents: 0 } };
      applyMainPaymentDelta(sql, f.cipher, { payment: current, expectedSha256: createHash("sha256").update(canonicalSource(baseline.payment)).digest("hex"), responseSha256: "b".repeat(64), capturedAt: new Date(CUTOFF + 1000).toISOString(), appliedAt: CUTOFF + 1001 });
    });
    f.db.write(sql => {
      const before = readCurrentMainPayment(sql, f.cipher);
      const invoiced = structuredClone(before.payment);
      invoiced.invoiceApplications = [{ id: "invoice", orderId: order.id, merchantId: "main-1", feeCents: 5, status: "pending", createdAt: new Date(CUTOFF + 1500).toISOString() }];
      invoiced.ledger.push({ id: "invoice-fee", merchantId: "main-1", orderId: order.id, invoiceApplicationId: "invoice", type: "invoice_fee", availableDelta: -5, frozenDelta: 0, grossCents: 5, at: new Date(CUTOFF + 1500).toISOString() });
      invoiced.balanceSummaries = { "main-1": { availableCents: 90, frozenCents: 0 } };
      assert.equal(applyMainPaymentDelta(sql, f.cipher, { payment: invoiced, expectedSha256: before.sourceSha256, responseSha256: "c".repeat(64), capturedAt: new Date(CUTOFF + 2000).toISOString(), appliedAt: CUTOFF + 2001 }).postedEntries, 1);
    });
    const identityFetch: typeof fetch = async (input, init) => {
      if (new Headers(init?.headers).get("cookie") !== "session=owner") return new Response(null, { status: 401 });
      return new URL(String(input)).searchParams.get("merchantId") === "main-1" ? Response.json({ ok: true, merchantId: "main-1", apiId: "api-1", role: "owner" }) : new Response(null, { status: 403 });
    };
    const app = createMainOrdersWorkspace({ database: f.db, masterKey: f.key, identityOrigin: "http://127.0.0.1:8787", identityFetch });
    const headers = { cookie: "session=owner" };
    for (const path of ["/main-orders?merchantId=main-1&status=paid", "/combined-orders?merchantId=main-1&status=paid&search=original"]) {
      const response = await app.request(path, { headers });
      assert.equal(response.status, 200);
      const body = await response.json() as { data: { orders: Array<{ id: string; status: string }> } };
      assert.deepEqual(body.data.orders.map(row => [row.id, row.status]), [[order.id, "paid"]]);
    }
    const callback = await app.request("/main-activity?merchantId=main-1&kind=callbacks", { headers });
    assert.equal(callback.status, 200);
    const callbackText = await callback.text();
    assert.match(callbackText, /succeeded/); assert.doesNotMatch(callbackText, /never-expose/);
    const refunds = await app.request("/main-refunds?merchantId=main-1", { headers });
    assert.equal(refunds.status, 200);
    const refundText = await refunds.text();
    assert.match(refundText, /refund/); assert.doesNotMatch(refundText, /private-reference/);
    assert.equal((await app.request("/main-orders?merchantId=main-2", { headers })).status, 404);
    assert.equal((await app.request("/main-orders?merchantId=main-1")).status, 401);
    f.db.read(sql => {
      assert.equal(sql.prepare("SELECT status FROM epay_main_order_sources WHERE order_id=?").get(order.id)?.status, "pending_payment");
      assert.equal(Number(sql.prepare("SELECT count(*) n FROM epay_callback_jobs").get()?.n), 0);
    });
  } finally { f.close(); }
});
