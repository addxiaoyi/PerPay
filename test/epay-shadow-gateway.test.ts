import assert from "node:assert/strict";
import { it } from "node:test";

import { createEPayShadowGateway } from "../src/epay-compat/shadow-gateway.ts";
import { epaySign } from "../src/epay-compat/sign.ts";

const merchant = { merchantId: 1001, enabled: true, signingKey: "test-key", siteClientId: "site-1" };
const fields = { pid: "1001", type: "alipay", out_trade_no: "order-1", money: "0.29", name: "item", clientip: "127.0.0.1", notify_url: "https://merchant.example/notify" };
const signed = (params: Record<string, string>) => ({ ...params, sign: epaySign(params, merchant.signingKey), sign_type: "MD5" });

it("accepts signed shadow orders idempotently and rejects conflicting repeats", async () => {
  const app = createEPayShadowGateway([merchant]);
  const request = (params: Record<string, string>) => app.request("/mapi.php", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signed(params)) });
  const first = await request(fields);
  const firstBody = await first.json() as { code: number; shadow: boolean; trade_no: string };
  assert.equal(first.status, 202);
  assert.equal(firstBody.code, 0);
  assert.equal(firstBody.shadow, true);
  const second = await (await request(fields)).json() as { trade_no: string };
  assert.equal(second.trade_no, firstBody.trade_no);
  assert.equal((await request({ ...fields, money: "1.00" })).status, 409);
});

it("rejects duplicate parameters and forged signatures without creating orders", async () => {
  const app = createEPayShadowGateway([merchant]);
  assert.equal((await app.request("/submit.php?pid=1001&pid=1002")).status, 400);
  const response = await app.request("/mapi.php", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...fields, sign: "0".repeat(32) }) });
  assert.equal(response.status, 400);
});

it("rejects ambiguous POST query parameters and oversized GET targets", async () => {
  const app = createEPayShadowGateway([merchant]);
  const post = await app.request("/mapi.php?pid=1001", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signed(fields)),
  });
  assert.equal(post.status, 400);
  const oversized = await app.request(`/mapi.php?padding=${"a".repeat(16_385)}`);
  assert.equal(oversized.status, 400);
  const valid = await app.request("/mapi.php", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(signed(fields)),
  });
  assert.equal(valid.status, 202);
});
