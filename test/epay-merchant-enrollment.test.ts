import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { it } from "node:test";
import { mainOrderFixture } from "./epay-main-native-fixture.ts";
import { createEnrollmentRoutes } from "../src/epay-compat/merchant-enrollment-routes.ts";
import { completeMerchantEnrollment, reserveMerchantCreation } from "../src/epay-compat/merchant-enrollment.ts";
import { readLiveBalance } from "../src/epay-compat/live-balance.ts";
import { createExactAlipayOrder } from "../src/epay-compat/exact-alipay-order.ts";
import { readMerchantSecret } from "../src/epay-compat/merchant-secret.ts";
import { epaySign } from "../src/epay-compat/sign.ts";

const now = 1_800_000_000_000;
const admin = { merchantId: "main-1", mainApiId: "lp-1", epayMerchantId: 1, role: "admin" as const, userId: "admin" };
const merchant = { id: "00000000-0000-4000-8000-000000000003", apiId: "lp-3", userId: "new-owner", displayName: "新测试商户", callbackUrl: "https://merchant.example/notify", enabled: true, feeRate: 0.05, createdAt: new Date(now + 1).toISOString() };
async function fixture() {
  const f = await mainOrderFixture();
  f.database.write(sql => {
    sql.exec("INSERT INTO system_metadata VALUES('epay_cutover','{}',0)");
    sql.prepare("INSERT INTO epay_wechat_site_bindings SELECT client_id,'wx-app','mch',0 FROM epay_site_bindings").run();
  });
  return f;
}

it("enrolls only a newly requested main identity, creates a zero opening and rolls back partial enrollment", async () => {
  const f = await fixture();
  const command = { requestId: randomUUID(), userId: merchant.userId, displayName: merchant.displayName, callbackUrl: merchant.callbackUrl };
  try {
    assert.throws(() => reserveMerchantCreation(f.database, { ...admin, role: "owner" } as unknown as typeof admin, command, now), /forbidden/);
    assert.throws(() => reserveMerchantCreation(f.database, admin, { ...command, callbackUrl: "http://127.0.0.1/internal" }, now));
    reserveMerchantCreation(f.database, admin, command, now);
    assert.throws(() => completeMerchantEnrollment(f.database, f.masterKey, admin, command.requestId, { ...merchant, createdAt: new Date(now - 100000).toISOString() }, now + 1), /requested/);
    assert.throws(() => completeMerchantEnrollment(f.database, f.masterKey, admin, command.requestId, { ...merchant, userId: "other" }, now + 1), /requested/);
    f.database.write(sql => sql.exec("CREATE TRIGGER fail_enrollment BEFORE INSERT ON epay_live_balances BEGIN SELECT RAISE(ABORT,'fixture opening failure'); END"));
    assert.throws(() => completeMerchantEnrollment(f.database, f.masterKey, admin, command.requestId, merchant, now + 2), /opening failure/);
    assert.equal(Number(f.database.read(sql => sql.prepare("SELECT count(*) n FROM epay_merchant_accounts").get()?.n)), 2);
    f.database.write(sql => sql.exec("DROP TRIGGER fail_enrollment"));
    const completed = completeMerchantEnrollment(f.database, f.masterKey, admin, command.requestId, merchant, now + 3);
    assert.equal(completed.epayMerchantId, 3);
    assert.equal(completeMerchantEnrollment(f.database, f.masterKey, admin, command.requestId, merchant, now + 4).duplicate, true);
    assert.equal(f.database.read(sql => readLiveBalance(sql, 3)).availableCents, 0);
    assert.equal(f.database.read(sql => readLiveBalance(sql, 3)).frozenCents, 0);
    const fields = { pid: "3", type: "alipay", out_trade_no: "new-merchant-order", money: "1.01", name: "test", notify_url: merchant.callbackUrl, device: "pc", clientip: "127.0.0.1" };
    const secret = f.database.read(sql => readMerchantSecret(sql, f.cipher, 3));
    const order = createExactAlipayOrder(f.database, f.masterKey, { ...fields, sign: epaySign(fields, secret), sign_type: "MD5" }, "api", now + 5);
    assert.equal(order.created, true);
    assert.equal(Number(f.database.read(sql => sql.prepare("SELECT count(*) n FROM epay_callback_jobs").get()?.n)), 0);
    assert.equal(Number(f.database.read(sql => sql.prepare("SELECT count(*) n FROM epay_balance_ledger").get()?.n)), 0);
  } finally { f.close(); }
});

it("recovers a lost main creation response without creating a second merchant or exposing its key", async () => {
  const f = await fixture();
  let created = false, posts = 0;
  const root = "/api/merchant/epay/merchants", command = { requestId: randomUUID(), userId: merchant.userId, displayName: merchant.displayName, callbackUrl: merchant.callbackUrl };
  const app = new Hono().route(root, createEnrollmentRoutes({ database: f.database, masterKey: f.masterKey, enabled: true, identityOrigin: "http://127.0.0.1:8787", publicOrigin: "https://gateway.example", clock: () => now,
    identityFetch: async (input, init) => {
      const path = new URL(String(input)).pathname, cookie = new Headers(init?.headers).get("cookie");
      if (!cookie) return Response.json({ ok: false }, { status: 401 });
      if (path === "/api/merchant/access") return Response.json({ ok: true, merchantId: "main-1", apiId: "lp-1", role: cookie, userId: cookie });
      assert.equal(path, "/api/admin/merchants");
      if (init?.method === "POST") {
        assert.equal(cookie, "admin");
        assert.equal(new Headers(init.headers).get("origin"), "https://gateway.example");
        assert.deepEqual(JSON.parse(String(init.body)), { userId: merchant.userId, displayName: merchant.displayName, callbackUrl: merchant.callbackUrl });
        posts++; created = true; throw new Error("response lost after creation");
      }
      return Response.json({ ok: true, merchants: created ? [{ ...merchant, createdAt: new Date(now).toISOString(), apiSecret: "must-not-leak" }] : [] });
    } }));
  try {
    const session = await app.request(root + "/creation-session?merchantId=main-1", { headers: { cookie: "admin" } });
    const token = (await session.json() as { data: { csrfToken: string } }).data.csrfToken;
    const request = { method: "POST", headers: { cookie: "admin", origin: "https://gateway.example", "x-csrf-token": token, "content-type": "application/json" }, body: JSON.stringify(command) };
    assert.equal((await app.request(root + "/create?merchantId=main-1", { ...request, headers: { ...request.headers, cookie: "owner" } })).status, 403);
    assert.equal(posts, 0);
    assert.equal((await app.request(root + "/create?merchantId=main-1", request)).status, 503);
    const repeated = await app.request(root + "/create?merchantId=main-1", request);
    assert.equal(repeated.status, 201, await repeated.clone().text());
    assert.doesNotMatch(await repeated.text(), /must-not-leak|secret|cipher/);
    assert.equal(posts, 1);
    assert.equal((await app.request(root + "/create?merchantId=main-1", request)).status, 200);
    assert.equal(posts, 1);
  } finally { f.close(); }
});
