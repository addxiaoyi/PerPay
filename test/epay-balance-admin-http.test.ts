import assert from "node:assert/strict";
import { it } from "node:test";
import { balanceFixture } from "./epay-live-balance-fixture.ts";
import { createMainMerchantConsole } from "../src/epay-compat/main-merchant-console.ts";
import { installBalanceOpenings, planBalanceOpenings } from "../src/epay-compat/balance-opening.ts";

it("rejects merchant-forged balance writes and returns updated administrator balances with audit", async () => {
  const f = await balanceFixture(), now = 1_800_000_000_000;
  let revoked = false;
  const identityFetch: typeof fetch = async (_request, init) => {
    const cookie = new Headers(init?.headers).get("cookie");
    if (revoked || !["session=admin", "session=owner", "session=member"].includes(cookie ?? "")) return Response.json({ ok: false }, { status: 401 });
    return Response.json({ ok: true, merchantId: "main-1", apiId: "api-1", role: cookie?.slice(8), userId: cookie === "session=admin" ? "admin-id" : "merchant-id" });
  };
  const options = { database: f.db, masterKey: f.key, identityOrigin: "http://127.0.0.1:8787", publicOrigin: "https://gateway.example", allowAdministration: true, identityFetch, clock: () => now };
  const app = createMainMerchantConsole(options), path = "/balance/adjust?merchantId=main-1";
  const input = { requestId: "admin-adjustment-0001", deltaCents: -50, expectedVersion: 0, reason: "退款差额调整" };
  const snapshot = () => f.db.read(sql => Object.fromEntries(["epay_balance_openings", "epay_live_balances", "epay_balance_ledger", "epay_balance_adjustments", "audit_events"].map(table => [table, sql.prepare(`SELECT * FROM ${table}`).all()])));
  const post = (cookie: string, token: string, body: unknown = input, origin = options.publicOrigin) => app.request(path, { method: "POST", headers: { cookie, origin, "content-type": "application/json", "x-csrf-token": token, "x-role": "admin" }, body: JSON.stringify(body) });
  try {
    const preview = await app.request("/balance?merchantId=main-1", { headers: { cookie: "session=admin" } });
    assert.equal(preview.status, 200);
    assert.equal((await preview.json() as { data: { migrationBaselineVerified: boolean } }).data.migrationBaselineVerified, false);
    f.db.write(sql => installBalanceOpenings(sql, f.cipher, planBalanceOpenings(sql, f.cipher, "a".repeat(64)), now));
    const session = await app.request("/session?merchantId=main-1", { headers: { cookie: "session=admin" } });
    const token = (await session.json() as { data: { csrfToken: string } }).data.csrfToken;
    const before = snapshot();
    for (const role of ["owner", "member"]) {
      assert.equal((await post(`session=${role}`, token)).status, 403);
      assert.equal((await post(`session=${role}`, token, { ...input, allowNegative: true, actor: "admin-id" })).status, 403);
    }
    assert.equal((await post("session=admin", token, { ...input, allowNegative: true })).status, 400);
    assert.equal((await post("session=admin", "forged")).status, 403);
    assert.equal((await post("session=admin", token, input, "https://attacker.example")).status, 403);
    assert.equal((await app.request("/balance?merchantId=main-2", { headers: { cookie: "session=owner" } })).status, 403);
    revoked = true;
    assert.equal((await post("session=admin", token)).status, 401);
    revoked = false;
    assert.deepEqual(snapshot(), before);
    const changed = await post("session=admin", token);
    assert.equal(changed.status, 200);
    const value = (await changed.json() as { data: { availableCents: number; version: number } }).data;
    assert.deepEqual({ availableCents: value.availableCents, version: value.version }, { availableCents: 900, version: 1 });
    const balance = await app.request("/balance?merchantId=main-1", { headers: { cookie: "session=owner" } });
    assert.equal(balance.status, 200);
    assert.equal((await balance.json() as { data: { availableCents: number } }).data.availableCents, 900);
    const duplicate = await post("session=admin", token);
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json() as { data: { duplicate: boolean } }).data.duplicate, true);
    assert.equal((await post("session=admin", token, { ...input, requestId: "admin-adjustment-0002" })).status, 409);
    assert.equal((await post("session=admin", token, { ...input, requestId: "admin-adjustment-0002", expectedVersion: 1, deltaCents: -901 })).status, 409);
    assert.equal((await createMainMerchantConsole({ ...options, allowAdministration: false }).request(path, { method: "POST" })).status, 503);
    f.db.read(sql => {
      const adjustments = sql.prepare("SELECT actor_id,reason FROM epay_balance_adjustments").all();
      assert.equal(adjustments.length, 1);
      assert.equal(adjustments[0]?.actor_id, "admin-id");
      assert.equal(adjustments[0]?.reason, input.reason);
    });
  } finally { f.close(); }
});
