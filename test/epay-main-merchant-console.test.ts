import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { createMainMerchantConsole } from "../src/epay-compat/main-merchant-console.ts";
import { changeMerchantFee } from "../src/epay-compat/merchant-fee-admin.ts";

it("uses live main-site permissions for merchant access and auditable, CSRF-protected fee changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "perpay-main-console-"));
  const masterKey = randomBytes(32), database = await AppDatabase.open(join(directory, "db.sqlite"), { masterKey });
  let time = 1_800_000_000_000, revoked = false, changedBinding = false;
  const identityFetch: typeof fetch = async (request, init) => {
    const url = new URL(String(request));
    assert.equal(url.origin, "http://127.0.0.1:8787");
    assert.equal(url.pathname, "/api/merchant/access");
    const cookie = new Headers(init?.headers).get("cookie"), id = url.searchParams.get("merchantId");
    if (!["session=admin", "session=other-admin", "session=owner", "session=member"].includes(cookie ?? "") || revoked) return Response.json({ ok: false }, { status: 401 });
    if ((cookie === "session=owner" || cookie === "session=member") && id !== "main-1") return Response.json({ ok: false }, { status: 404 });
    const isAdmin = cookie === "session=admin" || cookie === "session=other-admin";
    if (!isAdmin && id !== "main-1") return Response.json({ ok: false }, { status: 404 });
    if (changedBinding) database.write(sql => sql.exec("UPDATE epay_merchant_bindings SET main_api_id='changed' WHERE epay_merchant_id=1"));
    return Response.json({ ok: true, merchantId: id, apiId: id === "main-1" ? "api-1" : "api-2", role: isAdmin ? "admin" : cookie === "session=owner" ? "owner" : "member", userId: isAdmin ? "admin-id" : "merchant-id" });
  };
  const options = { database, masterKey, identityOrigin: "http://127.0.0.1:8787", publicOrigin: "https://gateway.example", identityFetch, clock: () => time, allowAdministration: true };
  const app = createMainMerchantConsole(options), maintenance = createMainMerchantConsole({ ...options, allowAdministration: false });
  const path = "/fee?merchantId=main-1";
  const payload = { expectedFeeBps: 500, expectedVersion: 1, feeBps: 350, reason: "管理员调整费率" };
  const post = (token: string, cookie = "session=admin", extra: Record<string, string> = {}, body: unknown = payload) => app.request(path, { method: "POST", headers: { cookie, origin: options.publicOrigin, "content-type": "application/json", "x-csrf-token": token, ...extra }, body: JSON.stringify(body) });
  const token = async (cookie = "session=admin", merchantId = "main-1") => {
    const response = await app.request(`/session?merchantId=${merchantId}`, { headers: { cookie } });
    assert.equal(response.status, 200);
    return (await response.json() as { data: { csrfToken: string | null } }).data.csrfToken;
  };
  try {
    database.write(sql => sql.exec("INSERT INTO epay_merchant_accounts VALUES(1,'One',100,1,500,1,1),(2,'Two',200,1,500,1,1),(3,'Quarantined',300,0,0,1,1); INSERT INTO epay_merchant_bindings VALUES('b1','api-1','main-1',1,1,1),('b2','api-2','main-2',2,1,1)"));
    database.write(sql => sql.exec(`INSERT INTO epay_channels(channel_id,provider,code,name,product,enabled,rate_bps,created_at,updated_at)
      VALUES(1,'ALIPAY','alipay','Alipay','pc',1,0,0,0),(2,'WECHAT','wechat','WeChat','native',1,0,0,0);
      INSERT INTO system_metadata VALUES('epay_configured_channels','{"alipayChannelId":1,"wechatChannelId":2}',0)`));
    assert.equal((await app.request("/access")).status, 401);
    assert.equal((await app.request("/access", { headers: { cookie: "session=forged", "x-role": "admin" } })).status, 401);
    for (const [cookie, count] of [["session=admin", 2], ["session=owner", 1], ["session=member", 1]] as const) {
      const response = await app.request("/access", { headers: { cookie } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const directory = (await response.json() as { data: { merchants: unknown[]; collectionChannels: string[] } }).data;
      assert.equal(directory.merchants.length, count);
      assert.deepEqual(directory.collectionChannels, ["alipay_web", "wechat_native"]);
    }
    assert.equal(await token("session=owner"), null);
    assert.equal(await token("session=member"), null);
    assert.equal((await app.request("/fee?merchantId=main-2", { headers: { cookie: "session=owner" } })).status, 403);
    assert.equal((await app.request("/fee/history?merchantId=main-1", { headers: { cookie: "session=owner" } })).status, 403);
    const csrf = (await token())!;
    assert.equal((await post(csrf, "session=owner")).status, 403);
    assert.equal((await post(csrf, "session=member")).status, 403);
    assert.equal((await post(csrf, "session=other-admin")).status, 403);
    assert.equal((await post((await token("session=admin", "main-2"))!)).status, 403);
    assert.equal((await post(csrf, "session=admin", { origin: "https://attacker.example" })).status, 403);
    assert.equal((await post(csrf, "session=admin", { "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await post("invalid")).status, 403);
    assert.equal((await post(csrf, "session=admin", {}, { ...payload, actor: "forged" })).status, 400);
    assert.equal((await post(csrf, "session=admin", {}, { ...payload, reason: "x".repeat(6000) })).status, 400);
    time += 10 * 60 * 1000;
    assert.equal((await post(csrf)).status, 403);
    const fresh = (await token())!;
    assert.equal((await maintenance.request(path, { method: "POST", headers: { cookie: "session=admin" } })).status, 503);
    revoked = true;
    assert.equal((await post(fresh)).status, 401);
    revoked = false;
    assert.equal(Number(database.read(sql => sql.prepare("SELECT fee_rate_bps FROM epay_merchant_accounts WHERE merchant_id=1").get())?.fee_rate_bps), 500);
    assert.equal((await post(fresh)).status, 200);
    assert.equal((await post(fresh)).status, 409);
    const feeAudit = database.read(sql => sql.prepare("SELECT actor_id,details_json FROM audit_events WHERE action='epay.merchant_fee.updated'").all());
    assert.equal(feeAudit.length, 1);
    assert.equal(feeAudit[0]?.actor_id, "admin-id");
    assert.equal(JSON.parse(String(feeAudit[0]?.details_json)).reason, payload.reason);
    const history = await app.request("/fee/history?merchantId=main-1", { headers: { cookie: "session=admin" } });
    assert.equal(history.status, 200);
    assert.equal((await history.json() as { data: { changes: unknown[] } }).data.changes.length, 1);
    changedBinding = true;
    assert.equal((await app.request(path, { headers: { cookie: "session=admin" } })).status, 403);
    database.read(sql => {
      assert.equal(Number(sql.prepare("SELECT balance_cents FROM epay_merchant_accounts WHERE merchant_id=1").get()?.balance_cents), 100);
      for (const table of ["epay_orders", "epay_balance_ledger", "epay_callback_jobs"]) assert.equal(Number(sql.prepare(`SELECT count(*) n FROM ${table}`).get()?.n), 0);
    });
  } finally { database.close(); masterKey.fill(0); rmSync(directory, { recursive: true, force: true }); }
});

for (const endpoint of ["fee", "fee/history"] as const) {
  for (const revocation of ["binding changed", "merchant disabled"] as const) {
    it(`rejects ${endpoint} when ${revocation} after the authorization read`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "perpay-console-binding-race-"));
      const masterKey = randomBytes(32);
      const database = await AppDatabase.open(join(directory, "db.sqlite"), { masterKey });
      try {
        database.write(sql => sql.exec("INSERT INTO epay_merchant_accounts VALUES(1,'Private merchant',100,1,500,1,1); INSERT INTO epay_merchant_bindings VALUES('binding-1','api-1','main-1',1,1,1)"));
        changeMerchantFee(database, { merchantId: 1, expectedFeeBps: 500, expectedVersion: 1, feeBps: 350, reason: "Private contract reason", actor: "private-administrator" }, 100);
        const financialState = () => database.read(sql => ({
          merchant: sql.prepare("SELECT balance_cents,fee_rate_bps,updated_at FROM epay_merchant_accounts WHERE merchant_id=1").get(),
          audit: sql.prepare("SELECT * FROM audit_events ORDER BY sequence").all(),
          orders: sql.prepare("SELECT * FROM epay_orders").all(),
          ledger: sql.prepare("SELECT * FROM epay_balance_ledger").all(),
          callbacks: sql.prepare("SELECT * FROM epay_callback_jobs").all(),
        }));
        const before = financialState();
        const identityFetch: typeof fetch = async () => Response.json({ ok: true, merchantId: "main-1", apiId: "api-1", role: "admin", userId: "administrator" });
        const options = { masterKey, identityOrigin: "http://127.0.0.1:8787", publicOrigin: "https://gateway.example", allowAdministration: false, identityFetch };
        const path = `/${endpoint}?merchantId=main-1`, headers = { cookie: "session=administrator" };
        const control = await createMainMerchantConsole({ ...options, database }).request(path, { headers });
        assert.equal(control.status, 200);
        const controlBody = await control.text();
        assert.match(controlBody, endpoint === "fee" ? /"feeBps":350/ : /Private contract reason/);

        let revokedAfterAuthorization = false;
        const racingDatabase: Pick<AppDatabase, "read" | "write" | "instanceId"> = {
          instanceId: () => database.instanceId(),
          write: operation => database.write(operation),
          read: operation => {
            const authorized = database.read(operation);
            if (!revokedAfterAuthorization) {
              const binding = authorized as { main_api_id: string; epay_merchant_id: number | bigint };
              assert.equal(binding.main_api_id, "api-1");
              assert.equal(Number(binding.epay_merchant_id), 1);
              // Return the valid authorization snapshot, then race the subsequent protected read.
              database.write(sql => sql.exec(revocation === "binding changed"
                ? "UPDATE epay_merchant_bindings SET main_api_id='replacement-api' WHERE epay_merchant_id=1"
                : "UPDATE epay_merchant_accounts SET enabled=0 WHERE merchant_id=1"));
              revokedAfterAuthorization = true;
            }
            return authorized;
          },
        };
        const response = await createMainMerchantConsole({ ...options, database: racingDatabase }).request(path, { headers });
        assert.equal(revokedAfterAuthorization, true);
        assert.equal(response.status, 403);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const text = await response.text();
        const body = JSON.parse(text) as { ok?: boolean; data?: unknown };
        assert.equal(body.ok, false);
        assert.equal(Object.hasOwn(body, "data"), false);
        assert.doesNotMatch(text, /Private contract reason|private-administrator|"feeBps"|"changes"/);
        assert.deepEqual(financialState(), before);
      } finally { database.close(); masterKey.fill(0); rmSync(directory, { recursive: true, force: true }); }
    });
  }
}
