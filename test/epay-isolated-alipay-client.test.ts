import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { RuntimeSettingsStore } from "../src/settings/store.ts";
import { createV3ResponseSignature } from "../src/infrastructure/alipay/v3.ts";
import type { V3Transport } from "../src/infrastructure/alipay/types.ts";
import { alipaySigningFingerprint, submitIsolatedAlipayPrecreate } from "../src/epay-compat/isolated-alipay-client.ts";
import { createConfiguredHttpServices } from "./http-fixture.ts";
import { createExactAlipayOrder } from "../src/epay-compat/exact-alipay-order.ts";
import { epaySign } from "../src/epay-compat/sign.ts";
import { confirmIsolatedAlipay } from "../src/epay-compat/isolated-alipay-confirmation.ts";
import { EPayCallbackProcessor } from "../src/epay-compat/callback-processor.ts";
import { verifyEPaySign } from "../src/epay-compat/sign.ts";
import { createIsolatedAlipayMAPI } from "../src/epay-compat/isolated-alipay-mapi.ts";
import { createIsolatedPaymentRuntime } from "../src/epay-compat/isolated-payment-runtime.ts";
import { createIsolatedEPayQuery } from "../src/epay-compat/isolated-api-query.ts";
import { createIsolatedAlipayCallbackRoute } from "../src/epay-compat/alipay-callback-route.ts";
import { queryIsolatedAlipaySubmission } from "../src/epay-compat/isolated-alipay-query.ts";

