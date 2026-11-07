import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { EPAY_COMPATIBILITY_SCHEMA_SQL } from "../src/epay-compat/schema.ts";
import { EPAY_OUTBOX_SCHEMA_SQL } from "../src/epay-compat/outbox-schema.ts";
import { createMerchantWorkspace } from "../src/epay-compat/merchant-workspace.ts";

it("checks main-site authorization on every workspace request", async () => {
  const mainRoutes = new URL("./fixtures/starmc-main/modules/payment/routes.js", import.meta.url);
  const { default: express } = await import("express");
  const { registerPaymentRoutes } = await import(mainRoutes.href);
  const store = { payment: { merchants: [{ id: "a", apiId: "api-a", userId: "owner", enabled: true, members: [{ userId: "member", enabled: true }] }, { id: "b", apiId: "api-b", userId: "other", enabled: true }] } };
  const main = express();
  registerPaymentRoutes(main, {
    config: {}, getStore: () => store,
    requireUser: (req, res, next) => { if (req.headers.cookie !== "session=fixture") return res.status(401).json({ ok: false }); req.user = { id: "member", roles: [] }; next(); },
    requireAdmin: (_req, _res, next) => next(),
    jsonOk: (res, body) => res.json({ ok: true, ...body }),
    jsonErr: (res, status, message, code) => res.status(status).json({ ok: false, message, code }),
    scheduleSave: () => { throw new Error("authorization must not save"); },
  });
  const server = await new Promise((resolve) => { const instance = main.listen(0, "127.0.0.1", () => resolve(instance)); });
  const sql = new DatabaseSync(":memory:");
  sql.exec(EPAY_COMPATIBILITY_SCHEMA_SQL);
  sql.exec(EPAY_OUTBOX_SCHEMA_SQL);
  sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'a',0,1,0,0),(2,'b',0,1,0,0);
    INSERT INTO epay_merchant_bindings(binding_id,main_api_id,main_merchant_id,epay_merchant_id,created_at,updated_at) VALUES ('ba','api-a','a',1,0,0),('bb','api-b','b',2,0,0);
    INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES
      ('order-a','external-a',1,'A',100,'https://example.test','PENDING','PENDING',0,1,1),
      ('order-b','external-b',2,'B',200,'https://example.test','PENDING','PENDING',0,1,1)`);
  const database = { read: (operation) => operation(sql) };
  const app = createMerchantWorkspace({ database, identityOrigin: `http://127.0.0.1:${server.address().port}` });
  try {
    const headers = { cookie: "session=fixture" };
    const routes = ["/orders", "/ledger-entries", "/invoices", "/notifications", "/callback-attempts"];
    const route = (path, merchantId, order = "order-a") => `${path}?merchantId=${merchantId}${["/notifications", "/callback-attempts"].includes(path) ? `&tradeNo=${order}` : ""}`;
    for (const path of routes) {
      assert.equal((await app.request(route(path, "a"), { headers })).status, 200, path);
      assert.equal((await app.request(route(path, "b", "order-b"), { headers })).status, 404, path);
      assert.equal((await app.request(route(path, "a"), { headers: { cookie: "session=wrong" } })).status, 401, path);
    }
    for (const path of ["/notifications", "/callback-attempts"]) {
      assert.equal((await app.request(route(path, "a", "order-b"), { headers })).status, 404, path);
    }
    store.payment.merchants.push({ id: "duplicate", apiId: "api-a", userId: "other", enabled: false });
    for (const path of routes) assert.equal((await app.request(route(path, "a"), { headers })).status, 503, path);
    store.payment.merchants.pop();
    store.payment.merchants[0].apiId = "api-changed";
    for (const path of routes) assert.equal((await app.request(route(path, "a"), { headers })).status, 404, path);
    store.payment.merchants[0].apiId = "api-a";
    store.payment.merchants[0].members[0].enabled = false;
    for (const path of routes) assert.equal((await app.request(route(path, "a"), { headers })).status, 404, path);
  } finally { sql.close(); await new Promise((resolve) => server.close(resolve)); }
});
