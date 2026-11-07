import assert from "node:assert/strict";
import { it } from "node:test";
import { Hono } from "hono";
import { createIsolatedGateway } from "../src/epay-compat/isolated-gateway.ts";
import { readEPayParams } from "../src/epay-compat/shadow-gateway.ts";

it("dispatches bounded EPay requests and separates provider callbacks", async () => {
  const calls: string[] = [];
  const channel = (name: string) => ({ async fetch(request: Request) {
    calls.push(name);
    return Response.json({ channel: name, fields: await readEPayParams(request) });
  } });
  const callback = (name: string) => new Hono().post("/notify", c => c.text(name));
  const app = createIsolatedGateway({ wechat: channel("wechat"), alipay: channel("alipay"), wechatCallback: callback("wechat"), alipayCallback: callback("alipay") });
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  const response = await app.request("/mapi.php", { method: "POST", headers, body: "type=wxpay&name=A%2BB&sign=fixture" });
  assert.deepEqual(await response.json(), { channel: "wechat", fields: { type: "wxpay", name: "A+B", sign: "fixture" } });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await (await app.request("/mapi.php?type=alipay&sign=x")).json() as { channel: string }).channel, "alipay");
  assert.equal((await app.request("/mapi.php", { method: "POST", headers, body: "type=wxpay&type=alipay" })).status, 400);
  assert.equal((await app.request("/mapi.php?type=wxpay", { method: "POST", headers, body: "type=alipay" })).status, 400);
  assert.equal((await app.request("/mapi.php", { method: "POST", headers, body: `type=wxpay&name=${"a".repeat(16384)}` })).status, 400);
  assert.equal((await app.request("/mapi.php?type=other")).status, 400);
  assert.deepEqual(calls, ["wechat", "alipay"]);
  assert.equal(await (await app.request("/wechat/notify", { method: "POST" })).text(), "wechat");
  assert.equal(await (await app.request("/alipay/notify", { method: "POST" })).text(), "alipay");
  assert.equal((await app.request("/notify", { method: "POST" })).status, 404);
});
