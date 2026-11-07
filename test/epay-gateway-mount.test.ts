import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { Hono } from "hono";
import { AppDatabase } from "../src/database/database.ts";
import { loadConfig } from "../src/config.ts";
import { RuntimeSettingsStore } from "../src/settings/store.ts";
import { createEPayRuntime, mountEPayGateway } from "../src/epay-compat/gateway-runtime.ts";

it("strips only the configured mount prefix and retains POST form bodies", async () => {
  for (const basePath of ["/", "/pay", "/nested/pay"]) {
    const gateway = new Hono()
      .on(["GET", "POST"], "/submit.php", async c => c.json({ path: c.req.path, query: c.req.query("type"), body: c.req.method === "POST" ? await c.req.text() : "" }))
      .get("/main/payment/order/:id", c => c.json({ id: c.req.param("id"), token: c.req.query("token") }));
    const app = new Hono().basePath(basePath);
    mountEPayGateway(app, { app: gateway }, basePath);
    for (const prefix of ["/epay", ""]) {
    const path = `${basePath === "/" ? "" : basePath}${prefix}/submit.php?type=alipay`;
    for (const method of ["GET", "POST"]) {
      const response = await app.request(path, { method, ...(method === "POST" ? { body: "name=fixture&money=1.01", headers: { "content-type": "application/x-www-form-urlencoded" } } : {}) });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { path: "/submit.php", query: "alipay", body: method === "POST" ? "name=fixture&money=1.01" : "" });
    }
    }
    const orderId = "00000000-0000-4000-8000-000000000001";
    const payment = await app.request(`${basePath === "/" ? "" : basePath}/api/payment/order/${orderId}?token=receipt-grant`);
    assert.equal(payment.status, 200);
    assert.deepEqual(await payment.json(), { id: orderId, token: "receipt-grant" });
  }
});

it("starts in maintenance without a provider or callback side effect and refuses unapproved live mode", async () => {
  const directory = mkdtempSync(join(tmpdir(), "perpay-gateway-"));
  const masterKey = Buffer.alloc(32, 12);
  const database = await AppDatabase.open(join(directory, "db.sqlite"), { masterKey });
  new RuntimeSettingsStore(database, masterKey).initialize();
  const options = { database, masterKey, publicOrigin: "https://gateway.example", basePath: "/pay", onError: () => assert.fail("scheduler must remain stopped") };
  const runtime = createEPayRuntime({ ...options, config: { mode: "maintenance", callbackDelivery: false } });
  try {
    assert.equal(await runtime.start(), 0);
    const app = new Hono().basePath("/pay");
    mountEPayGateway(app, runtime, "/pay");
    for (const endpoint of ["submit.php", "mapi.php"]) for (const method of ["GET", "POST"]) {
      assert.equal((await app.request(`/pay/epay/${endpoint}?type=alipay`, { method })).status, 503);
      assert.equal((await app.request(`/pay/${endpoint}?type=alipay`, { method })).status, 503);
    }
    assert.equal((await app.request("/pay/epay/alipay/notify", { method: "POST" })).status, 400);
    assert.equal((await app.request("/pay/api/merchant/orders", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 503);
    assert.equal((await app.request("/pay/epay/main/orders", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 503);
    assert.equal((await app.request("/pay/epay/wechat/notify", { method: "POST" })).status, 400);
    assert.equal((await app.request("/pay/epay/internal/source-sync", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 403);
    assert.equal(runtime.health().state, "idle");
    assert.equal(Number(database.read(sql => sql.prepare("SELECT count(*) n FROM epay_orders").get())?.n), 0);
    assert.throws(() => createEPayRuntime({ ...options, config: { mode: "live", callbackDelivery: true, alipayChannelId: 1 } }), /verified cutover manifest/);
  } finally { await runtime.close(); database.close(); rmSync(directory, { recursive: true, force: true }); }
});

it("rejects partial gateway configuration before starting services", () => {
  const env = { PERPAY_MASTER_KEY: "12".repeat(32), PERPAY_PUBLIC_URL: "https://gateway.example", PERPAY_TRUSTED_PROXY_CIDRS: "127.0.0.1/32" };
  assert.equal(loadConfig(env).epayGateway, undefined);
  assert.notEqual(loadConfig({ ...env, PERPAY_EPAY_GATEWAY_MODE: "maintenance", PERPAY_EPAY_INVOICE_FEE_CENTS: "0" }).epayGateway?.invoiceEnabled, true);
  assert.deepEqual(loadConfig({ ...env, PERPAY_EPAY_GATEWAY_MODE: "maintenance" }).epayGateway, { mode: "maintenance", callbackDelivery: false });
  assert.throws(() => loadConfig({ ...env, PERPAY_EPAY_GATEWAY_MODE: "live" }), /channel and callback delivery/);
  assert.throws(() => loadConfig({ ...env, PERPAY_EPAY_CALLBACK_DELIVERY: "true" }), /requires the gateway/);
  assert.throws(() => loadConfig({ ...env, PERPAY_EPAY_GATEWAY_MODE: "maintenance", PERPAY_EPAY_WECHAT_CREDENTIAL_ID: "fixture" }), /configured together/);
  assert.equal(loadConfig({ ...env, PERPAY_EPAY_GATEWAY_MODE: "maintenance", PERPAY_EPAY_INVOICE_FEE_CENTS: "125" }).epayGateway?.invoiceFeeCents, 125);
  assert.throws(() => loadConfig({ ...env, PERPAY_EPAY_GATEWAY_MODE: "maintenance", PERPAY_EPAY_INVOICE_FEE_CENTS: "1.25" }), /configuration validation failed/);
});
