import assert from "node:assert/strict";
import { createCipheriv, generateKeyPairSync, sign } from "node:crypto";
import { it } from "node:test";
import { verifyWechatEvidence, verifyWechatQueryEvidence } from "../src/epay-compat/wechat-evidence.ts";

it("verifies WeChat signatures, decrypts evidence and checks exact order identity", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = 1_800_000_000_000;
  const expected = { appId: "app-1", merchantId: "merchant-1", tradeNo: "order-1", amountCents: 100, platformKey: publicKey.export({ type: "spki", format: "pem" }).toString(), platformKeyId: "serial-1", apiV3Key: "12345678901234567890123456789012", now };
  const notification = (changes: Record<string, unknown> = {}) => {
    const transaction = { appid: expected.appId, mchid: expected.merchantId, out_trade_no: expected.tradeNo, transaction_id: "provider-1", trade_state: "SUCCESS", amount: { total: 100, currency: "CNY" }, ...changes };
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(expected.apiV3Key), Buffer.from("123456789012"));
    cipher.setAAD(Buffer.from("transaction"));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(transaction)), cipher.final(), cipher.getAuthTag()]).toString("base64");
    const body = Buffer.from(JSON.stringify({ event_type: "TRANSACTION.SUCCESS", resource: { algorithm: "AEAD_AES_256_GCM", nonce: "123456789012", associated_data: "transaction", ciphertext } }));
    const timestamp = String(now / 1000);
    const signature = sign("RSA-SHA256", Buffer.concat([Buffer.from(`${timestamp}\nnonce\n`), body, Buffer.from("\n")]), privateKey).toString("base64");
    return { body, headers: new Headers({ "wechatpay-timestamp": timestamp, "wechatpay-nonce": "nonce", "wechatpay-serial": "serial-1", "wechatpay-signature": signature }) };
  };
  const valid = notification();
  assert.equal(verifyWechatEvidence(valid.body, valid.headers, expected).providerTradeNo, "provider-1");
  assert.throws(() => verifyWechatEvidence(Buffer.concat([valid.body, Buffer.from(" ")]), valid.headers, expected), /signature/);
  assert.throws(() => verifyWechatEvidence(valid.body, valid.headers, { ...expected, now: now + 301_000 }), /headers/);
  assert.throws(() => verifyWechatEvidence(valid.body, valid.headers, { ...expected, platformKeyId: "other" }), /headers/);
  assert.throws(() => verifyWechatEvidence(valid.body, valid.headers, { ...expected, apiV3Key: "x".repeat(32) }));
  for (const change of [{ appid: "other" }, { mchid: "other" }, { out_trade_no: "other" }]) {
    const input = notification(change);
    assert.throws(() => verifyWechatEvidence(input.body, input.headers, expected), /identity/);
  }
  const wrongAmount = notification({ amount: { total: 101, currency: "CNY" } });
  assert.throws(() => verifyWechatEvidence(wrongAmount.body, wrongAmount.headers, expected), /amount/);
});

it("accepts only a signed successful exact-identity WeChat query response", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = 1_800_000_000_000;
  const expected = { appId: "app", merchantId: "merchant", tradeNo: "order", amountCents: 100, platformKey: publicKey.export({ type: "spki", format: "pem" }).toString(), platformKeyId: "serial", now };
  const response = (changes: Record<string, unknown> = {}) => {
    const body = Buffer.from(JSON.stringify({ appid: "app", mchid: "merchant", out_trade_no: "order", transaction_id: "provider", trade_state: "SUCCESS", amount: { total: 100, currency: "CNY" }, ...changes }));
    const timestamp = String(now / 1000);
    const signature = sign("RSA-SHA256", Buffer.concat([Buffer.from(`${timestamp}\nnonce\n`), body, Buffer.from("\n")]), privateKey).toString("base64");
    return { body, headers: new Headers({ "wechatpay-timestamp": timestamp, "wechatpay-nonce": "nonce", "wechatpay-serial": "serial", "wechatpay-signature": signature }) };
  };
  const valid = response();
  assert.equal(verifyWechatQueryEvidence(valid.body, valid.headers, expected).providerTradeNo, "provider");
  assert.throws(() => verifyWechatQueryEvidence(Buffer.concat([valid.body, Buffer.from(" ")]), valid.headers, expected), /signature/);
  assert.throws(() => verifyWechatQueryEvidence(valid.body, valid.headers, { ...expected, now: now + 301_000 }), /headers/);
  for (const change of [{ appid: "other" }, { mchid: "other" }, { out_trade_no: "other" }, { amount: { total: 101, currency: "CNY" } }, { amount: { total: 100, currency: "USD" } }, { trade_state: "NOTPAY" }, { transaction_id: "" }]) {
    const altered = response(change);
    assert.throws(() => verifyWechatQueryEvidence(altered.body, altered.headers, expected));
  }
});