it("fences signed Alipay precreate, encrypts the verified QR and never retries uncertain requests", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-alipay-client-"));
  const services = await createConfiguredHttpServices({ directory: dir, apiSecret: null, collectionCodePayload: "https://qr.alipay.com/fixture" });
  const db = services.database, masterKey = services.config.masterKey, now = 1_800_000_000_000;
  const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const platformKey = platform.publicKey.export({ type: "spki", format: "pem" }).toString();
  try {
    new RuntimeSettingsStore(db, masterKey).initialize();
    const site = services.sites.create({ operation_id: randomUUID(), configuration: { name: "Fixture", accepting_orders: true, notifications_enabled: false, notification_origin: null, return_origin: null, policy: services.sites.defaults().policy } }, { actorId: "admin" });
    services.sites.rotateSecret(site.clientId, "api_secret", 0, { actorId: "admin" });
    const invalidSite = services.sites.create({ operation_id: randomUUID(), configuration: { name: "Invalid key fixture", accepting_orders: true, notifications_enabled: false, notification_origin: null, return_origin: null, policy: services.sites.defaults().policy } }, { actorId: "admin" });
    services.sites.rotateSecret(invalidSite.clientId, "api_secret", 0, { actorId: "admin" });
    const merchantSecret = new RuntimeSecretCipher(masterKey, db.instanceId()).encrypt("epay:merchant:1:api_key", 1, "fixture-merchant-key");
    const otherSecret = new RuntimeSecretCipher(masterKey, db.instanceId()).encrypt("epay:merchant:2:api_key", 1, "other-merchant-key");
    db.write((sql) => {
      sql.exec("INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,fee_rate_bps,created_at,updated_at) VALUES (1,'fixture',0,1,500,0,0)");
      sql.prepare("INSERT INTO epay_site_bindings VALUES (1,?,0)").run(site.clientId);
      sql.prepare("INSERT INTO epay_merchant_secrets VALUES (1,1,1,?,?,?,?,0)").run(merchantSecret.nonce, merchantSecret.ciphertext, merchantSecret.authenticationTag, createHash("sha256").update("fixture-merchant-key").digest("hex"));
      sql.prepare("INSERT INTO epay_alipay_bindings VALUES (?,'app','seller',?,?)").run(site.clientId, platformKey, alipaySigningFingerprint(merchant.privateKey));
      for (const tradeNo of ["order_1", "order_2", "order_3", "order_4"]) {
        sql.prepare("INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,type_code,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES (?,?,1,'alipay','fixture',101,'https://merchant.example/callback','PENDING','PENDING',0,?,?)").run(tradeNo, `external_${tradeNo}`, now, now);
        sql.prepare("INSERT INTO epay_alipay_intents(trade_no,merchant_id,app_id,seller_id,platform_public_key,amount_cents,fee_cents,created_at) VALUES (?,1,'app','seller',?,101,5,?)").run(tradeNo, platformKey, now);
        sql.prepare("INSERT INTO epay_alipay_orders VALUES (?,?)").run(tradeNo, site.clientId);
      }
      sql.exec("INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,fee_rate_bps,created_at,updated_at) VALUES (2,'invalid key fixture',0,1,500,0,0)");
      sql.prepare("INSERT INTO epay_merchant_secrets VALUES (2,1,1,?,?,?,?,0)").run(otherSecret.nonce, otherSecret.ciphertext, otherSecret.authenticationTag, createHash("sha256").update("other-merchant-key").digest("hex"));
      sql.prepare("INSERT INTO epay_site_bindings VALUES (2,?,0)").run(invalidSite.clientId);
      sql.prepare("INSERT INTO epay_alipay_bindings VALUES (?,'app','seller','invalid-key',?)").run(invalidSite.clientId, alipaySigningFingerprint(merchant.privateKey));
      sql.prepare("INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,type_code,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES ('invalid_key','invalid_external',2,'alipay','fixture',101,'https://merchant.example/callback','PENDING','PENDING',0,?,?)").run(now, now);
      sql.prepare("INSERT INTO epay_alipay_intents(trade_no,merchant_id,app_id,seller_id,platform_public_key,amount_cents,fee_cents,created_at) VALUES ('invalid_key',2,'app','seller','invalid-key',101,5,?)").run(now);
      sql.prepare("INSERT INTO epay_alipay_orders VALUES ('invalid_key',?)").run(invalidSite.clientId);
    });
    let calls = 0;
    const transport: V3Transport = { async request(request, options) {
      calls++;
      assert.equal(options.timeoutMilliseconds, 10_000);
      const body = JSON.parse(request.body) as { out_trade_no: string; total_amount: string };
      assert.equal(body.total_amount, "1.01");
      const match = /^ALIPAY-SHA256withRSA (.+),sign=(.+)$/.exec(String(request.headers.authorization));
      assert.ok(match);
      assert.match(match[1]!, /app_cert_sn=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
      assert.equal(request.headers["alipay-root-cert-sn"], "b".repeat(32));
      assert.equal(verify("RSA-SHA256", Buffer.from(`${match[1]}\nPOST\n${request.path}\n${request.body}\n`), merchant.publicKey, Buffer.from(match[2]!, "base64")), true);
      const raw = JSON.stringify({ out_trade_no: body.out_trade_no, qr_code: "https://qr.alipay.com/fixture" });
      return { status: 200, body: Buffer.from(raw), headers: { "alipay-timestamp": "1800000000", "alipay-nonce": "fixture", "alipay-signature": createV3ResponseSignature(raw, "1800000000", "fixture", platform.privateKey) } };
    } };
    const common = { database: db, masterKey, privateKey: merchant.privateKey, appCertSn: "a".repeat(32), alipayRootCertSn: "b".repeat(32), notifyUrl: "https://gateway.example/notify", transport, clock: () => now };
    const fields = { pid: "1", type: "alipay", out_trade_no: "new_external", money: "1.01", name: "fixture", clientip: "127.0.0.1", notify_url: "https://merchant.example/callback", device: "pc" };
    const signed = (input: Record<string, string>) => ({ ...input, sign: epaySign(input, "fixture-merchant-key"), sign_type: "MD5" });
    for (const key of ["sign", "trade_no", "%70id"]) {
      assert.throws(() => createExactAlipayOrder(db, masterKey, signed({ ...fields, notify_url: `https://merchant.example/callback?${key}=forged` }), "api", now), /callback URL/);
    }
    assert.throws(() => createExactAlipayOrder(db, masterKey, { ...signed(fields), money: "1.02" }, "api", now), /authentication/);
    const created = createExactAlipayOrder(db, masterKey, signed(fields), "api", now);
    db.write((sql) => sql.prepare("INSERT INTO epay_config_values(config_key,config_value,updated_at) VALUES ('order_expire_minutes','0.001',0)").run());
    let reservationClock = 0;
    const beforeExpiryCalls = calls;
    await assert.rejects(() => submitIsolatedAlipayPrecreate({ ...common, tradeNo: created.tradeNo, clock: () => reservationClock++ === 0 ? now : now + 60 }), /expired/);
    assert.equal(calls, beforeExpiryCalls);
    assert.equal(db.read((sql) => sql.prepare("SELECT 1 FROM epay_alipay_submissions WHERE trade_no=?").get(created.tradeNo)), undefined);
    db.write((sql) => sql.prepare("DELETE FROM epay_config_values WHERE config_key='order_expire_minutes'").run());
    assert.deepEqual(createExactAlipayOrder(db, masterKey, signed(fields), "api", now), { tradeNo: created.tradeNo, created: false });
    assert.throws(() => createExactAlipayOrder(db, masterKey, signed({ ...fields, money: "1.02" }), "api", now), /conflict/);
    const beforeConflict = db.read((sql) => ({
      orders: sql.prepare("SELECT count(*) AS n FROM epay_orders").get()?.n,
      intents: sql.prepare("SELECT count(*) AS n FROM epay_alipay_intents").get()?.n,
      ledger: sql.prepare("SELECT count(*) AS n FROM epay_balance_ledger").get()?.n,
      callbacks: sql.prepare("SELECT count(*) AS n FROM epay_callback_jobs").get()?.n,
    }));
    for (const changed of [{ notify_url: "https://merchant.example/other" }, { return_url: "https://merchant.example/return" }, { name: "changed" }, { param: "changed" }]) {
      assert.throws(() => createExactAlipayOrder(db, masterKey, signed({ ...fields, ...changed }), "api", now), /conflict/);
    }
    assert.throws(() => createExactAlipayOrder(db, masterKey, signed({ ...fields, device: "mobile" }), "api", now), /unsupported/);
    assert.deepEqual(db.read((sql) => ({
      orders: sql.prepare("SELECT count(*) AS n FROM epay_orders").get()?.n,
      intents: sql.prepare("SELECT count(*) AS n FROM epay_alipay_intents").get()?.n,
      ledger: sql.prepare("SELECT count(*) AS n FROM epay_balance_ledger").get()?.n,
      callbacks: sql.prepare("SELECT count(*) AS n FROM epay_callback_jobs").get()?.n,
    })), beforeConflict);
    assert.equal(Number(db.read((sql) => sql.prepare("SELECT fee_cents FROM epay_alipay_intents WHERE trade_no=?").get(created.tradeNo))?.fee_cents), 5);
    await assert.rejects(submitIsolatedAlipayPrecreate({ ...common, tradeNo: "invalid_key" }), /invalid Alipay platform public key/);
    assert.equal(Number(db.read((sql) => sql.prepare("SELECT count(*) AS n FROM epay_alipay_submissions WHERE trade_no='invalid_key'").get())?.n), 0);
    assert.equal(calls, 0);
    await assert.rejects(submitIsolatedAlipayPrecreate({ ...common, tradeNo: "order_1", privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey }), /unavailable/);
    assert.equal(calls, 0);
    await submitIsolatedAlipayPrecreate({ ...common, tradeNo: "order_1" });
    const row = db.read((sql) => sql.prepare("SELECT nonce,ciphertext,authentication_tag FROM epay_alipay_prepay WHERE trade_no='order_1'").get()) as { nonce: Uint8Array; ciphertext: Uint8Array; authentication_tag: Uint8Array };
    assert.equal(Buffer.from(row.ciphertext).includes(Buffer.from("qr.alipay.com")), false);
    const clear = new RuntimeSecretCipher(masterKey, db.instanceId()).decrypt("epay:config:alipay-prepay:order_1", 1, { cipherVersion: 1, nonce: Buffer.from(row.nonce), ciphertext: Buffer.from(row.ciphertext), authenticationTag: Buffer.from(row.authentication_tag) });
    assert.equal(clear.toString(), "https://qr.alipay.com/fixture");
    clear.fill(0);
    assert.equal(db.read((sql) => sql.prepare("SELECT state FROM epay_alipay_submissions WHERE trade_no='order_1'").get())?.state, "UNCERTAIN");
    assert.equal(db.read((sql) => sql.prepare("SELECT status FROM epay_orders WHERE trade_no='order_1'").get())?.status, "PENDING");
    let queries = 0;
    const queryTransport: V3Transport = { async request(request, options) {
      queries++;
      assert.equal(request.path, "/v3/alipay/trade/query");
      assert.equal(options.timeoutMilliseconds, 10_000);
      assert.deepEqual(JSON.parse(request.body), { out_trade_no: "order_1" });
      const raw = JSON.stringify({ out_trade_no: "order_1", trade_status: "TRADE_SUCCESS" });
      return { status: 200, body: Buffer.from(raw), headers: { "alipay-timestamp": "1800000000", "alipay-nonce": "fixture", "alipay-signature": createV3ResponseSignature(raw, "1800000000", "fixture", platform.privateKey) } };
    } };
    const beforeQuery = db.read((sql) => ({
      order: sql.prepare("SELECT status FROM epay_orders WHERE trade_no='order_1'").get(),
      ledger: sql.prepare("SELECT count(*) AS n FROM epay_balance_ledger").get(),
      callbacks: sql.prepare("SELECT count(*) AS n FROM epay_callback_jobs").get(),
    }));
    await assert.rejects(queryIsolatedAlipaySubmission({ database: db, tradeNo: "order_2", privateKey: merchant.privateKey, transport: queryTransport }), /binding/);
    await assert.rejects(queryIsolatedAlipaySubmission({ database: db, tradeNo: "order_1", privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey, transport: queryTransport }), /binding/);
    assert.equal(queries, 0);
    assert.deepEqual(await queryIsolatedAlipaySubmission({ database: db, tradeNo: "order_1", privateKey: merchant.privateKey, transport: queryTransport, clock: () => now }), { tradeNo: "order_1", tradeStatus: "TRADE_SUCCESS", amountMatch: "unavailable", sellerMatch: "unavailable", paymentConfirmed: false });
    assert.equal(queries, 1);
    assert.deepEqual(db.read((sql) => ({
      order: sql.prepare("SELECT status FROM epay_orders WHERE trade_no='order_1'").get(),
      ledger: sql.prepare("SELECT count(*) AS n FROM epay_balance_ledger").get(),
      callbacks: sql.prepare("SELECT count(*) AS n FROM epay_callback_jobs").get(),
    })), beforeQuery);
    await assert.rejects(submitIsolatedAlipayPrecreate({ ...common, tradeNo: "order_1" }), /already submitted/);
    await assert.rejects(submitIsolatedAlipayPrecreate({ ...common, tradeNo: "order_2", transport: { async request() { calls++; throw new Error("timeout"); } } }), /requires reconciliation/);
    await assert.rejects(submitIsolatedAlipayPrecreate({ ...common, tradeNo: "order_2" }), /already submitted/);
    await assert.rejects(submitIsolatedAlipayPrecreate({ ...common, tradeNo: "order_3", transport: { async request(request, options) { const response = await transport.request(request, options); return { ...response, body: Buffer.from("{}") }; } } }), /requires reconciliation/);
    assert.equal(db.read((sql) => sql.prepare("SELECT state FROM epay_alipay_submissions WHERE trade_no='order_3'").get())?.state, "UNCERTAIN");
    assert.equal(Number(db.read((sql) => sql.prepare("SELECT count(*) AS n FROM epay_alipay_prepay").get())?.n), 1);
    assert.equal(Number(db.read((sql) => sql.prepare("SELECT count(*) AS n FROM epay_balance_ledger").get())?.n), 0);
    assert.equal(calls, 3);
    await submitIsolatedAlipayPrecreate({ ...common, tradeNo: created.tradeNo });
    assert.equal(db.read((sql) => sql.prepare("SELECT status FROM epay_orders WHERE trade_no=?").get(created.tradeNo))?.status, "PENDING");
    const notice: Record<string, string> = { app_id: "app", seller_id: "seller", out_trade_no: created.tradeNo, trade_no: "provider-new", trade_status: "TRADE_SUCCESS", total_amount: "1.01" };
    const message = Object.keys(notice).sort().map((key) => `${key}=${notice[key]}`).join("&");
    const payment = { ...notice, sign_type: "RSA2", sign: sign("RSA-SHA256", Buffer.from(message), platform.privateKey).toString("base64") };
    const callbackRoute = createIsolatedAlipayCallbackRoute(db, () => now);
    const notify = (fields: Record<string, string>) => callbackRoute.request("/notify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
    assert.equal((await notify({ ...payment, total_amount: "1.02" })).status, 400);
    db.write((sql) => sql.exec("CREATE TRIGGER reject_alipay_settled BEFORE UPDATE ON epay_alipay_submissions WHEN NEW.state='SETTLED' BEGIN SELECT RAISE(ABORT,'fixture failure'); END"));
    assert.equal((await notify(payment)).status, 400);
    assert.equal(db.read((sql) => sql.prepare("SELECT status FROM epay_orders WHERE trade_no=?").get(created.tradeNo))?.status, "PENDING");
    assert.equal(Number(db.read((sql) => sql.prepare("SELECT count(*) AS n FROM epay_balance_ledger WHERE entry_id=?").get(`epay_payment:${created.tradeNo}`))?.n), 0);
    db.write((sql) => sql.exec("DROP TRIGGER reject_alipay_settled"));
    assert.equal(await (await notify(payment)).text(), "success");
    assert.equal(await (await notify(payment)).text(), "success");
    assert.equal(db.read((sql) => sql.prepare("SELECT state FROM epay_alipay_submissions WHERE trade_no=?").get(created.tradeNo))?.state, "SETTLED");
    assert.equal(Number(db.read((sql) => sql.prepare("SELECT available_delta_cents FROM epay_balance_ledger WHERE entry_id=?").get(`epay_payment:${created.tradeNo}`))?.available_delta_cents), 96);
    let callbacks = 0;
    const processor = new EPayCallbackProcessor({ database: db, clock: () => now, secret: () => "fixture-merchant-key", transport: () => ({ async post(request) {
      callbacks++;
      const payload = Object.fromEntries(new URLSearchParams(request.body.toString()));
      assert.equal(verifyEPaySign(payload, "fixture-merchant-key"), true);
      assert.equal(payload.trade_no, created.tradeNo);
      return { status: 200, body: Buffer.from("success"), contentType: null, contentEncoding: null, responseFingerprint: "", resolvedAddressesFingerprint: "", connectedAddress: "" };
    } }) });
    assert.equal(await processor.processOne({ timeoutMilliseconds: 1000, leaseMilliseconds: 2000, maximumAttempts: 1, retryDelayMilliseconds: 10 }), true);
    assert.equal(callbacks, 1);
    assert.equal(db.read((sql) => sql.prepare("SELECT status FROM epay_callback_jobs WHERE trade_no=?").get(created.tradeNo))?.status, "SUCCEEDED");
    await assert.rejects(submitIsolatedAlipayPrecreate({ ...common, tradeNo: "order_4", transport: { async request(request, options) {
      const raceNotice: Record<string, string> = { app_id: "app", seller_id: "seller", out_trade_no: "order_4", trade_no: "provider-race", trade_status: "TRADE_SUCCESS", total_amount: "1.01" };
      const content = Object.keys(raceNotice).sort().map((key) => `${key}=${raceNotice[key]}`).join("&");
      confirmIsolatedAlipay(db, { ...raceNotice, sign_type: "RSA2", sign: sign("RSA-SHA256", Buffer.from(content), platform.privateKey).toString("base64") }, now);
      return transport.request(request, options);
    } } }), /requires reconciliation/);
    assert.equal(db.read((sql) => sql.prepare("SELECT state FROM epay_alipay_submissions WHERE trade_no='order_4'").get())?.state, "SETTLED");
    assert.equal(db.read((sql) => sql.prepare("SELECT status FROM epay_orders WHERE trade_no='order_4'").get())?.status, "PAID");
    assert.equal(Number(db.read((sql) => sql.prepare("SELECT count(*) AS n FROM epay_alipay_prepay WHERE trade_no='order_4'").get())?.n), 0);
    const runtime = createIsolatedPaymentRuntime({
      database: db, masterKey, clock: () => now,
      alipay: { privateKey: merchant.privateKey, appCertSn: common.appCertSn, alipayRootCertSn: common.alipayRootCertSn, notifyUrl: "https://gateway.example/alipay/notify", transport },
      wechat: { credentialId: "fixture", signingKeyId: "fixture", notifyUrl: "https://gateway.example/wechat/notify", transport: async () => { throw new Error("unexpected WeChat request"); } },
      callbackTransport: () => { throw new Error("scheduler must not start implicitly"); },
      scheduler: { policy: { timeoutMilliseconds: 1000, leaseMilliseconds: 2000, maximumAttempts: 2, retryDelayMilliseconds: 50 }, intervalMilliseconds: 60_000, maximumPerRun: 1, onError: () => assert.fail("unexpected scheduler error") },
    });
    const route = runtime.app;
    assert.equal(runtime.health().state, "idle");
    const send = (values: Record<string, string>) => route.request("/mapi.php", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values) });
    const request = signed({ ...fields, out_trade_no: "mapi_order" });
    const beforeCalls = calls;
    assert.equal((await send({ ...request, money: "2.00" })).status, 400);
    const first = await send(request);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), "no-store");
    const firstBody = await first.json() as { trade_no: string; qrcode: string };
    assert.equal(firstBody.qrcode, "https://qr.alipay.com/fixture");
    const lookup = (pid: string, key: string) => route.request("/api.php", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ act: "order", pid, key, trade_no: firstBody.trade_no }) });
    assert.equal((await (await lookup("1", "fixture-merchant-key")).json() as { payurl: string }).payurl, firstBody.qrcode);
    assert.equal((await (await lookup("2", "other-merchant-key")).json() as { code: number }).code, -1);
    const queryAt = async (time: number) => {
      const handler = createIsolatedEPayQuery({ database: db, masterKey, clock: () => time });
      const response = await handler.request("/api.php", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ act: "order", pid: "1", key: "fixture-merchant-key", trade_no: firstBody.trade_no }) });
      return await response.json() as { payurl: string };
    };
    assert.equal((await queryAt(now + 15 * 60_000 - 1)).payurl, firstBody.qrcode);
    assert.equal((await queryAt(now + 15 * 60_000)).payurl, "");
    assert.equal(db.read((sql) => sql.prepare("SELECT status FROM epay_orders WHERE trade_no=?").get(firstBody.trade_no))?.status, "PENDING");
    const expiredMAPI = createIsolatedAlipayMAPI({ ...common, clock: () => now + 15 * 60_000 });
    const expiredRetry = await expiredMAPI.request("/mapi.php", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(request) });
    assert.equal(expiredRetry.status, 409);
    assert.equal(calls, beforeCalls + 1);
    const unsentRequest = signed({ ...fields, out_trade_no: "expired-unsent" });
    const unsent = createExactAlipayOrder(db, masterKey, unsentRequest, "api", now);
    const expiredUnsent = await expiredMAPI.request("/mapi.php", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(unsentRequest) });
    assert.equal(expiredUnsent.status, 409);
    assert.equal(calls, beforeCalls + 1);
    assert.equal(db.read((sql) => sql.prepare("SELECT 1 FROM epay_alipay_submissions WHERE trade_no=?").get(unsent.tradeNo)), undefined);
    const expired = createIsolatedEPayQuery({ database: db, masterKey, clock: () => now + 2 * 60 * 60 * 1000 });
    const expiredResponse = await expired.request("/api.php", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ act: "order", pid: "1", key: "fixture-merchant-key", trade_no: firstBody.trade_no }) });
    assert.equal((await expiredResponse.json() as { payurl: string }).payurl, "");
    const retry = await send(request);
    assert.equal((await retry.json() as { trade_no: string }).trade_no, firstBody.trade_no);
    assert.equal(calls, beforeCalls + 1);
    assert.equal((await send({ ...request, pid: "2" })).status, 400);
    const otherFields = { ...fields, pid: "2", out_trade_no: "mapi_order" };
    const otherRequest = { ...otherFields, sign: epaySign(otherFields, "other-merchant-key"), sign_type: "MD5" };
    const otherResponse = await send(otherRequest);
    assert.equal(otherResponse.status, 409);
    assert.equal((await otherResponse.json() as { qrcode?: string }).qrcode, undefined);
    assert.notEqual(db.read((sql) => sql.prepare("SELECT trade_no FROM epay_orders WHERE merchant_id=2 AND out_trade_no='mapi_order'").get())?.trade_no, firstBody.trade_no);
    const mapiNotice: Record<string, string> = { app_id: "app", seller_id: "seller", out_trade_no: firstBody.trade_no, trade_no: "provider-mapi", trade_status: "TRADE_SUCCESS", total_amount: "1.01" };
    const mapiContent = Object.keys(mapiNotice).sort().map((key) => `${key}=${mapiNotice[key]}`).join("&");
    const mapiPayment = { ...mapiNotice, sign_type: "RSA2", sign: sign("RSA-SHA256", Buffer.from(mapiContent), platform.privateKey).toString("base64") };
    const notifyGateway = () => route.request("/alipay/notify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(mapiPayment) });
    assert.equal(await (await notifyGateway()).text(), "success");
    assert.equal(await (await notifyGateway()).text(), "success");
    assert.equal((await (await lookup("1", "fixture-merchant-key")).json() as { payurl: string }).payurl, "");
    assert.equal(db.read((sql) => sql.prepare("SELECT state FROM epay_alipay_submissions WHERE trade_no=?").get(firstBody.trade_no))?.state, "SETTLED");
    assert.equal(Number(db.read((sql) => sql.prepare("SELECT count(*) AS n FROM epay_callback_jobs WHERE trade_no=?").get(firstBody.trade_no))?.n), 1);
    assert.equal((await send(request)).status, 409);
    const revokedRoute = createIsolatedAlipayMAPI({ ...common, transport: { async request(input, options) {
      const response = await transport.request(input, options);
      db.write((sql) => sql.prepare("UPDATE epay_merchant_accounts SET enabled=0 WHERE merchant_id=1").run());
      return response;
    } } });
    const revokedFields = signed({ ...fields, out_trade_no: "mapi_revoked" });
    const revoked = await revokedRoute.request("/mapi.php", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(revokedFields) });
    assert.equal(revoked.status, 400);
    assert.equal((await revoked.json() as { qrcode?: string }).qrcode, undefined);
    db.write((sql) => sql.prepare("UPDATE epay_merchant_accounts SET enabled=1 WHERE merchant_id=1").run());
    const tamperedRoute = createIsolatedAlipayMAPI({ ...common, transport: { async request(input, options) {
      const response = await transport.request(input, options);
      const tradeNo = (JSON.parse(input.body) as { out_trade_no: string }).out_trade_no;
      db.write((sql) => sql.prepare("UPDATE epay_orders SET notify_url='https://other.example/callback' WHERE trade_no=?").run(tradeNo));
      return response;
    } } });
    const tamperedFields = signed({ ...fields, out_trade_no: "mapi_tampered" });
    const tampered = await tamperedRoute.request("/mapi.php", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(tamperedFields) });
    assert.equal(tampered.status, 400);
    assert.equal((await tampered.json() as { qrcode?: string }).qrcode, undefined);
    let timedOutCalls = 0;
    const failing = createIsolatedAlipayMAPI({ ...common, transport: { async request() { timedOutCalls++; throw new Error("timeout"); } } });
    const timeoutRequest = signed({ ...fields, out_trade_no: "mapi_timeout" });
    const sendTimeout = () => failing.request("/mapi.php", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(timeoutRequest) });
    assert.equal((await sendTimeout()).status, 202);
    assert.equal((await sendTimeout()).status, 202);
    assert.equal(timedOutCalls, 1);
    let parallelCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const parallelRoute = createIsolatedAlipayMAPI({ ...common, transport: { async request(input) {
      parallelCalls++;
      if (parallelCalls === 2) release();
      await Promise.race([gate, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("parallel submissions did not start")), 3000))]);
      const tradeNo = (JSON.parse(input.body) as { out_trade_no: string }).out_trade_no;
      const raw = JSON.stringify({ out_trade_no: tradeNo, qr_code: `https://qr.alipay.com/${tradeNo}` });
      return { status: 200, body: Buffer.from(raw), headers: { "alipay-timestamp": "1800000000", "alipay-nonce": "parallel", "alipay-signature": createV3ResponseSignature(raw, "1800000000", "parallel", platform.privateKey) } };
    } } });
    const parallelSend = (external: string) => parallelRoute.request("/mapi.php", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(signed({ ...fields, out_trade_no: external })) });
    const responses = await Promise.all([parallelSend("parallel_a"), parallelSend("parallel_b")]);
    const parallel = await Promise.all(responses.map(async (response) => {
      assert.equal(response.status, 200);
      return await response.json() as { trade_no: string; qrcode: string };
    }));
    assert.equal(parallelCalls, 2);
    assert.notEqual(parallel[0]!.trade_no, parallel[1]!.trade_no);
    for (const order of parallel) assert.equal(order.qrcode, `https://qr.alipay.com/${order.trade_no}`);
    const providerNotice = (tradeNo: string, provider: string) => {
      const values: Record<string, string> = { app_id: "app", seller_id: "seller", out_trade_no: tradeNo, trade_no: provider, trade_status: "TRADE_SUCCESS", total_amount: "1.01" };
      const content = Object.keys(values).sort().map((key) => `${key}=${values[key]}`).join("&");
      return { ...values, sign_type: "RSA2", sign: sign("RSA-SHA256", Buffer.from(content), platform.privateKey).toString("base64") };
    };
    assert.equal(await (await notify(providerNotice(parallel[0]!.trade_no, "provider-parallel-a"))).text(), "success");
    assert.equal((await notify(providerNotice(parallel[1]!.trade_no, "provider-parallel-a"))).status, 400);
    assert.equal(db.read((sql) => sql.prepare("SELECT status FROM epay_orders WHERE trade_no=?").get(parallel[1]!.trade_no))?.status, "PENDING");
    assert.equal(await (await notify(providerNotice(parallel[1]!.trade_no, "provider-parallel-b"))).text(), "success");
    for (const order of parallel) assert.equal(Number(db.read((sql) => sql.prepare("SELECT available_delta_cents FROM epay_balance_ledger WHERE entry_id=?").get(`epay_payment:${order.trade_no}`))?.available_delta_cents), 96);
    let unblock!: () => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const wait = new Promise<void>((resolve) => { unblock = resolve; });
    let sameOrderCalls = 0;
    const sameRoute = createIsolatedAlipayMAPI({ ...common, transport: { async request(input, options) {
      sameOrderCalls++;
      signalStarted();
      await wait;
      return transport.request(input, options);
    } } });
    const sameRequest = signed({ ...fields, out_trade_no: "concurrent_retry" });
    const sameSend = () => sameRoute.request("/mapi.php", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(sameRequest) });
    const firstPending = sameSend();
    try {
      await Promise.race([started, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("submission did not start")), 3000))]);
      assert.equal((await sameSend()).status, 202);
    }
    finally { unblock(); }
    assert.equal((await firstPending).status, 200);
    assert.equal(sameOrderCalls, 1);
    const pageFields = { ...fields, out_trade_no: "page_order", return_url: "https://merchant.example/return" };
    const pageRequest = signed(pageFields);
    const page = await route.request("/submit.php", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(pageRequest) });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    const html = await page.text();
    assert.match(html, /data:image\/png;base64,/);
    assert.doesNotMatch(html, /qr\.alipay\.com\/fixture/);
    const token = /name="checkout-token" content="([^"]+)"/.exec(html)?.[1];
    assert.ok(token);
    const status = () => route.request("/checkout-status", { headers: { "x-checkout-token": token } });
    assert.deepEqual(await (await status()).json(), { status: "pending" });
    const pageTrade = token.split(".")[0]!;
    const pageNotice = await route.request("/alipay/notify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(providerNotice(pageTrade, "provider-page")) });
    assert.equal(await pageNotice.text(), "success");
    const paidStatus = await (await status()).json() as { status: string; returnUrl: string };
    assert.equal(paidStatus.status, "paid");
    const destination = new URL(paidStatus.returnUrl);
    assert.equal(destination.origin + destination.pathname, "https://merchant.example/return");
    const returnParams = Object.fromEntries(destination.searchParams);
    assert.equal(verifyEPaySign(returnParams, "fixture-merchant-key"), true);
    assert.equal(returnParams.out_trade_no, "page_order");
    assert.equal(returnParams.money, "1.01");
    assert.equal(returnParams.trade_status, "TRADE_SUCCESS");
    const conflictingReturn = signed({ ...pageFields, out_trade_no: "reserved_return", return_url: "https://merchant.example/return?trade_status=PAID" });
    assert.equal((await route.request("/submit.php", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(conflictingReturn) })).status, 400);
    assert.equal((await route.request("/submit.php", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...pageRequest, money: "1.02" }) })).status, 400);
    await runtime.stop();
    assert.equal((await send(request)).status, 503);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
