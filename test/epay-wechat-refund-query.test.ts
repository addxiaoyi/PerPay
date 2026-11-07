import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { it } from "node:test";
import { queryWechatRefund } from "../src/epay-compat/wechat-refund-query.ts";

it("signs an isolated refund query and verifies the returned evidence", async () => {
  const platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = 1_800_000_000_000;
  const expected = { merchantId: "merchant", tradeNo: "order", providerTradeNo: "transaction", refundNo: "refund", totalCents: 100, refundCents: 30, platformKey: platform.publicKey.export({ type: "spki", format: "pem" }).toString(), platformKeyId: "platform" };
  let calls = 0;
  const signRequest = (message: string) => ({ serial: "merchant-serial", signature: sign("RSA-SHA256", Buffer.from(message), merchant.privateKey).toString("base64") });
  const response = (changes: Record<string, unknown> = {}) => {
    const raw = JSON.stringify({ out_trade_no: "order", transaction_id: "transaction", out_refund_no: "refund", refund_id: "provider-refund", status: "PROCESSING", amount: { total: 100, refund: 30, currency: "CNY" }, ...changes });
    const timestamp = String(now / 1000);
    const signature = sign("RSA-SHA256", Buffer.from(`${timestamp}\nprovider-nonce\n${raw}\n`), platform.privateKey).toString("base64");
    return new Response(raw, { status: 200, headers: { "content-type": "application/json", "wechatpay-timestamp": timestamp, "wechatpay-nonce": "provider-nonce", "wechatpay-serial": "platform", "wechatpay-signature": signature } });
  };
  const transport: typeof fetch = async (input, init) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.mch.weixin.qq.com");
    assert.equal(url.pathname, "/v3/refund/domestic/refunds/refund");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    const match = /^WECHATPAY2-SHA256-RSA2048 mchid="merchant",nonce_str="([a-f0-9]{32})",signature="([A-Za-z0-9+/=]+)",timestamp="(\d+)",serial_no="merchant-serial"$/.exec(authorization);
    assert.ok(match);
    assert.equal(verify("RSA-SHA256", Buffer.from(`GET\n${url.pathname}\n${match[3]}\n${match[1]}\n\n`), merchant.publicKey, Buffer.from(match[2]!, "base64")), true);
    return response();
  };
  const options = { expected, sign: signRequest, transport, clock: () => now };
  assert.deepEqual(await queryWechatRefund(options), { state: "PROCESSING", providerRefundNo: "provider-refund", refundCents: 30 });
  assert.equal(calls, 1);
  await assert.rejects(queryWechatRefund({ ...options, expected: { ...expected, refundCents: 101 } }), /invalid expected/);
  await assert.rejects(queryWechatRefund({ ...options, expected: { ...expected, tradeNo: undefined as unknown as string } }), /invalid expected/);
  assert.equal(calls, 1);
  await assert.rejects(queryWechatRefund({ ...options, transport: async () => response({ amount: { total: 100, refund: 31, currency: "CNY" } }) }), /amount mismatch/);
  await assert.rejects(queryWechatRefund({ ...options, transport: async () => new Response("missing", { status: 404 }) }), /response unavailable/);
  await assert.rejects(queryWechatRefund({ ...options, transport: async () => new Response("x".repeat(65_537), { status: 200, headers: { "content-type": "application/json" } }) }), /could not be read/);
  await assert.rejects(queryWechatRefund({ ...options, sign: () => ({ serial: "bad\nserial", signature: "abc" }) }), /request signature/);
});
