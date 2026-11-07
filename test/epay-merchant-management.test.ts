import assert from "node:assert/strict";
import { Hono } from "hono";
import { it } from "node:test";
import { balanceFixture } from "./epay-live-balance-fixture.ts";
import { createMerchantManagementRoutes } from "../src/epay-compat/merchant-management-routes.ts";

it("limits merchant status changes to current admins and lets them restore a disabled bound merchant", async () => {
  const f = await balanceFixture();
  let enabled = true, mutations = 0;
  const app = new Hono().route("/management", createMerchantManagementRoutes({ database: f.db, masterKey: f.key, enabled: true,
    identityOrigin: "http://127.0.0.1:8787", publicOrigin: "https://gateway.example", clock: () => 1_800_000_000_000,
    identityFetch: async (input, init) => {
      const url = new URL(String(input)), role = new Headers(init?.headers).get("cookie");
      if (!role) return Response.json({ ok: false }, { status: 401 });
      if (url.pathname === "/api/merchant/access") return Response.json({ ok: true, merchantId: "main-1", apiId: "api-1", role, userId: role });
      assert.equal(role, "admin");
      if (url.pathname === "/api/admin/merchants") return Response.json({ ok: true, merchants: [{ id: "main-1", apiId: "api-1", displayName: "one", enabled: true }, { id: "main-2", apiId: "api-2", displayName: "two", enabled }] });
      assert.equal(url.pathname, "/api/admin/merchants/main-2/status");
      mutations++; enabled = JSON.parse(String(init?.body)).enabled;
      return Response.json({ ok: true, merchant: { id: "main-2", apiId: "api-2", enabled } });
    } }));
  try {
    assert.equal((await app.request("/management?merchantId=main-1", { headers: { cookie: "owner" } })).status, 403);
    const response = await app.request("/management?merchantId=main-1", { headers: { cookie: "admin" } });
    const token = (await response.json() as { data: { csrfToken: string } }).data.csrfToken;
    const change = (enable: boolean, cookie = "admin") => app.request("/management/status?merchantId=main-1", { method: "POST", headers: { cookie, "content-type": "application/json", origin: "https://gateway.example", "x-csrf-token": token }, body: JSON.stringify({ targetMerchantId: "main-2", enabled: enable }) });
    assert.equal((await change(false, "owner")).status, 403);
    assert.equal(mutations, 0);
    assert.equal((await change(false)).status, 200);
    assert.equal(f.db.read(sql => Number(sql.prepare("SELECT enabled FROM epay_merchant_accounts WHERE merchant_id=2").get()?.enabled)), 0);
    assert.equal((await change(true)).status, 200);
    assert.equal(f.db.read(sql => Number(sql.prepare("SELECT enabled FROM epay_merchant_accounts WHERE merchant_id=2").get()?.enabled)), 1);
    assert.equal(mutations, 2);
  } finally { f.close(); }
});
