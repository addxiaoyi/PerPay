import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { registerPaymentRoutes } from "./fixtures/starmc-main/modules/payment/routes.js";
import { EPAY_COMPATIBILITY_SCHEMA_SQL } from "../src/epay-compat/schema.ts";
import { createMerchantWorkspace } from "../src/epay-compat/merchant-workspace.ts";
import { authorizeMainAdmin } from "../src/epay-compat/merchant-access.ts";
import { createMainOrdersWorkspace } from "../src/epay-compat/main-orders-workspace.ts";
import { EPAY_MAIN_ORDER_SOURCE_SCHEMA_SQL, writeEncryptedMainOrder } from "../src/epay-compat/main-order-source.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { CombinedShadowError, readCombinedShadowOrders } from "./fixtures/legacy-epay/perpay-shadow-combined-orders.ts";

const require = createRequire(new URL("../package.json", import.meta.url));
const express = require("express");

it("uses the main-site authorization route for exact merchant access and revocation", async () => {
  const store = { payment: { merchants: [
    { id: "main-a", apiId: "api-a", userId: "owner-a", enabled: true, members: [{ userId: "member-a", enabled: true }] },
    { id: "main-b", apiId: "api-b", userId: "owner-b", enabled: true, members: [] },
  ] } };
  const users = { "session=owner": { id: "owner-a", roles: [] }, "session=member": { id: "member-a", roles: [] }, "session=admin": { id: "admin", roles: ["superadmin"] }, "session=missing-id": { roles: ["superadmin"] } };
  const main = express();
  registerPaymentRoutes(main, {
    config: {}, getStore: () => store,
    requireUser: (req, res, next) => { req.user = users[req.headers.cookie]; return req.user ? next() : res.status(401).json({ ok: false }); },
    requireAdmin: (_req, _res, next) => next(),
    jsonOk: (res, body) => res.json({ ok: true, ...body }),
    jsonErr: (res, status, message, code) => res.status(status).json({ ok: false, message, code }),
    scheduleSave: () => { throw new Error("identity checks must not mutate state"); },
  });
  const server = await new Promise((resolve) => { const instance = main.listen(0, "127.0.0.1", () => resolve(instance)); });
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  const key = randomBytes(32), cipher = new RuntimeSecretCipher(key, "identity-fixture");
  try {
    const identityUrl = `http://127.0.0.1:${server.address().port}/api/merchant/access?merchantId=main-a`;
    const identity = await fetch(identityUrl, { headers: { cookie: "session=owner", "x-user-id": "forged", "x-user-role": "admin" } });
    assert.equal(identity.status, 200);
    assert.equal(identity.headers.get("cache-control"), "no-store");
    assert.deepEqual(await identity.json(), { ok: true, merchantId: "main-a", apiId: "api-a", userId: "owner-a", role: "owner" });
    assert.equal((await fetch(identityUrl, { headers: { cookie: "session=missing-id" } })).status, 404);
    assert.equal((await fetch(identityUrl, { headers: { "x-user-id": "admin", "x-user-role": "admin" } })).status, 401);
    db.exec(`${EPAY_COMPATIBILITY_SCHEMA_SQL} ${EPAY_MAIN_ORDER_SOURCE_SCHEMA_SQL}
      CREATE TABLE runtime_master_key_guard(singleton_key INTEGER PRIMARY KEY,cipher_version INTEGER,nonce BLOB,ciphertext BLOB,authentication_tag BLOB);
      INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES(1,'a',0,1,0,0),(2,'b',0,1,0,0);
      INSERT INTO epay_merchant_bindings VALUES('ba','api-a','main-a',1,0,0),('bb','api-b','main-b',2,0,0);
      INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES
        ('a-order','a-external',1,'a-order-name',100,'https://example.test','PENDING','PENDING',0,1,1),
        ('b-order','b-external',2,'b-order-name',100,'https://example.test','PENDING','PENDING',0,1,1)`);
    writeEncryptedMainOrder(db, cipher, JSON.stringify({ id: "historical-a", merchantId: "main-a", merchantOrderId: "a-external", amountCents: 100, status: "paid", createdAt: "2024-01-01T00:00:00Z", secret: "private-history" }));
    writeEncryptedMainOrder(db, cipher, JSON.stringify({ id: "historical-b", merchantId: "main-b", merchantOrderId: "b-private", amountCents: 100, status: "paid", createdAt: "2024-01-02T00:00:00Z" }));
    db.exec("INSERT INTO epay_main_order_import_runs VALUES(1,2)");
    const guard = cipher.createGuard();
    db.prepare("INSERT INTO runtime_master_key_guard VALUES(1,1,?,?,?)").run(guard.nonce, guard.ciphertext, guard.authenticationTag);
    const workspace = createMerchantWorkspace({ database: { read: (operation) => operation(db) }, identityOrigin: `http://127.0.0.1:${server.address().port}` });
    const adminOptions = { database: { read: operation => operation(db) }, origin: `http://127.0.0.1:${server.address().port}`, merchantId: "main-a" };
    assert.equal((await authorizeMainAdmin({ ...adminOptions, cookie: "session=admin" })).userId, "admin");
    await assert.rejects(authorizeMainAdmin({ ...adminOptions, cookie: "session=member" }));
    await assert.rejects(authorizeMainAdmin({ ...adminOptions, cookie: "session=missing-id" }));
    users["session=admin"].roles = [];
    await assert.rejects(authorizeMainAdmin({ ...adminOptions, cookie: "session=admin" }));
    users["session=admin"].roles = ["superadmin"];
    const combined = createMainOrdersWorkspace({ database: { read: operation => operation(db), instanceId: () => "identity-fixture" }, masterKey: key, identityOrigin: `http://127.0.0.1:${server.address().port}` });
    async function request(merchant, cookie) {
      const response = await workspace.request(`/orders?merchantId=${merchant}`, { headers: { cookie } });
      return { status: response.status, body: await response.json() };
    }
    const owner = await request("main-a", "session=owner");
    assert.equal(owner.status, 200);
    assert.equal(owner.body.data.role, "owner");
    assert.deepEqual(owner.body.data.orders.map((order) => order.tradeNo), ["a-order"]);
    assert.equal((await request("main-b", "session=owner")).status, 404);
    assert.equal((await request("main-a", "session=member")).body.data.role, "member");
    assert.equal((await request("main-b", "session=admin")).body.data.role, "admin");
    async function combinedRequest(merchant, cookie) {
      const response = await combined.request(`/combined-orders?merchantId=${merchant}`, { headers: { cookie } });
      return { status: response.status, body: await response.json() };
    }
    const history = await combinedRequest("main-a", "session=owner");
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.data.orders.map(order => [order.source, order.id]), [["main_site", "historical-a"], ["epay", "a-order"]]);
    assert.doesNotMatch(JSON.stringify(history), /private-history|b-private|historical-b/);
    assert.equal((await combinedRequest("main-b", "session=owner")).status, 404);
    assert.equal((await combinedRequest("main-a", "session=member")).status, 200);
    assert.equal((await combinedRequest("main-b", "session=admin")).status, 200);
    const proxyInput = { origin: "http://127.0.0.1:6190", cookie: "session=member", merchantId: "main-a", page: 1, pageSize: 20,
      fetch: (url, options) => combined.request(`/combined-orders${new URL(String(url)).search}`, options) };
    const proxied = await readCombinedShadowOrders(proxyInput);
    assert.deepEqual(proxied.orders.map(order => [order.source, order.id]), [["main_site", "historical-a"], ["epay", "a-order"]]);
    assert.doesNotMatch(JSON.stringify(proxied), /private-history|b-private|historical-b/);
    assert.equal(proxied.reconciled, false);
    store.payment.merchants[0].members[0].enabled = false;
    assert.equal((await request("main-a", "session=member")).status, 404);
    assert.equal((await combinedRequest("main-a", "session=member")).status, 404);
    await assert.rejects(() => readCombinedShadowOrders(proxyInput), error => error instanceof CombinedShadowError && error.status === 404);
    store.payment.merchants[0].apiId = "changed";
    assert.equal((await request("main-a", "session=owner")).status, 404);
    assert.equal((await combinedRequest("main-a", "session=owner")).status, 404);
    store.payment.merchants[0].apiId = "api-a";
    store.payment.merchants.push({ id: "main-a", apiId: "other", userId: "owner-b", enabled: true });
    assert.equal((await request("main-a", "session=owner")).status, 503);
    assert.equal((await combinedRequest("main-a", "session=owner")).status, 503);
    assert.equal((await request("main-a", "session=missing")).status, 401);
    assert.equal((await combinedRequest("main-a", "session=missing")).status, 401);
  } finally {
    db.close();
    key.fill(0);
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
