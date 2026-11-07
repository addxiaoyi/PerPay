import assert from "node:assert/strict";
import { it } from "node:test";

import { validateEPayOrder } from "../src/epay-compat/order-request.ts";
import { epaySign } from "../src/epay-compat/sign.ts";

const merchant = { merchantId: 1001, enabled: true, signingKey: "fixture-key", siteClientId: "site-1" };
const fields = { pid: "1001", out_trade_no: "legacy|order", money: "000.29", name: "fixture", type: "alipay", clientip: "127.0.0.1", notify_url: "https://merchant.example/notify", return_url: "https://merchant.example/return", param: "metadata" };

it("authenticates and preserves legacy order fields without floating-point rounding", () => {
  const params = { ...fields, sign: epaySign(fields, merchant.signingKey), sign_type: "MD5" };
  const order = validateEPayOrder(params, merchant, "api");
  assert.equal(order.amountCents, 29);
  assert.equal(order.merchantOrderNo, "legacy|order");
  assert.equal(order.param, "metadata");
  assert.equal(order.siteClientId, "site-1");
  assert.equal(validateEPayOrder(params, merchant, "api").idempotencyKey, order.idempotencyKey);
  assert.throws(() => validateEPayOrder({ ...params, money: "1.00" }, merchant, "api"), /authentication failed/);
  assert.throws(() => validateEPayOrder(params, { ...merchant, enabled: false }, "api"), /authentication failed/);
});

it("rejects invalid modes and amounts after verifying the signature", () => {
  for (const fieldsToReject of [{ ...fields, money: "1.001" }, { ...fields, clientip: "" }, { ...fields, device: "miniprogram", openid: "" }]) {
    const params = { ...fieldsToReject, sign: epaySign(fieldsToReject, merchant.signingKey) };
    assert.throws(() => validateEPayOrder(params, merchant, "api"));
  }
});
