import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "node:test";
import { balanceFixture } from "./epay-live-balance-fixture.ts";
import { createMainMerchantConsole } from "../src/epay-compat/main-merchant-console.ts";

it("reveals only the live authorized merchant key and keeps metadata, history and failures secret-free", async () => {
  const f = await balanceFixture();
  let revoked = false, race = false;
  const identityFetch: typeof fetch = async (request, init) => {
    const merchantId = new URL(String(request)).searchParams.get("merchantId");
    const cookie = new Headers(init?.headers).get("cookie");
    if (revoked || !["session=admin", "session=owner", "session=member"].includes(cookie ?? "")) return Response.json({ ok: false }, { status: 401 });
    if (cookie !== "session=admin" && merchantId !== "main-1") return Response.json({ ok: false }, { status: 403 });
    if (race) f.db.write(sql => sql.exec("UPDATE epay_merchant_accounts SET enabled=0 WHERE merchant_id=1"));
    return Response.json({ ok: true, merchantId, apiId: merchantId === "main-1" ? "api-1" : "api-2", role: cookie!.slice(8), userId: "identity-user" });
  };
  const app = createMainMerchantConsole({ database: f.db, masterKey: f.key, identityOrigin: "http://127.0.0.1:8787", publicOrigin: "https://gateway.example", allowAdministration: false, identityFetch });
  try {
    f.db.write(sql => {
      for (const merchantId of [1, 2]) {
        const secret = `isolated-key-${merchantId}`, sealed = f.cipher.encrypt(`epay:merchant:${merchantId}:api_key`, 1, secret);
        sql.prepare("INSERT INTO epay_merchant_secrets VALUES(?,1,1,?,?,?,?,0)").run(merchantId, sealed.nonce, sealed.ciphertext, sealed.authenticationTag, createHash("sha256").update(secret).digest("hex"));
      }
    });
    const before = f.db.read(sql => sql.prepare("SELECT * FROM epay_merchant_secrets ORDER BY merchant_id").all());
    for (const role of ["admin", "owner", "member"]) {
      const metadata = await app.request("/keys/meta?merchantId=main-1", { headers: { cookie: `session=${role}` } });
      assert.equal(metadata.status, 200);
      assert.equal(metadata.headers.get("cache-control"), "no-store");
      const text = await metadata.text();
      assert.doesNotMatch(text, /isolated-key|ciphertext|nonce|fingerprint/i);
      assert.deepEqual(JSON.parse(text).data, { merchantId: "main-1", epayPid: "1", apiId: "api-1", keyConfigured: true });
      const revealed = await app.request("/keys?merchantId=main-1", { headers: { cookie: `session=${role}` } });
      assert.equal(revealed.status, 200);
      assert.equal((await revealed.json() as { data: { md5Key: string } }).data.md5Key, "isolated-key-1");
    }
    assert.equal((await app.request("/keys?merchantId=main-2", { headers: { cookie: "session=owner" } })).status, 403);
    assert.equal((await app.request("/keys?merchantId=main-1&merchantId=main-2", { headers: { cookie: "session=admin" } })).status, 403);
    assert.equal((await app.request("/keys?merchantId=main-1", { headers: { cookie: "session=owner", "sec-fetch-site": "cross-site" } })).status, 403);
    revoked = true;
    const refused = await app.request("/keys?merchantId=main-1", { headers: { cookie: "session=admin" } });
    assert.equal(refused.status, 401); assert.doesNotMatch(await refused.text(), /isolated-key/);
    revoked = false; race = true;
    assert.equal((await app.request("/keys?merchantId=main-1", { headers: { cookie: "session=admin" } })).status, 403);
    assert.deepEqual(f.db.read(sql => sql.prepare("SELECT * FROM epay_merchant_secrets ORDER BY merchant_id").all()), before);
  } finally { f.close(); }
});
