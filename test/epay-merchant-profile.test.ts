import assert from "node:assert/strict";
import { Hono } from "hono";
import { it } from "node:test";
import { balanceFixture } from "./epay-live-balance-fixture.ts";
import { createMerchantProfileRoutes } from "../src/epay-compat/merchant-profile-routes.ts";

it("keeps profile and main-key ownership at the identity authority while refusing member or cross-site mutations", async () => {
  const f = await balanceFixture();
  const profile = { id: "main-1", apiId: "api-1", displayName: "Original", callbackUrl: "https://merchant.example/notify" };
  let writes = 0, revoked = false;
  const root = "/api/merchant/epay/profile";
  const app = new Hono().route(root, createMerchantProfileRoutes({ database: f.db, masterKey: f.key, enabled: true,
    identityOrigin: "http://127.0.0.1:8787", publicOrigin: "https://gateway.example", clock: () => 1_800_000_000_000,
    identityFetch: async (input, init) => {
      const url = new URL(String(input)), headers = new Headers(init?.headers), role = headers.get("cookie");
      if (!role || revoked) return Response.json({ ok: false }, { status: 401 });
      if (url.searchParams.get("merchantId") !== "main-1") return Response.json({ ok: false }, { status: 403 });
      if (url.pathname.endsWith("/access")) return Response.json({ ok: true, merchantId: "main-1", apiId: "api-1", role, userId: role });
      if (url.pathname.endsWith("/keys")) return Response.json({ ok: true, apiId: "api-1", apiSecret: "synthetic-main-api-key" });
      assert.equal(url.pathname, "/api/merchant/profile");
      if (init?.method === "PATCH") { assert.equal(headers.get("origin"), "https://gateway.example"); writes++; Object.assign(profile, JSON.parse(String(init.body))); }
      return Response.json({ ok: true, merchant: { ...profile, internalNote: "not-public" } });
    } }));
  try {
    const response = await app.request(root + "?merchantId=main-1", { headers: { cookie: "owner" } });
    const body = await response.text(); assert.doesNotMatch(body, /not-public/);
    const token = JSON.parse(body).data.csrfToken;
    const command = { method: "POST", headers: { cookie: "owner", origin: "https://gateway.example", "content-type": "application/json", "x-csrf-token": token }, body: JSON.stringify({ displayName: "Updated", callbackUrl: "https://merchant.example/new" }) };
    assert.equal((await app.request(root + "?merchantId=main-1", { ...command, headers: { ...command.headers, cookie: "member" } })).status, 403);
    assert.equal((await app.request(root + "?merchantId=main-1", { ...command, headers: { ...command.headers, origin: "https://evil.example" } })).status, 403);
    assert.equal(writes, 0);
    assert.equal((await app.request(root + "?merchantId=main-1", command)).status, 200);
    assert.equal(writes, 1); assert.equal(profile.displayName, "Updated");
    assert.equal(f.db.read(sql => sql.prepare("SELECT name FROM epay_merchant_accounts WHERE merchant_id=1").get()?.name), "Updated");
    const key = await app.request(root + "/main-key?merchantId=main-1", { headers: { cookie: "owner" } });
    assert.equal(key.status, 200); assert.match(await key.text(), /synthetic-main-api-key/);
    assert.equal((await app.request(root + "/main-key?merchantId=main-2", { headers: { cookie: "owner" } })).status, 403);
    assert.equal((await app.request(root + "/main-key?merchantId=main-1", { headers: { cookie: "owner", "sec-fetch-site": "cross-site" } })).status, 403);
    revoked = true;
    assert.equal((await app.request(root + "/main-key?merchantId=main-1", { headers: { cookie: "owner" } })).status, 401);
  } finally { f.close(); }
});
