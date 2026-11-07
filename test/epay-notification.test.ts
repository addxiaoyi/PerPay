import assert from "node:assert/strict";
import { it } from "node:test";

import { buildEPayPaidNotification, deliverEPayPaidNotification } from "../src/epay-compat/notification.ts";
import { verifyEPaySign } from "../src/epay-compat/sign.ts";

it("signs only confirmed payments with an exact matching amount", () => {
  const order = { merchantId: 1001, tradeNo: "trade-1", merchantOrderNo: "order-1", type: "alipay", name: "item", amountCents: 29, receivedAmountCents: 29, paymentStatus: "CONFIRMED", param: "metadata" };
  const params = buildEPayPaidNotification(order, "test-key");
  assert.equal(params.money, "0.29");
  assert.equal(params.trade_status, "TRADE_SUCCESS");
  assert.equal(verifyEPaySign(params, "test-key"), true);
  assert.throws(() => buildEPayPaidNotification({ ...order, receivedAmountCents: 30 }, "test-key"), /exact legacy amount/);
  assert.throws(() => buildEPayPaidNotification({ ...order, paymentStatus: "UNPAID" }, "test-key"), /not confirmed/);
});

it("posts a signed form and accepts only a successful HTTP success acknowledgement", async () => {
  const order = { merchantId: 1001, tradeNo: "trade-1", merchantOrderNo: "order-1", type: "alipay", name: "商品 & 服务", amountCents: 29, receivedAmountCents: 29, paymentStatus: "CONFIRMED", param: "a=b" };
  let status = 200;
  let reply = " success\n";
  const transport = { async post(input: Parameters<import("../src/notifications/transport.ts").WebhookTransport["post"]>[0]) {
    assert.equal(input.contentType, "application/x-www-form-urlencoded");
    const params = Object.fromEntries(new URLSearchParams(input.body.toString("utf8")));
    assert.equal(params.name, order.name);
    assert.equal(params.param, order.param);
    assert.equal(verifyEPaySign(params, "test-key"), true);
    return { status, body: Buffer.from(reply), contentType: "text/plain", contentEncoding: null, responseFingerprint: "", resolvedAddressesFingerprint: "", connectedAddress: "" };
  } };
  const input = { order, signingKey: "test-key", targetUrl: "https://example.test/notify", transport, timeoutMilliseconds: 1000 };
  assert.deepEqual(await deliverEPayPaidNotification(input), { acknowledged: true, status: 200 });
  reply = "SUCCESS";
  assert.equal((await deliverEPayPaidNotification(input)).acknowledged, true);
  reply = "success";
  status = 500;
  assert.equal((await deliverEPayPaidNotification(input)).acknowledged, false);
  await assert.rejects(deliverEPayPaidNotification({ ...input, order: { ...order, receivedAmountCents: 30 } }), /exact legacy amount/);
});

it("rejects callback URLs that collide with signed fields before any request", async () => {
  const order = { merchantId: 1, tradeNo: "trade", merchantOrderNo: "order", type: "alipay", name: "item", amountCents: 100, receivedAmountCents: 100, paymentStatus: "CONFIRMED", param: "" };
  let requests = 0;
  const response = { status: 200, body: Buffer.from("success"), contentType: null, contentEncoding: null, responseFingerprint: "", resolvedAddressesFingerprint: "", connectedAddress: "" };
  const transport = { async post() { requests++; return response; }, async get() { requests++; return response; } };
  for (const method of ["GET", "POST"] as const) {
    for (const field of ["trade_no", "sign", "pid"]) {
      await assert.rejects(deliverEPayPaidNotification({ order, signingKey: "key", targetUrl: `https://example.test/notify?${field}=other`, transport, timeoutMilliseconds: 1000, method }), /reserved payment parameter/);
    }
  }
  assert.equal(requests, 0);
  assert.equal((await deliverEPayPaidNotification({ order, signingKey: "key", targetUrl: "https://example.test/notify?tenant=one", transport, timeoutMilliseconds: 1000 })).acknowledged, true);
  assert.equal(requests, 1);
});
