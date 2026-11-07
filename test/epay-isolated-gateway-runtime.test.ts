import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { Hono } from "hono";
import { AppDatabase } from "../src/database/database.ts";
import { createIsolatedGatewayRuntime } from "../src/epay-compat/isolated-gateway-runtime.ts";
import { EPayCallbackOutbox } from "../src/epay-compat/outbox.ts";
import { verifyEPaySign } from "../src/epay-compat/sign.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { recordSyntheticAlipayConfirmation } from "./epay-payment-fixture.ts";
import { createAlipayCallbackRoute } from "../src/epay-compat/alipay-callback-route.ts";
import { auditConfirmedPayments } from "../src/epay-compat/confirmation-audit.ts";

it("waits for admitted callbacks before final close and rejects later requests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-close-callback-"));
  const masterKey = randomBytes(32);
  const db = await AppDatabase.open(join(dir, "db.sqlite"), { masterKey });
  let release!: () => void, entered!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const channel = new Hono();
  const callback = new Hono().post("/notify", async c => { entered(); await pending; return c.text("accepted"); });
  const runtime = createIsolatedGatewayRuntime({
    gateway: { wechat: channel, alipay: channel, wechatCallback: callback, alipayCallback: callback }, database: db, masterKey,
    scheduler: { policy: { timeoutMilliseconds: 1000, leaseMilliseconds: 2000, maximumAttempts: 2, retryDelayMilliseconds: 10 }, intervalMilliseconds: 60_000, maximumPerRun: 1, onError: () => assert.fail("unexpected scheduler error") },
    transport: () => { throw new Error("unexpected delivery"); },
  });
  try {
    await runtime.quiesceOrders();
    const notification = runtime.app.request("/alipay/notify", { method: "POST" });
    await started;
    const closing = runtime.close();
    assert.equal(runtime.close(), closing);
    let done = false;
    void closing.then(() => { done = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(done, false);
    assert.equal((await runtime.app.request("/wechat/notify", { method: "POST" })).status, 503);
    assert.equal((await runtime.app.request("/api.php")).status, 503);
    release();
    assert.equal(await (await notification).text(), "accepted");
    await closing;
    assert.equal(done, true);
  } finally {
    release();
    await runtime.close();
    db.close();
    masterKey.fill(0);
    rmSync(dir, { recursive: true, force: true });
  }
});

