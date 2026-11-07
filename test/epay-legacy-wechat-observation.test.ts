import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { it } from "node:test";
import { observeLegacyWechatPayment } from "../src/epay-compat/legacy-wechat-observation.ts";

it("queries with trusted legacy credentials without exposing sensitive response data", async () => {
  const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = 1_800_000_000_000;
  const config = { appId: "app", mchId: "merchant", merchantPrivateKey: merchant.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), merchantSerialNo: "merchant-key", platformPublicKey: platform.publicKey.export({ type: "spki", format: "pem" }).toString(), platformPublicKeyId: "platform-key" };
  const body = JSON.stringify({ appid: "app", mchid: "merchant", out_trade_no: "order", transaction_id: "transaction", trade_state: "SUCCESS", amount: { total: 100, currency: "CNY" }, payer: { openid: "secret" } });
  const timestamp = String(now / 1000);
  const signature = sign("RSA-SHA256", Buffer.from(`${timestamp}\nnonce\n${body}\n`), platform.privateKey).toString("base64");
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const match = /nonce_str="([^"]+)",signature="([^"]+)",timestamp="(\d+)"/.exec(auth);
    assert.ok(match);
    assert.equal(verify("RSA-SHA256", Buffer.from(`GET\n${url.pathname}${url.search}\n${match[3]}\n${match[1]}\n\n`), merchant.publicKey, Buffer.from(match[2]!, "base64")), true);
    return new Response(body, { headers: { "content-type": "application/json", "wechatpay-timestamp": timestamp, "wechatpay-nonce": "nonce", "wechatpay-serial": "platform-key", "wechatpay-signature": signature } });
  };
  const options = { config, tradeNo: "order", providerTradeNo: "transaction", amountCents: 100, transport, clock: () => now };
  assert.deepEqual(await observeLegacyWechatPayment(options), { state: "SUCCESS", amountCents: 100 });
  await assert.rejects(observeLegacyWechatPayment({ ...options, providerTradeNo: "other" }), /transaction identity mismatch/);
  await assert.rejects(observeLegacyWechatPayment({ ...options, config: { ...config, merchantPrivateKey: "bad" } }));
  await assert.rejects(observeLegacyWechatPayment({ ...options, config: { ...config, platformPublicKey: undefined } }), /configuration/);
});
