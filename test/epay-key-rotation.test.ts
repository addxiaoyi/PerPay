import assert from "node:assert/strict";
import { it } from "node:test";
import { mainOrderFixture } from "./epay-main-native-fixture.ts";
import { createExactAlipayOrder } from "../src/epay-compat/exact-alipay-order.ts";
import { readMerchantSecret, readOrderSigningSecret } from "../src/epay-compat/merchant-secret.ts";
import { rotateMerchantKey } from "../src/epay-compat/merchant-key-rotation.ts";
import { epaySign, verifyEPaySign } from "../src/epay-compat/sign.ts";
import { EPayCallbackProcessor } from "../src/epay-compat/callback-processor.ts";
import { confirmAlipayPayment } from "../src/epay-compat/confirm-alipay.ts";
import { createSign } from "node:crypto";
import { Hono } from "hono";
import { createMerchantKeyRoutes } from "../src/epay-compat/merchant-key-routes.ts";
import { AppDatabase } from "../src/database/database.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";

const owner = { merchantId: "main-1", mainApiId: "lp-1", epayMerchantId: 1, role: "owner" as const, userId: "owner" };
const now = 1_800_000_000_000;
it("rotates merchant authentication while preserving each order's original callback signing key", async () => {
  const f = await mainOrderFixture();
  const fields = { pid: "1", type: "alipay", out_trade_no: "before-rotation", money: "1.01", name: "test", notify_url: "https://merchant.example/callback", clientip: "127.0.0.1", device: "pc" };
  const signed = (params: Record<string, string>, key: string) => ({ ...params, sign: epaySign(params, key), sign_type: "MD5" });
  try {
    const first = createExactAlipayOrder(f.database, f.masterKey, signed(fields, "epay-key-1"), "api", now);
    const counts = () => f.database.read(sql => Object.fromEntries(["epay_orders", "epay_balance_ledger", "epay_callback_jobs"].map(table => [table, Number(sql.prepare(`SELECT count(*) n FROM ${table}`).get()?.n)])));
    const before = counts();
    const command = { requestId: "key-rotation-request-001", expectedVersion: 1 };
    assert.throws(() => rotateMerchantKey(f.database, f.masterKey, { ...owner, role: "member" }, command, now + 1), /owner|admin/);
    assert.throws(() => rotateMerchantKey(f.database, f.masterKey, { ...owner, epayMerchantId: 2 }, command, now + 1), /binding/);
    const changed = rotateMerchantKey(f.database, f.masterKey, owner, command, now + 1);
    assert.equal(changed.version, 2);
    assert.equal(rotateMerchantKey(f.database, f.masterKey, owner, command, now + 2).version, 2);
    assert.deepEqual(counts(), before);
    const nextKey = f.database.read(sql => readMerchantSecret(sql, f.cipher, 1));
    assert.notEqual(nextKey, "epay-key-1");
    assert.equal(f.database.read(sql => readOrderSigningSecret(sql, f.cipher, 1, first.tradeNo)), "epay-key-1");
    assert.throws(() => createExactAlipayOrder(f.database, f.masterKey, signed({ ...fields, out_trade_no: "old-key-rejected" }, "epay-key-1"), "api", now + 3), /signature|sign|auth/);
    const second = createExactAlipayOrder(f.database, f.masterKey, signed({ ...fields, out_trade_no: "after-rotation" }, nextKey), "api", now + 3);
    assert.equal(f.database.read(sql => readOrderSigningSecret(sql, f.cipher, 1, second.tradeNo)), nextKey);
    for (const order of [first, second]) {
      const receipt: Record<string, string> = { app_id: "app", seller_id: "seller", out_trade_no: order.tradeNo, trade_no: `provider-${order.tradeNo}`, total_amount: "1.01", trade_status: "TRADE_SUCCESS", sign_type: "RSA2" };
      receipt.sign = createSign("RSA-SHA256").update(Object.keys(receipt).filter(key => key !== "sign_type").sort().map(key => `${key}=${receipt[key]}`).join("&")).sign(f.platform.privateKey, "base64");
      confirmAlipayPayment(f.database, receipt, now + 4);
    }
    const keys = new Map([[first.tradeNo, "epay-key-1"], [second.tradeNo, nextKey]]);
    let sent = 0;
    const processor = new EPayCallbackProcessor({ database: f.database, clock: () => now + 5,
      secret: (merchantId, tradeNo) => f.database.read(sql => readOrderSigningSecret(sql, f.cipher, merchantId, tradeNo!)),
      transport: () => ({ async post(request) { const params = Object.fromEntries(new URLSearchParams(request.body.toString())); assert.equal(verifyEPaySign(params, keys.get(params.trade_no!)!), true); sent++; return { status: 200, contentType: null, contentEncoding: null, responseFingerprint: "", resolvedAddressesFingerprint: "", connectedAddress: "", body: Buffer.from("success") }; }, async get() { throw new Error("unexpected fallback"); } }) });
    const policy = { timeoutMilliseconds: 1000, leaseMilliseconds: 2000, maximumAttempts: 2, retryDelayMilliseconds: 100 };
    await processor.processOne(policy); await processor.processOne(policy);
    assert.equal(sent, 2);
    const rows = f.database.read(sql => sql.prepare("SELECT details_json FROM audit_events WHERE action='epay.merchant_key.rotated'").all());
    assert.equal(rows.length, 1);
    assert.doesNotMatch(JSON.stringify(rows), new RegExp(nextKey));
    assert.throws(() => f.database.write(sql => sql.exec("DELETE FROM epay_order_key_versions")), /immutable/);
    const path = f.database.read(sql => String(sql.prepare("PRAGMA database_list").get()?.file));
    f.database.close();
    const reopened = await AppDatabase.open(path, { masterKey: f.masterKey });
    try {
      const cipher = new RuntimeSecretCipher(f.masterKey, reopened.instanceId());
      assert.equal(reopened.read(sql => readOrderSigningSecret(sql, cipher, 1, first.tradeNo)), "epay-key-1");
      assert.equal(reopened.read(sql => readOrderSigningSecret(sql, cipher, 1, second.tradeNo)), nextKey);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

it("requires live owner permission and CSRF for rotation without returning secrets in write responses", async () => {
  const f = await mainOrderFixture();
  const root = "/api/merchant/epay/keys";
  const app = new Hono().route(root, createMerchantKeyRoutes({ database: f.database, masterKey: f.masterKey, enabled: true,
    identityOrigin: "http://127.0.0.1:8787", publicOrigin: "https://gateway.example", clock: () => now, identityFetch: async (input, init) => {
      const role = new Headers(init?.headers).get("cookie");
      if (!["admin", "owner", "member"].includes(role ?? "")) return Response.json({ ok: false }, { status: 401 });
      if (new URL(String(input)).searchParams.get("merchantId") !== "main-1") return Response.json({ ok: false }, { status: 403 });
      return Response.json({ ok: true, merchantId: "main-1", apiId: "lp-1", role, userId: "user" });
    } }));
  try {
    const session = await app.request(root + "/rotation-session?merchantId=main-1", { headers: { cookie: "owner" } });
    const token = (await session.json() as { data: { csrfToken: string } }).data.csrfToken;
    const mutation = { method: "POST", headers: { cookie: "owner", "content-type": "application/json", origin: "https://gateway.example", "x-csrf-token": token }, body: JSON.stringify({ requestId: "rotation-http-000001", expectedVersion: 1 }) };
    const route = root + "/rotate?merchantId=main-1";
    assert.equal((await app.request(route, { ...mutation, headers: { ...mutation.headers, cookie: "member" } })).status, 403);
    assert.equal((await app.request(route, { ...mutation, headers: { ...mutation.headers, origin: "https://evil.example" } })).status, 403);
    assert.equal((await app.request(route.replace("main-1", "main-2"), mutation)).status, 403);
    assert.equal(f.database.read(sql => readMerchantSecret(sql, f.cipher, 1)), "epay-key-1");
    const accepted = await app.request(route, mutation);
    assert.equal(accepted.status, 200);
    const body = await accepted.text();
    assert.doesNotMatch(body, /secret|cipher|md5Key|epay-key/);
    assert.equal(JSON.parse(body).data.version, 2);
    const repeated = await app.request(route, mutation);
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json() as { data: { duplicate: boolean } }).data.duplicate, true);
  } finally { f.close(); }
});
