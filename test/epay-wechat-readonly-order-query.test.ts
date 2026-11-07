import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { it } from "node:test";
import { queryWechatOrderReadonly } from "../src/epay-compat/wechat-readonly-order-query.ts";

it("authenticates a read-only query and rejects inconsistent payment evidence", async () => {
  const platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = 1_800_000_000_000;
  const expected = { appId: "app", merchantId: "merchant", tradeNo: "order", providerTradeNo: "transaction", amountCents: 100, platformKey: platform.publicKey.export({ type: "spki", format: "pem" }).toString(), platformKeyId: "platform" };
  const signRequest = (message: string) => ({ serial: "merchant-serial", signature: sign("RSA-SHA256", Buffer.from(message), merchant.privateKey).toString("base64") });
  const response = (changes: Record<string, unknown> = {}, tamper = false) => {
    const raw = JSON.stringify({ appid: "app", mchid: "merchant", out_trade_no: "order", transaction_id: "transaction", trade_state: "SUCCESS", amount: { total: 100, currency: "CNY" }, ...changes });
    const timestamp = String(now / 1000);
    const signature = sign("RSA-SHA256", Buffer.from(`${timestamp}\nnonce\n${raw}\n`), platform.privateKey).toString("base64");
    return new Response(tamper ? `${raw} ` : raw, { status: 200, headers: { "content-type": "application/json", "wechatpay-timestamp": timestamp, "wechatpay-nonce": "nonce", "wechatpay-serial": "platform", "wechatpay-signature": signature } });
  };
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.mch.weixin.qq.com");
    assert.equal(`${url.pathname}${url.search}`, "/v3/pay/transactions/out-trade-no/order?mchid=merchant");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    const match = /^WECHATPAY2-SHA256-RSA2048 mchid="merchant",nonce_str="([a-f0-9]{32})",signature="([A-Za-z0-9+/=]+)",timestamp="(\d+)",serial_no="merchant-serial"$/.exec(new Headers(init?.headers).get("authorization") ?? "");
    assert.ok(match);
    assert.equal(verify("RSA-SHA256", Buffer.from(`GET\n${url.pathname}${url.search}\n${match[3]}\n${match[1]}\n\n`), merchant.publicKey, Buffer.from(match[2]!, "base64")), true);
    return response();
  };
  const options = { expected, sign: signRequest, transport, clock: () => now };
  assert.deepEqual(await queryWechatOrderReadonly(options), { state: "SUCCESS", amountCents: 100 });
  assert.deepEqual(await queryWechatOrderReadonly({ ...options, transport: async () => response({ trade_state: "NOTPAY" }) }), { state: "NOTPAY", amountCents: 100 });
  assert.deepEqual(await queryWechatOrderReadonly({ ...options, transport: async () => response({ trade_state: "REFUND" }) }), { state: "REFUND", amountCents: 100 });
  await assert.rejects(queryWechatOrderReadonly({ ...options, transport: async () => response({ trade_state: "REFUND", transaction_id: "other" }) }), /transaction identity mismatch/);
  for (const changes of [{ transaction_id: "other" }, { mchid: "other" }, { appid: "other" }, { out_trade_no: "other" }, { amount: { total: 101, currency: "CNY" } }]) {
    await assert.rejects(queryWechatOrderReadonly({ ...options, transport: async () => response(changes) }));
  }
  await assert.rejects(queryWechatOrderReadonly({ ...options, transport: async () => response({}, true) }), /signature/);
  await assert.rejects(queryWechatOrderReadonly({ ...options, transport: async () => new Response("missing", { status: 404 }) }), /response unavailable/);
  await assert.rejects(queryWechatOrderReadonly({ ...options, transport: async () => new Response("x".repeat(65_537), { headers: { "content-type": "application/json" } }) }), /could not be read/);
  await assert.rejects(queryWechatOrderReadonly({ ...options, sign: () => ({ serial: "bad\nserial", signature: "abc" }) }), /request signature/);
});
