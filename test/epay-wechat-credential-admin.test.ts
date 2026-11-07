import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createApp } from "../src/http/app.ts";
import { createConfiguredHttpServices, HTTP_TEST_ADMIN_PASSWORD } from "./http-fixture.ts";
import type { AppDatabase } from "../src/database/database.ts";

function mainWorkspace(database: AppDatabase) {
  database.write(sql => sql.exec("INSERT INTO epay_merchant_accounts VALUES(1,'Main identity fixture',0,1,500,0,0); INSERT INTO epay_merchant_bindings VALUES('binding','main-api','main-merchant',1,0,0)"));
  const identityFetch: typeof fetch = async (_request, init) => {
    assert.ok(new Headers(init?.headers).get("cookie"), "current main-site authorization must receive the browser session");
    return Response.json({ ok: true, merchantId: "main-merchant", apiId: "main-api", userId: "main-administrator", role: "admin" });
  };
  return { identityOrigin: "http://127.0.0.1:8787", identityFetch };
}

it("limits shadow credential administration to authenticated same-origin administrators", async () => {
  const directory = mkdtempSync(join(tmpdir(), "epay-wechat-admin-"));
  const services = await createConfiguredHttpServices({ directory, apiSecret: null, collectionCodePayload: "https://qr.alipay.com/test" });
  const dependencies = { ...services, startedAt: new Date() };
  const shadow = createApp({ ...dependencies, merchantWorkspace: mainWorkspace(services.database) });
  const demo = createApp({ ...dependencies, demoMode: true, merchantWorkspace: { identityOrigin: "http://127.0.0.1:8787" } });
  const disabled = createApp(dependencies);
  const path = "/api/admin/v1/epay/wechat-credentials";
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
  const secret = "fixture-secret-that-is-32-bytes!";
  const now = Date.now();
  const payload = { appId: "fixture-app", merchantId: "fixture-merchant", platformKey: key, platformKeyId: "fixture-serial", apiV3Key: secret, validFrom: now - 1000, validUntil: now + 60_000 };
  try {
    assert.equal((await disabled.request(path)).status, 404);
    assert.equal((await shadow.request(path)).status, 401);
    const login = await shadow.request("/api/admin/v1/session/login", { method: "POST", headers: { "content-type": "application/json", origin: services.config.publicOrigin }, body: JSON.stringify({ password: HTTP_TEST_ADMIN_PASSWORD, remember_me: true }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().map((value) => value.split(";", 1)[0]).join("; ");
    const loginData = ((await login.json()) as { data: { csrf_token: string; username: string } }).data;
    const csrf = loginData.csrf_token;
    const headers = { cookie, "content-type": "application/json", origin: services.config.publicOrigin, "x-csrf-token": csrf };
    assert.equal((await shadow.request(path, { method: "POST", headers: { ...headers, "x-csrf-token": "wrong" }, body: JSON.stringify(payload) })).status, 403);
    assert.equal((await shadow.request(path, { method: "POST", headers: { ...headers, origin: "https://attacker.example" }, body: JSON.stringify(payload) })).status, 403);
    assert.equal((await demo.request(path, { method: "POST", headers, body: JSON.stringify(payload) })).status, 403);
    assert.equal((await shadow.request(path, { method: "POST", headers, body: JSON.stringify({ ...payload, actor: "forged" }) })).status, 422);
    const created = await shadow.request(path, { method: "POST", headers, body: JSON.stringify(payload) });
    assert.equal(created.status, 201);
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    const listed = await shadow.request(path, { headers: { cookie } });
    assert.equal(listed.status, 200);
    assert.equal(listed.headers.get("cache-control"), "no-store");
    const text = await listed.text();
    assert.equal(text.includes(secret), false);
    assert.equal(text.includes(key), false);
    const data = (JSON.parse(text) as { data: Array<{ id: string; createdBy: string; revokedAt: number | null }> }).data;
    assert.equal(data.length, 1);
    assert.equal(data[0]?.id, id);
    assert.equal(data[0]?.createdBy, loginData.username);
    assert.equal((await shadow.request(`${path}?page=0`, { headers: { cookie } })).status, 400);
    const revoke = `${path}/${id}/revoke`;
    assert.equal((await demo.request(revoke, { method: "POST", headers, body: JSON.stringify({ reason: "rotation" }) })).status, 403);
    assert.equal((await shadow.request(revoke, { method: "POST", headers: { ...headers, "x-csrf-token": "wrong" }, body: JSON.stringify({ reason: "rotation" }) })).status, 403);
    assert.equal((await shadow.request(revoke, { method: "POST", headers, body: JSON.stringify({ reason: "rotation" }) })).status, 204);
    assert.equal((await shadow.request(revoke, { method: "POST", headers, body: JSON.stringify({ reason: "rotation" }) })).status, 400);
    const records = await shadow.request(path, { headers: { cookie } });
    const after = (await records.json()) as { data: Array<{ revokedAt: number | null; revokedBy: string; reason: string }> };
    assert.ok(after.data[0]?.revokedAt);
    assert.equal(after.data[0]?.reason, "rotation");
    assert.equal(after.data[0]?.revokedBy, loginData.username);
  } finally { services.database.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const action of ["register", "revoke"] as const) {
  it(`rejects a delayed credential ${action} after administrator logout`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "epay-wechat-session-"));
    const services = await createConfiguredHttpServices({ directory, apiSecret: null, collectionCodePayload: "https://qr.alipay.com/test" });
    const app = createApp({ ...services, startedAt: new Date(), merchantWorkspace: mainWorkspace(services.database) });
    const path = "/api/admin/v1/epay/wechat-credentials";
    const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
    const now = Date.now();
    const payload = { appId: "fixture-app", merchantId: "fixture-merchant", platformKey: key, platformKeyId: "fixture-serial", apiV3Key: "fixture-secret-that-is-32-bytes!", validFrom: now - 1000, validUntil: now + 60_000 };
    try {
      const login = await app.request("/api/admin/v1/session/login", { method: "POST", headers: { "content-type": "application/json", origin: services.config.publicOrigin }, body: JSON.stringify({ password: HTTP_TEST_ADMIN_PASSWORD, remember_me: true }) });
      assert.equal(login.status, 200);
      const cookie = login.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
      const csrf = ((await login.json()) as { data: { csrf_token: string } }).data.csrf_token;
      const headers = { cookie, "content-type": "application/json", origin: services.config.publicOrigin, "x-csrf-token": csrf };
      let target = path;
      if (action === "revoke") {
        const created = await app.request(path, { method: "POST", headers, body: JSON.stringify(payload) });
        assert.equal(created.status, 201);
        const id = ((await created.json()) as { data: { id: string } }).data.id;
        target = `${path}/${id}/revoke`;
      }
      const reading = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          reading.resolve();
          await release.promise;
          controller.enqueue(Buffer.from(JSON.stringify(action === "register" ? payload : { reason: "rotation" })));
          controller.close();
        },
      }, { highWaterMark: 0 });
      const request = new Request(services.config.publicOrigin + target, { method: "POST", headers, body, duplex: "half" } as RequestInit);
      const pending = app.request(request);
      try {
        await reading.promise;
        const logout = await app.request("/api/admin/v1/session/logout", { method: "POST", headers, body: "{}" });
        assert.ok(logout.ok);
      } finally { release.resolve(); }
      assert.equal((await pending).status, 403);
      const counts = services.database.read(db => ({
        credentials: Number(db.prepare("SELECT count(*) AS n FROM epay_wechat_credentials").get()?.n),
        revocations: Number(db.prepare("SELECT count(*) AS n FROM epay_wechat_credential_revocations").get()?.n),
      }));
      assert.deepEqual(counts, { credentials: action === "revoke" ? 1 : 0, revocations: 0 });
    } finally { services.database.close(); rmSync(directory, { recursive: true, force: true }); }
  });
}
