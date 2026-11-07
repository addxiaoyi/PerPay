import assert from "node:assert/strict";
import { it } from "node:test";
import { balanceFixture } from "./epay-live-balance-fixture.ts";
import { createMainMerchantConsole } from "../src/epay-compat/main-merchant-console.ts";

it("keeps membership in the main identity authority and refuses forged, revoked and cross-merchant writes", async () => {
  const f = await balanceFixture();
  const members = [{ userId: "member-1", username: "星光成员", enabled: true, addedAt: "2026-11-05T00:00:00Z" }];
  let writes = 0, revoked = false, changedBinding = false;
  const identityFetch: typeof fetch = async (request, init) => {
    const url = new URL(String(request)), headers = new Headers(init?.headers), cookie = headers.get("cookie");
    if (revoked || !["session=admin", "session=owner", "session=member"].includes(cookie ?? "")) return Response.json({ ok: false }, { status: 401 });
    if (url.pathname === "/api/merchant/access") return Response.json({ ok: true, merchantId: url.searchParams.get("merchantId"), apiId: "api-1", userId: "operator-1", role: cookie!.slice(8) });
    assert.equal(cookie, "session=admin");
    assert.equal(url.origin, "http://127.0.0.1:8787");
    assert.ok(url.pathname.startsWith("/api/admin/merchants/main-1/members"));
    if ((init?.method ?? "GET") !== "GET") {
      writes++;
      assert.equal(headers.get("origin"), "https://gateway.example");
      assert.equal(headers.get("host"), "gateway.example");
      const input = JSON.parse(String(init?.body));
      assert.deepEqual(Object.keys(input).sort(), ["enabled"]);
      members[0]!.enabled = input.enabled;
      if (changedBinding) f.db.write(sql => sql.exec("UPDATE epay_merchant_bindings SET main_api_id='rebound' WHERE epay_merchant_id=1"));
      return Response.json({ ok: true, merchant: { members, apiSecret: "must-never-forward" } });
    }
    return Response.json({ ok: true, members, internal: "must-never-forward" });
  };
  const options = { database: f.db, masterKey: f.key, identityOrigin: "http://127.0.0.1:8787", publicOrigin: "https://gateway.example", identityFetch, allowAdministration: true, clock: () => 1_800_000_000_000 };
  const app = createMainMerchantConsole(options);
  const path = "/members?merchantId=main-1";
  const token = async () => (await (await app.request("/session?merchantId=main-1", { headers: { cookie: "session=admin" } })).json() as { data: { csrfToken: string } }).data.csrfToken;
  const post = (csrf: string, cookie = "session=admin", body: unknown = { action: "set_status", userId: "member-1", enabled: false }) => app.request(path, { method: "POST", headers: { cookie, origin: options.publicOrigin, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await app.request(path)).status, 401);
    assert.equal((await app.request(path, { headers: { cookie: "session=owner" } })).status, 403);
    const read = await app.request(path, { headers: { cookie: "session=admin" } });
    assert.equal(read.status, 200); assert.equal(read.headers.get("cache-control"), "no-store");
    assert.deepEqual((await read.json() as { data: unknown }).data, { merchantId: "main-1", members });
    const csrf = await token();
    for (const cookie of ["session=owner", "session=member"]) assert.equal((await post(csrf, cookie)).status, 403);
    assert.equal((await post("bad")).status, 403);
    assert.equal((await post(csrf, "session=admin", { action: "set_status", userId: "../member-1", enabled: false })).status, 400);
    assert.equal((await post(csrf, "session=admin", { action: "set_status", userId: "member-1", enabled: false, role: "admin" })).status, 400);
    assert.equal(writes, 0);
    const changed = await post(csrf);
    assert.equal(changed.status, 200); assert.equal(writes, 1);
    assert.doesNotMatch(await changed.text(), /must-never-forward|apiSecret|internal/);
    assert.equal(members[0]!.enabled, false);
    revoked = true;
    assert.equal((await post(csrf)).status, 401); assert.equal(writes, 1);
    revoked = false;
    const maintenance = createMainMerchantConsole({ ...options, allowAdministration: false });
    assert.equal((await maintenance.request(path, { method: "POST" })).status, 503); assert.equal(writes, 1);
    changedBinding = true;
    assert.equal((await post(csrf)).status, 403);
    f.db.read(sql => {
      assert.equal(Number(sql.prepare("SELECT count(*) n FROM epay_balance_ledger").get()?.n), 0);
      assert.equal(Number(sql.prepare("SELECT count(*) n FROM epay_callback_jobs").get()?.n), 0);
    });
  } finally { f.close(); }
});