it("retains a confirmed payment received after order shutdown and delivers it after reopening", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-stop-notify-"));
  const path = join(dir, "db.sqlite"), masterKey = randomBytes(32);
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const fields = { app_id: "app", seller_id: "seller", out_trade_no: "trade", trade_no: "provider", trade_status: "TRADE_SUCCESS", total_amount: "1.00" };
  const canonical = Object.keys(fields).sort().map(key => `${key}=${fields[key as keyof typeof fields]}`).join("&");
  const notice = { ...fields, sign_type: "RSA2", sign: sign("RSA-SHA256", Buffer.from(canonical), keys.privateKey).toString("base64") };
  let db = await AppDatabase.open(path, { masterKey });
  let deliveries = 0;
  const channel = new Hono().get("/mapi.php", c => c.text("not used"));
  const options = () => ({
    gateway: { wechat: channel, alipay: channel, wechatCallback: new Hono(), alipayCallback: createAlipayCallbackRoute(db, () => 100) },
    database: db, masterKey, clock: () => 100,
    scheduler: { policy: { timeoutMilliseconds: 1000, leaseMilliseconds: 2000, maximumAttempts: 2, retryDelayMilliseconds: 10 }, intervalMilliseconds: 60_000, maximumPerRun: 5, onError: () => assert.fail("unexpected scheduler error") },
    transport: () => ({ async post(request: { body: Buffer }) {
      assert.equal(verifyEPaySign(Object.fromEntries(new URLSearchParams(request.body.toString())), "fixture-key"), true);
      deliveries++;
      return { status: 200, body: Buffer.from("success"), contentType: null, contentEncoding: null, responseFingerprint: "", resolvedAddressesFingerprint: "", connectedAddress: "" };
    } }),
  });
  try {
    const secret = new RuntimeSecretCipher(masterKey, db.instanceId()).encrypt("epay:merchant:1:api_key", 1, "fixture-key");
    db.write(sql => {
      sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'fixture',0,1,0,0);
        INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,type_code,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at)
        VALUES ('trade','external',1,'alipay','item',100,'https://example.test/notify','PENDING','PENDING',0,1,1)`);
      sql.prepare("INSERT INTO epay_merchant_secrets VALUES (1,1,1,?,?,?,?,0)").run(secret.nonce, secret.ciphertext, secret.authenticationTag, createHash("sha256").update("fixture-key").digest("hex"));
      sql.prepare("INSERT INTO epay_alipay_intents VALUES ('trade',1,'app','seller',?,100,5,1)").run(publicKey);
    });
    const first = createIsolatedGatewayRuntime(options());
    await first.stop();
    const notify = () => first.app.request("/alipay/notify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(notice) });
    assert.equal(await (await notify()).text(), "success");
    assert.equal(await (await notify()).text(), "success");
    assert.equal(deliveries, 0);
    assert.equal(db.read(sql => sql.prepare("SELECT status FROM epay_callback_jobs WHERE trade_no='trade'").get())?.status, "PENDING");
    assert.deepEqual(db.read(auditConfirmedPayments), { confirmed: 1, inconsistent: 0, unconfirmedLedger: 0, unconfirmedCallbacks: 0, paidWithoutConfirmation: 0, intentPaidWithoutConfirmation: 0, paidWithoutIntent: 0 });
    db.close();
    db = await AppDatabase.open(path, { masterKey });
    const resumed = createIsolatedGatewayRuntime(options());
    try { assert.equal(await resumed.start(), 1); } finally { await resumed.stop(); }
    assert.equal(deliveries, 1);
    assert.equal(db.read(sql => sql.prepare("SELECT notify_status FROM epay_orders WHERE trade_no='trade'").get())?.notify_status, "SUCCESS");
    assert.deepEqual(db.read(auditConfirmedPayments), { confirmed: 1, inconsistent: 0, unconfirmedLedger: 0, unconfirmedCallbacks: 0, paidWithoutConfirmation: 0, intentPaidWithoutConfirmation: 0, paidWithoutIntent: 0 });
  } finally { db.close(); masterKey.fill(0); rmSync(dir, { recursive: true, force: true }); }
});

it("stops new orders and waits for in-flight order handlers while callbacks remain reachable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-drain-"));
  const masterKey = randomBytes(32);
  const db = await AppDatabase.open(join(dir, "db.sqlite"), { masterKey });
  let release!: () => void;
  let releaseSecond!: () => void;
  let entered!: () => void;
  let enteredCount = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const secondPending = new Promise<void>(resolve => { releaseSecond = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const channel = new Hono().get("/mapi.php", async c => { const index = ++enteredCount; if (index === 2) entered(); await (index === 1 ? pending : secondPending); return c.text("completed"); });
  const callback = new Hono().post("/notify", c => c.text("accepted"));
  const runtime = createIsolatedGatewayRuntime({
    gateway: { wechat: channel, alipay: channel, wechatCallback: callback, alipayCallback: callback },
    database: db, masterKey,
    scheduler: { policy: { timeoutMilliseconds: 1000, leaseMilliseconds: 2000, maximumAttempts: 2, retryDelayMilliseconds: 10 }, intervalMilliseconds: 60_000, maximumPerRun: 1, onError: () => assert.fail("unexpected scheduler error") },
    transport: () => { throw new Error("unexpected delivery"); },
  });
  try {
    const order = runtime.app.request("/mapi.php?type=alipay");
    const secondOrder = runtime.app.request("/mapi.php?type=alipay");
    await started;
    const shutdown = runtime.stop();
    assert.equal(runtime.stop(), shutdown);
    let complete = false;
    void shutdown.then(() => { complete = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(complete, false);
    assert.equal((await runtime.app.request("/submit.php?type=alipay")).status, 503);
    assert.equal(await (await runtime.app.request("/alipay/notify", { method: "POST" })).text(), "accepted");
    release();
    assert.equal(await (await order).text(), "completed");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(complete, false);
    releaseSecond();
    assert.equal(await (await secondOrder).text(), "completed");
    await shutdown;
    assert.equal(complete, true);
  } finally {
    release();
    releaseSecond();
    await runtime.stop();
    db.close();
    masterKey.fill(0);
    rmSync(dir, { recursive: true, force: true });
  }
});

it("resumes persisted callbacks across isolated runtime restarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-gateway-runtime-"));
  const path = join(dir, "db.sqlite");
  const masterKey = randomBytes(32);
  let db = await AppDatabase.open(path, { masterKey });
  const channel = new Hono().get("/mapi.php", c => c.text("isolated"));
  const callback = new Hono().post("/notify", c => c.text("fixture"));
  const deliveries: string[] = [];
  const options = () => ({
    gateway: { wechat: channel, alipay: channel, wechatCallback: callback, alipayCallback: callback },
    database: db,
    masterKey,
    clock: () => 100,
    scheduler: { policy: { timeoutMilliseconds: 1000, leaseMilliseconds: 2000, maximumAttempts: 2, retryDelayMilliseconds: 10 }, intervalMilliseconds: 60_000, maximumPerRun: 1, onError: () => assert.fail("unexpected scheduler error") },
    transport: () => ({ async post(request: { body: Buffer }) {
      const params = Object.fromEntries(new URLSearchParams(request.body.toString()));
      assert.equal(verifyEPaySign(params, "isolated-key"), true);
      deliveries.push(params.trade_no!);
      return { status: 200, body: Buffer.from("success"), contentType: null, contentEncoding: null, responseFingerprint: "", resolvedAddressesFingerprint: "", connectedAddress: "" };
    } }),
  });
  try {
    const sealed = new RuntimeSecretCipher(masterKey, db.instanceId()).encrypt("epay:merchant:1:api_key", 1, "isolated-key");
    db.write(sql => {
      sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'fixture',0,1,0,0);
        INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES
        ('a','a',1,'item',100,100,'https://example.test','PAID','PENDING',0,0,0),('b','b',1,'item',100,100,'https://example.test','PAID','PENDING',0,0,0),('c','c',1,'item',100,100,'https://example.test','PAID','PENDING',0,0,0)`);
      sql.prepare("INSERT INTO epay_merchant_secrets VALUES (1,1,1,?,?,?,?,0)").run(sealed.nonce, sealed.ciphertext, sealed.authenticationTag, createHash("sha256").update("isolated-key").digest("hex"));
      recordSyntheticAlipayConfirmation(sql, "a", 1);
      recordSyntheticAlipayConfirmation(sql, "b", 1);
      recordSyntheticAlipayConfirmation(sql, "c", 1);
    });
    const outbox = new EPayCallbackOutbox(db);
    outbox.enqueue("a", 1, 100);
    outbox.enqueue("b", 1, 100);
    outbox.enqueue("c", 1, 100);
    const first = createIsolatedGatewayRuntime(options());
    assert.deepEqual(deliveries, []);
    assert.equal(first.health().state, "idle");
    assert.equal(await (await first.app.request("/mapi.php?type=alipay")).text(), "isolated");
    assert.equal(await first.start(), 1);
    await first.quiesceOrders();
    assert.equal((await first.app.request("/mapi.php?type=alipay")).status, 503);
    assert.equal(first.health().state, "running");
    assert.equal(await first.start(), 1);
    assert.equal(await (await first.app.request("/alipay/notify", { method: "POST" })).text(), "fixture");
    await first.stop();
    assert.equal(first.health().state, "stopped");
    for (const path of ["/mapi.php?type=alipay", "/submit.php?type=alipay"]) {
      const response = await first.app.request(path);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal((await first.app.request(path, { method: "POST" })).status, 503);
    }
    assert.equal(await (await first.app.request("/alipay/notify", { method: "POST" })).text(), "fixture");
    assert.equal(await (await first.app.request("/wechat/notify", { method: "POST" })).text(), "fixture");
    await assert.rejects(first.start(), /stopped/);
    db.close();
    db = await AppDatabase.open(path, { masterKey });
    const second = createIsolatedGatewayRuntime(options());
    try {
      assert.equal(await second.start(), 1);
    } finally { await second.stop(); }
    assert.deepEqual(deliveries.sort(), ["a", "b", "c"]);
    assert.equal(Number(db.read(sql => sql.prepare("SELECT count(*) AS n FROM epay_callback_jobs WHERE status='SUCCEEDED'").get())?.n), 3);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
