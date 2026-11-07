import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { it } from "node:test";
import { observeWechatQuery, observeWechatRefund } from "../src/epay-compat/wechat-evidence.ts";

it("authenticates read-only WeChat order states and rejects mismatched evidence", () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = 1_800_000_000_000;
  const expected = { appId: "app", merchantId: "merchant", tradeNo: "order", amountCents: 100, platformKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), platformKeyId: "serial", now };
  const response = (changes: Record<string, unknown>) => {
    const body = Buffer.from(JSON.stringify({ appid: "app", mchid: "merchant", out_trade_no: "order", trade_state: "NOTPAY", amount: { total: 100, currency: "CNY" }, ...changes }));
    const timestamp = String(now / 1000);
    const signature = sign("RSA-SHA256", Buffer.concat([Buffer.from(`${timestamp}\nnonce\n`), body, Buffer.from("\n")]), keys.privateKey).toString("base64");
    return { body, headers: new Headers({ "wechatpay-timestamp": timestamp, "wechatpay-nonce": "nonce", "wechatpay-serial": "serial", "wechatpay-signature": signature }) };
  };
  for (const state of ["NOTPAY", "USERPAYING", "CLOSED", "REVOKED", "PAYERROR", "REFUND"]) {
    const result = response({ trade_state: state });
    assert.deepEqual(observeWechatQuery(result.body, result.headers, expected), { state, amountCents: 100 });
  }
  const paid = response({ trade_state: "SUCCESS", transaction_id: "provider" });
  assert.equal(observeWechatQuery(paid.body, paid.headers, expected).state, "SUCCESS");
  const closed = response({ trade_state: "CLOSED", amount: undefined });
  assert.deepEqual(observeWechatQuery(closed.body, closed.headers, expected), { state: "CLOSED", amountCents: null });
  for (const changes of [{ trade_state: "SUCCESS", transaction_id: "provider", amount: undefined },
    { trade_state: "NOTPAY", amount: undefined }, { trade_state: "CLOSED", amount: null },
    { trade_state: "CLOSED", amount: undefined, mchid: "other" },
    { trade_state: "CLOSED", amount: undefined, out_trade_no: "other" }]) {
    const bad = response(changes);
    assert.throws(() => observeWechatQuery(bad.body, bad.headers, expected));
  }
  assert.throws(() => observeWechatQuery(Buffer.concat([closed.body, Buffer.from(" ")]), closed.headers, expected), /signature/);
  for (const changes of [{ mchid: "other" }, { out_trade_no: "other" }, { amount: { total: 101, currency: "CNY" } }, { trade_state: "unknown" }, { trade_state: "SUCCESS" }]) {
    const bad = response(changes);
    assert.throws(() => observeWechatQuery(bad.body, bad.headers, expected));
  }
  assert.throws(() => observeWechatQuery(Buffer.concat([paid.body, Buffer.from(" ")]), paid.headers, expected), /signature/);
});

it("authenticates a refund without treating processing as success", () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = 1_800_000_000_000;
  const expected = { tradeNo: "order", providerTradeNo: "transaction", refundNo: "refund", totalCents: 100, refundCents: 30, platformKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), platformKeyId: "serial", now };
  const response = (changes: Record<string, unknown>) => {
    const body = Buffer.from(JSON.stringify({ out_trade_no: "order", transaction_id: "transaction", out_refund_no: "refund", refund_id: "provider-refund", status: "PROCESSING", amount: { total: 100, refund: 30, currency: "CNY" }, ...changes }));
    const timestamp = String(now / 1000);
    const signature = sign("RSA-SHA256", Buffer.concat([Buffer.from(`${timestamp}\nnonce\n`), body, Buffer.from("\n")]), keys.privateKey).toString("base64");
    return { body, headers: new Headers({ "wechatpay-timestamp": timestamp, "wechatpay-nonce": "nonce", "wechatpay-serial": "serial", "wechatpay-signature": signature }) };
  };
  for (const state of ["SUCCESS", "CLOSED", "PROCESSING", "ABNORMAL"]) {
    const value = response({ status: state });
    assert.deepEqual(observeWechatRefund(value.body, value.headers, expected), { state, providerRefundNo: "provider-refund", refundCents: 30 });
  }
  for (const changes of [{ out_trade_no: "other" }, { transaction_id: "other" }, { out_refund_no: "other" }, { refund_id: "" }, { status: "unknown" }, { amount: { total: 100, refund: 31, currency: "CNY" } }, { amount: { total: 101, refund: 30, currency: "CNY" } }, { amount: { total: 100, refund: 30, currency: "USD" } }]) {
    const value = response(changes);
    assert.throws(() => observeWechatRefund(value.body, value.headers, expected));
  }
  const valid = response({});
  assert.throws(() => observeWechatRefund(Buffer.concat([valid.body, Buffer.from(" ")]), valid.headers, expected), /signature/);
  assert.throws(() => observeWechatRefund(valid.body, valid.headers, { ...expected, refundCents: 101 }), /invalid expected/);
});
