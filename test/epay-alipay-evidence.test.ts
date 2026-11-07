import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { it } from "node:test";
import { verifyAlipayEvidence } from "../src/epay-compat/alipay-evidence.ts";

it("requires an authentic provider signature and exact order, account, amount and status", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const expected = { appId: "app-1", sellerId: "seller-1", tradeNo: "order-1", amountCents: 100, platformPublicKey: publicKey.export({ type: "spki", format: "pem" }).toString() };
  const signed = (overrides: Record<string, string> = {}) => {
    const params: Record<string, string> = { app_id: "app-1", seller_id: "seller-1", out_trade_no: "order-1", trade_no: "provider-1", trade_status: "TRADE_SUCCESS", total_amount: "1.00", ...overrides };
    const content = Object.keys(params).filter((key) => params[key] !== "").sort().map((key) => `${key}=${params[key]}`).join("&");
    return { ...params, sign_type: "RSA2", sign: sign("RSA-SHA256", Buffer.from(content), privateKey).toString("base64") };
  };
  assert.equal(verifyAlipayEvidence(signed(), expected).providerTradeNo, "provider-1");
  assert.throws(() => verifyAlipayEvidence({ ...signed(), total_amount: "2.00" }, expected), /signature/);
  for (const params of [signed({ app_id: "other" }), signed({ seller_id: "other" }), signed({ out_trade_no: "other" })]) assert.throws(() => verifyAlipayEvidence(params, expected), /identity/);
  assert.throws(() => verifyAlipayEvidence(signed({ total_amount: "1.01" }), expected), /amount mismatch/);
  assert.throws(() => verifyAlipayEvidence(signed({ trade_status: "WAIT_BUYER_PAY" }), expected), /not successful/);
  assert.throws(() => verifyAlipayEvidence(signed({ trade_no: "" }), expected), /trade number/);
});
