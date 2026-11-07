import assert from "node:assert/strict";
import { it } from "node:test";
import { Hono } from "hono";
import { balanceFixture } from "./epay-live-balance-fixture.ts";
import { createMainMerchantConsole } from "../src/epay-compat/main-merchant-console.ts";
import { createMerchantWorkspace } from "../src/epay-compat/merchant-workspace.ts";
import { createMainOrdersWorkspace } from "../src/epay-compat/main-orders-workspace.ts";
import { installBalanceOpenings, planBalanceOpenings } from "../src/epay-compat/balance-opening.ts";
import { withHttpFixture, login } from "./reconciliation-http-fixture.ts";
import { createApp } from "../src/http/app.ts";

for (const role of ["owner", "member"] as const) it(`${role} cannot list peers, read administrator records or write balances even with forged role headers`, async () => {
  const f = await balanceFixture();
  let identityCalls = 0;
  const identityFetch: typeof fetch = async (input, init) => {
    identityCalls++;
    const url = new URL(String(input)), cookie = new Headers(init?.headers).get("cookie");
    assert.equal(url.pathname, "/api/merchant/access");
    if (cookie !== "session=ordinary") return Response.json({ ok: false }, { status: 401 });
    if (url.searchParams.get("merchantId") !== "main-1") return Response.json({ ok: false }, { status: 404 });
    return Response.json({ ok: true, userId: "ordinary-user", merchantId: "main-1", apiId: "api-1", role });
  };
  const shared = { database: f.db, masterKey: f.key, identityOrigin: "http://127.0.0.1:8787", identityFetch };
  const app = new Hono().route("/", createMainMerchantConsole({ ...shared, publicOrigin: "https://gateway.example", allowAdministration: true }))
    .route("/", createMerchantWorkspace(shared)).route("/", createMainOrdersWorkspace(shared));
  const headers = { cookie: "session=ordinary", "x-role": "admin", "x-user-role": "superadmin", "x-user-id": "administrator", "x-merchant-id": "main-2" };
  try {
    f.db.write(sql => installBalanceOpenings(sql, f.cipher, planBalanceOpenings(sql, f.cipher, "a".repeat(64)), 1_800_000_000_000));
    const snapshot = () => f.db.read(sql => ["epay_orders", "epay_balance_openings", "epay_balance_ledger", "epay_callback_jobs", "audit_events"].map(table => sql.prepare(`SELECT * FROM ${table}`).all()));
    const before = snapshot();
    const directory = await app.request("/access", { headers });
    assert.equal(directory.status, 200);
    const access = await directory.json() as { data: { userId: string; merchants: Array<{ merchantId: string; role: string }> } };
    assert.equal(access.data.userId, "ordinary-user");
    assert.deepEqual(access.data.merchants.map(merchant => [merchant.merchantId, merchant.role]), [["main-1", role]]);
    const reads = ["portal/overview", "portal/orders", "portal/notifications", "portal/ledger", "portal/refunds", "portal/settlements", "orders", "combined-orders",
      "main-orders", "main-refunds", "balance", "ledger-entries", "invoices", "keys/meta", "keys", "fee", "refunds", "settlements", "profile", "profile/main-key", "members"];
    for (const path of reads) {
      const response = await app.request(`/${path}?merchantId=main-2`, { headers });
      assert.ok([403, 404].includes(response.status), `${path} must reject a peer`);
      assert.doesNotMatch(await response.text(), /legacy-2|Two|1900|ciphertext|apiSecret/);
    }
    for (const path of ["portal/overview", "portal/orders", "portal/notifications", "portal/ledger", "portal/refunds", "portal/settlements", "portal/system"]) {
      assert.equal((await app.request(`/${path}?merchantId=main-1&scope=admin`, { headers })).status, 403, path);
    }
    for (const path of ["portal/system", "members", "ledger-adjustments", "fee/history", "management"]) {
      assert.equal((await app.request(`/${path}?merchantId=main-1`, { headers })).status, 403, path);
    }
    for (const path of ["balance/adjust", "fee", "members", "management/status", "merchants/create", "refunds/unauthorized-refund/approve", "settlements/unauthorized-settlement/decision"]) {
      const response = await app.request(`/${path}?merchantId=main-1`, { method: "POST", headers: { ...headers, origin: "https://gateway.example", "content-type": "application/json", "x-csrf-token": "forged" },
        body: JSON.stringify({ allowNegative: true, deltaCents: -100, actor: "administrator", role: "admin" }) });
      assert.ok([400, 403].includes(response.status), `${path} must reject a forged mutation`);
    }
    const own = await app.request("/portal/orders?merchantId=main-1", { headers });
    assert.equal(own.status, 200); const ownBody = await own.text();
    assert.match(ownBody, /legacy-1/); assert.doesNotMatch(ownBody, /legacy-2|Two/);
    assert.equal((await app.request("/portal/orders?merchantId=main-1&merchantId=main-2", { headers })).status, 400);
    assert.deepEqual(snapshot(), before, "unauthorized requests must not change financial or audit records");
    assert.ok(identityCalls > 20);
  } finally { f.close(); }
});

it("a retained standalone administrator session cannot bypass a revoked main-site administrator role", async () => {
  await withHttpFixture(async ({ services, database }) => {
    database.write(sql => sql.exec("INSERT INTO epay_merchant_accounts VALUES(1,'Private merchant',0,1,500,0,0); INSERT INTO epay_merchant_bindings VALUES('binding','main-api','main-merchant',1,0,0)"));
    let role = "admin";
    const app = createApp({ config: services.config, database, identity: services.identity, settings: services.settings, orders: services.orders, startedAt: new Date(0),
      merchantWorkspace: { identityOrigin: "http://127.0.0.1:8787", identityFetch: async () => Response.json({ ok: true, merchantId: "main-merchant", apiId: "main-api", userId: "main-user", role }) } });
    const auth = await login(app);
    const request = (path: string) => app.request(path, { headers: { cookie: auth.cookie, "x-role": "admin" } });
    assert.equal((await request("/api/admin/v1/epay/merchants")).status, 200);
    role = "owner";
    for (const path of ["/api/admin/v1/epay/merchants", "/api/admin/v1/session", "/api/admin/v1/settings", "/api/admin/v1/orders"]) {
      const response = await request(path);
      assert.equal(response.status, 403, path);
      assert.doesNotMatch(await response.text(), /Private merchant|main-api/);
    }
    role = "admin";
    assert.equal((await request("/api/admin/v1/epay/merchants")).status, 200);
  });
});
