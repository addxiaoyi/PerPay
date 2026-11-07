import assert from "node:assert/strict";
import { createCipheriv, createHash, generateKeyPairSync, randomBytes, randomUUID, sign, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { RuntimeSettingsStore } from "../src/settings/store.ts";
import { createExactWechatOrder } from "../src/epay-compat/exact-wechat-order.ts";
import { confirmRegisteredWechatNotification, confirmRegisteredWechatQuery, registerWechatCredential, revokeWechatCredential } from "../src/epay-compat/wechat-credentials.ts";
import { epaySign } from "../src/epay-compat/sign.ts";
import { EPayCallbackProcessor } from "../src/epay-compat/callback-processor.ts";
import { expireWechatSubmission, markWechatSubmissionUncertain, reserveWechatSubmission } from "../src/epay-compat/wechat-submission.ts";
import { createConfiguredHttpServices } from "./http-fixture.ts";
import { queryWechatSubmission } from "../src/epay-compat/wechat-query-client.ts";
import { registerWechatSigningKey, revokeWechatSigningKey } from "../src/epay-compat/wechat-signing-keys.ts";
import { createIsolatedOrderRoute } from "../src/epay-compat/isolated-order-route.ts";
import { createWechatCallbackRoute } from "../src/epay-compat/wechat-callback-route.ts";
import { countWechatSubmissionViolations } from "../src/epay-compat/wechat-submission-integrity.ts";
import { auditConfirmedPayments } from "../src/epay-compat/confirmation-audit.ts";

it("persists authenticated same-amount orders and confirms only their unique provider transactions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-exact-order-"));
  const services = await createConfiguredHttpServices({ directory: dir, apiSecret: null, collectionCodePayload: "https://qr.alipay.com/fixture" });
  const masterKey = services.config.masterKey;
  let db = services.database;
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const apiKey = "w".repeat(32), signingKey = "merchant-fixture-key", now = 1_800_000_000_000;
  try {
    new RuntimeSettingsStore(db, masterKey).initialize();
    const site = services.sites.create({ operation_id: randomUUID(), configuration: { name: "Fixture", accepting_orders: true, notifications_enabled: false, notification_origin: null, return_origin: null, policy: services.sites.defaults().policy } }, { actorId: "admin" });
    services.sites.rotateSecret(site.clientId, "api_secret", 0, { actorId: "admin" });
    const cipher = new RuntimeSecretCipher(masterKey, db.instanceId());
    const secret = cipher.encrypt("epay:merchant:1:api_key", 1, signingKey);
    db.write((sql) => {
      sql.exec("INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,fee_rate_bps,created_at,updated_at) VALUES (1,'merchant',0,1,500,0,0)");
      sql.prepare("INSERT INTO epay_site_bindings VALUES (1,?,0)").run(site.clientId);
      sql.prepare("INSERT INTO epay_wechat_site_bindings VALUES (?,'app','provider-merchant',0)").run(site.clientId);
      sql.prepare("INSERT INTO epay_merchant_secrets VALUES (1,1,1,?,?,?,?,0)").run(secret.nonce, secret.ciphertext, secret.authenticationTag, createHash("sha256").update(signingKey).digest("hex"));
    });
    const channel = { id: "channel-one", appId: "app", merchantId: "provider-merchant", platformKey: publicKey, platformKeyId: "serial", apiV3Key: apiKey, validFrom: now - 1000, validUntil: now + 1000, actor: "test-admin" };
    registerWechatCredential(db, masterKey, channel, now);
    registerWechatCredential(db, masterKey, { ...channel, id: "channel-other", merchantId: "other" }, now);
    const fields = { pid: "1", type: "wxpay", out_trade_no: "external-a", money: "1.01", name: "item", clientip: "127.0.0.1", notify_url: "https://example.test/callback", device: "pc" };
    const signed = (input: Record<string, string>) => ({ ...input, sign: epaySign(input, signingKey), sign_type: "MD5" });
    for (const key of ["sign", "trade_no", "%70id"]) {
      assert.throws(() => createExactWechatOrder(db, masterKey, signed({ ...fields, notify_url: `https://example.test/callback?${key}=forged` }), "api", channel.id, now), /callback URL/);
    }
    const firstRequest = signed(fields);
    assert.throws(() => createExactWechatOrder(db, masterKey, firstRequest, "api", "channel-other", now), /unavailable/);
    assert.throws(() => createExactWechatOrder(db, masterKey, { ...firstRequest, money: "1.02" }, "api", channel.id, now), /authentication/);
    assert.throws(() => createExactWechatOrder(db, masterKey, signed({ ...fields, notify_url: "http://example.test" }), "api", channel.id, now), /URL/);
    assert.throws(() => createExactWechatOrder(db, masterKey, signed({ ...fields, name: "   " }), "api", channel.id, now), /native order fields/);
    for (const notifyUrl of ["https://127.0.0.1/callback", "https://example.test/%0aheader"]) {
      assert.throws(() => createExactWechatOrder(db, masterKey, signed({ ...fields, notify_url: notifyUrl }), "api", channel.id, now), /callback URL/);
    }
    assert.equal(Number(db.read((sql) => sql.prepare("SELECT count(*) AS n FROM epay_orders").get())?.n), 0);
    const route = createIsolatedOrderRoute({ database: db, masterKey, credentialId: channel.id, clock: () => now });
    const submit = (params: Record<string, string>) => route.request("/mapi.php", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
    const invalidResponse = await submit({ ...firstRequest, money: "1.02" });
    assert.equal(invalidResponse.status, 400);
    const duplicateField = await route.request("/mapi.php", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `${new URLSearchParams(firstRequest)}&pid=1` });
    assert.equal(duplicateField.status, 400);
    assert.equal((await route.request("/mapi.php?pid=1", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(firstRequest) })).status, 400);
    const response = await submit(firstRequest);
    assert.equal(response.status, 202);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json() as { trade_no: string; created: boolean; isolated: boolean; payable: boolean };
    assert.equal(body.isolated, true);
    assert.equal(body.payable, false);
    const repeated = await submit(firstRequest);
    assert.equal(repeated.status, 202);
    const repeatedBody = await repeated.json() as typeof body;
    assert.equal(repeatedBody.trade_no, body.trade_no);
    assert.equal(repeatedBody.created, false);
    const first = { tradeNo: body.trade_no, credentialId: channel.id, created: body.created };
    assert.match(first.tradeNo, /^[a-f0-9]{32}$/);
    const retry = createExactWechatOrder(db, masterKey, firstRequest, "api", "channel-other", now);
    assert.equal(first.created, true);
    assert.deepEqual(retry, { tradeNo: first.tradeNo, credentialId: channel.id, created: false });
    db.write((sql) => sql.prepare("UPDATE epay_orders SET notify_url='https://other.example/callback' WHERE trade_no=?").run(first.tradeNo));
    assert.throws(() => createExactWechatOrder(db, masterKey, firstRequest, "api", channel.id, now), /conflict/);
    db.write((sql) => sql.prepare("UPDATE epay_orders SET notify_url=? WHERE trade_no=?").run(fields.notify_url, first.tradeNo));
    assert.throws(() => createExactWechatOrder(db, masterKey, signed({ ...fields, money: "1.02" }), "api", channel.id, now), /conflict/);
    const beforeConflict = db.read((sql) => ({
      orders: sql.prepare("SELECT count(*) AS n FROM epay_orders").get()?.n,
      intents: sql.prepare("SELECT count(*) AS n FROM epay_wechat_intents").get()?.n,
      ledger: sql.prepare("SELECT count(*) AS n FROM epay_balance_ledger").get()?.n,
      callbacks: sql.prepare("SELECT count(*) AS n FROM epay_callback_jobs").get()?.n,
    }));
    for (const changed of [{ notify_url: "https://example.test/other" }, { return_url: "https://example.test/return" }, { name: "changed" }, { param: "changed" }]) {
      assert.throws(() => createExactWechatOrder(db, masterKey, signed({ ...fields, ...changed }), "api", channel.id, now), /conflict/);
    }
    assert.throws(() => createExactWechatOrder(db, masterKey, signed({ ...fields, device: "mobile" }), "api", channel.id, now), /unsupported/);
    assert.deepEqual(db.read((sql) => ({
      orders: sql.prepare("SELECT count(*) AS n FROM epay_orders").get()?.n,
      intents: sql.prepare("SELECT count(*) AS n FROM epay_wechat_intents").get()?.n,
      ledger: sql.prepare("SELECT count(*) AS n FROM epay_balance_ledger").get()?.n,
      callbacks: sql.prepare("SELECT count(*) AS n FROM epay_callback_jobs").get()?.n,
    })), beforeConflict);
    const second = createExactWechatOrder(db, masterKey, signed({ ...fields, out_trade_no: "external-b" }), "api", channel.id, now);
    assert.match(second.tradeNo, /^[a-f0-9]{32}$/);
    assert.notEqual(second.tradeNo, first.tradeNo);
    assert.throws(() => db.write((sql) => sql.prepare("UPDATE epay_wechat_site_bindings SET provider_merchant_id='other' WHERE client_id=?").run(site.clientId)), /immutable/);
    const intent = db.read((sql) => sql.prepare("SELECT amount_cents,fee_cents FROM epay_wechat_intents WHERE trade_no=?").get(first.tradeNo));
    assert.equal(Number(intent?.amount_cents), 101);
    assert.equal(Number(intent?.fee_cents), 5);
    db.write((sql) => sql.exec("CREATE TRIGGER reject_fixture BEFORE INSERT ON epay_exact_order_requests BEGIN SELECT RAISE(ABORT, 'fixture failure'); END"));
    assert.throws(() => createExactWechatOrder(db, masterKey, signed({ ...fields, out_trade_no: "rollback" }), "api", channel.id, now), /fixture failure/);
    assert.equal(Number(db.read((sql) => sql.prepare("SELECT count(*) AS n FROM epay_orders WHERE out_trade_no='rollback'").get())?.n), 0);
    assert.equal(Number(db.read((sql) => sql.prepare("SELECT count(*) AS n FROM epay_wechat_intents").get())?.n), 2);
    assert.equal(Number(db.read((sql) => sql.prepare("SELECT count(*) AS n FROM epay_exact_order_requests").get())?.n), 2);
    assert.equal(Number(db.read((sql) => sql.prepare("SELECT count(*) AS n FROM payment_orders").get())?.n), 0);
    db.write((sql) => sql.exec("DROP TRIGGER reject_fixture"));
    db.write((sql) => sql.prepare("UPDATE epay_orders SET name='   ' WHERE trade_no=?").run(first.tradeNo));
    assert.throws(() => reserveWechatSubmission(db, cipher, first.tradeNo, now, 1), /native order fields/);
    assert.equal(Number(db.read((sql) => sql.prepare("SELECT count(*) AS n FROM epay_wechat_submissions WHERE trade_no=?").get(first.tradeNo))?.n), 0);
    db.write((sql) => sql.prepare("UPDATE epay_orders SET name=? WHERE trade_no=?").run(fields.name, first.tradeNo));
    db.write((sql) => sql.prepare("INSERT INTO epay_config_values(config_key,config_value,updated_at) VALUES ('order_expire_minutes','0.001',0)").run());
    assert.throws(() => reserveWechatSubmission(db, cipher, first.tradeNo, now + 60, 1), /expired/);
    assert.throws(() => reserveWechatSubmission(db, cipher, first.tradeNo, now, 1, () => now + 60), /expired/);
    assert.equal(Number(db.read((sql) => sql.prepare("SELECT count(*) AS n FROM epay_wechat_submissions WHERE trade_no=?").get(first.tradeNo))?.n), 0);
    db.write((sql) => sql.prepare("DELETE FROM epay_config_values WHERE config_key='order_expire_minutes'").run());
    const reservation = reserveWechatSubmission(db, cipher, first.tradeNo, now, 1);
    assert.equal(reservation.amountCents, 101);
    assert.equal(reservation.providerMerchantId, "provider-merchant");
    assert.throws(() => reserveWechatSubmission(db, cipher, first.tradeNo, now, 1000), /already submitted/);
    assert.equal(expireWechatSubmission(db, first.tradeNo, now), false);
    assert.equal(expireWechatSubmission(db, first.tradeNo, now + 1), true);
    db.close();
    db = await AppDatabase.open(services.config.databasePath, { masterKey });
    assert.equal(db.read((sql) => sql.prepare("SELECT state FROM epay_wechat_submissions WHERE trade_no=?").get(first.tradeNo))?.state, "UNCERTAIN");
    assert.throws(() => markWechatSubmissionUncertain(db, first.tradeNo, reservation.leaseToken, now + 1), /stale/);
    assert.throws(() => reserveWechatSubmission(db, cipher, first.tradeNo, now + 1, 1000), /reconciliation/);
    db.write((sql) => sql.prepare("UPDATE epay_merchant_accounts SET enabled=0 WHERE merchant_id=1").run());
    assert.throws(() => reserveWechatSubmission(db, cipher, second.tradeNo, now, 1000), /unavailable/);
    db.write((sql) => sql.prepare("UPDATE epay_merchant_accounts SET enabled=1 WHERE merchant_id=1").run());
    const secondReservation = reserveWechatSubmission(db, cipher, second.tradeNo, now, 1000);
    assert.throws(() => markWechatSubmissionUncertain(db, second.tradeNo, "wrong-token", now), /stale/);
    markWechatSubmissionUncertain(db, second.tradeNo, secondReservation.leaseToken, now + 1);
    assert.throws(() => db.write((sql) => sql.prepare("DELETE FROM epay_wechat_submissions WHERE trade_no=?").run(first.tradeNo)), /immutable/);
    assert.throws(() => db.write((sql) => sql.prepare("UPDATE epay_wechat_submissions SET state='IN_FLIGHT',lease_token=?,lease_until=? WHERE trade_no=?").run(secondReservation.leaseToken, now + 1000, first.tradeNo)), /transition/);
    const notification = (tradeNo: string, providerTradeNo: string, cents = 101) => {
      const payload = { appid: "app", mchid: "provider-merchant", out_trade_no: tradeNo, transaction_id: providerTradeNo, trade_state: "SUCCESS", amount: { total: cents, currency: "CNY" } };
      const encryptor = createCipheriv("aes-256-gcm", Buffer.from(apiKey), Buffer.from("123456789012"));
      encryptor.setAAD(Buffer.from("transaction"));
      const ciphertext = Buffer.concat([encryptor.update(JSON.stringify(payload)), encryptor.final(), encryptor.getAuthTag()]).toString("base64");
      const body = Buffer.from(JSON.stringify({ event_type: "TRANSACTION.SUCCESS", resource: { algorithm: "AEAD_AES_256_GCM", nonce: "123456789012", associated_data: "transaction", ciphertext } }));
      const timestamp = String(now / 1000);
      const signature = sign("RSA-SHA256", Buffer.concat([Buffer.from(`${timestamp}\nnonce\n`), body, Buffer.from("\n")]), keys.privateKey).toString("base64");
      return { body, headers: new Headers({ "wechatpay-timestamp": timestamp, "wechatpay-nonce": "nonce", "wechatpay-serial": "serial", "wechatpay-signature": signature }) };
    };
    const badAmount = notification(first.tradeNo, "provider-a", 102);
    assert.throws(() => confirmRegisteredWechatNotification(db, masterKey, badAmount.body, badAmount.headers, now + 1), /amount/);
    const paymentA = notification(first.tradeNo, "provider-a");
    const callbacks = createWechatCallbackRoute(db, masterKey, () => now + 1);
    const notify = (body: Uint8Array, headers: Headers) => callbacks.request("/notify", { method: "POST", headers: new Headers([...headers, ["content-type", "application/json"]]), body: Buffer.from(body) });
    assert.equal((await notify(Buffer.concat([paymentA.body, Buffer.from(" ")]), paymentA.headers)).status, 400);
    db.write((sql) => sql.exec("CREATE TRIGGER reject_callback BEFORE INSERT ON epay_callback_jobs BEGIN SELECT RAISE(ABORT, 'callback failure'); END"));
    assert.equal((await notify(paymentA.body, paymentA.headers)).status, 400);
    const rolledBack = db.read((sql) => ({ order: sql.prepare("SELECT status FROM epay_orders WHERE trade_no=?").get(first.tradeNo), submission: sql.prepare("SELECT state FROM epay_wechat_submissions WHERE trade_no=?").get(first.tradeNo), ledger: sql.prepare("SELECT count(*) AS n FROM epay_balance_ledger").get() }));
    assert.equal(rolledBack.order?.status, "PENDING");
    assert.equal(rolledBack.submission?.state, "UNCERTAIN");
    assert.equal(Number(rolledBack.ledger?.n), 0);
    db.write((sql) => sql.exec("DROP TRIGGER reject_callback"));
    assert.equal((await notify(paymentA.body, paymentA.headers)).status, 204);
    assert.equal((await notify(paymentA.body, paymentA.headers)).status, 204);
    const replay = notification(second.tradeNo, "provider-a");
    assert.throws(() => confirmRegisteredWechatNotification(db, masterKey, replay.body, replay.headers, now + 1), /UNIQUE/);
    const queryBody = Buffer.from(JSON.stringify({ appid: "app", mchid: "provider-merchant", out_trade_no: second.tradeNo, transaction_id: "provider-b", trade_state: "SUCCESS", amount: { total: 101, currency: "CNY" } }));
    const timestamp = String(now / 1000);
    const querySignature = sign("RSA-SHA256", Buffer.concat([Buffer.from(`${timestamp}\nnonce\n`), queryBody, Buffer.from("\n")]), keys.privateKey).toString("base64");
    const queryHeaders = new Headers({ "wechatpay-timestamp": timestamp, "wechatpay-nonce": "nonce", "wechatpay-serial": "serial", "wechatpay-signature": querySignature });
    assert.throws(() => confirmRegisteredWechatQuery(db, masterKey, second.tradeNo, channel.id, 500, queryBody, queryHeaders, now + 1), /response/);
    assert.throws(() => confirmRegisteredWechatQuery(db, masterKey, second.tradeNo, "channel-other", 200, queryBody, queryHeaders, now + 1), /identity/);
    assert.throws(() => confirmRegisteredWechatQuery(db, masterKey, second.tradeNo, channel.id, 200, Buffer.concat([queryBody, Buffer.from(" ")]), queryHeaders, now + 1), /signature/);
    db.write((sql) => sql.exec("CREATE TRIGGER reject_query_callback BEFORE INSERT ON epay_callback_jobs BEGIN SELECT RAISE(ABORT, 'query callback failure'); END"));
    assert.throws(() => confirmRegisteredWechatQuery(db, masterKey, second.tradeNo, channel.id, 200, queryBody, queryHeaders, now + 1), /query callback failure/);
    assert.equal(db.read((sql) => sql.prepare("SELECT state FROM epay_wechat_submissions WHERE trade_no=?").get(second.tradeNo))?.state, "UNCERTAIN");
    assert.equal(db.read((sql) => sql.prepare("SELECT status FROM epay_orders WHERE trade_no=?").get(second.tradeNo))?.status, "PENDING");
    db.write((sql) => sql.exec("DROP TRIGGER reject_query_callback"));
    const merchantKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const signingInput = { id: "merchant-key", appId: channel.appId, merchantId: "provider-merchant", serial: "merchant-serial", privateKey: merchantKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKey: merchantKeys.publicKey.export({ type: "spki", format: "pem" }).toString(), validFrom: now, validUntil: now + 10_000, actor: "test-admin" };
    registerWechatSigningKey(db, masterKey, signingInput, now);
    assert.throws(() => registerWechatSigningKey(db, masterKey, { ...signingInput, id: "duplicate" }, now));
    assert.throws(() => registerWechatSigningKey(db, masterKey, { ...signingInput, id: "mismatch", publicKey: generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString() }, now), /mismatch/);
    registerWechatSigningKey(db, masterKey, { ...signingInput, id: "other-merchant", merchantId: "other" }, now);
    let queries = 0;
    const queryOptions = { database: db, masterKey, tradeNo: second.tradeNo, signingKeyId: "merchant-key", clock: () => now + 1, transport: (async (input, init) => {
      queries++;
      const url = new URL(String(input));
      assert.equal(url.origin, "https://api.mch.weixin.qq.com");
      assert.equal(url.pathname, `/v3/pay/transactions/out-trade-no/${second.tradeNo}`);
      assert.equal(url.search, "?mchid=provider-merchant");
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "error");
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      const match = /^WECHATPAY2-SHA256-RSA2048 mchid="provider-merchant",nonce_str="([a-f0-9]{32})",signature="([A-Za-z0-9+/=]+)",timestamp="(\d+)",serial_no="merchant-serial"$/.exec(authorization);
      assert.ok(match);
      assert.equal(verify("RSA-SHA256", Buffer.from(`GET\n${url.pathname}${url.search}\n${match[3]}\n${match[1]}\n\n`), merchantKeys.publicKey, Buffer.from(match[2]!, "base64")), true);
      return new Response(queryBody, { status: 200, headers: { ...Object.fromEntries(queryHeaders), "content-type": "application/json" } });
    }) as typeof fetch };
    await assert.rejects(() => queryWechatSubmission({ ...queryOptions, signingKeyId: "other-merchant" }), /identity/);
    await assert.rejects(() => queryWechatSubmission({ ...queryOptions, clock: () => now + 10_000 }), /unavailable/);
    assert.equal(queries, 0);
    await assert.rejects(() => queryWechatSubmission({ ...queryOptions, masterKey: randomBytes(32) }));
    assert.equal(queries, 0);
    await assert.rejects(() => queryWechatSubmission({ ...queryOptions, transport: async () => { throw new Error("offline"); } }), /unresolved/);
    await assert.rejects(() => queryWechatSubmission({ ...queryOptions, transport: async () => new Response("{}", { status: 500, headers: { "content-type": "application/json" } }) }), /successful response/);
    await assert.rejects(() => queryWechatSubmission({ ...queryOptions, transport: async () => new Response(Buffer.concat([queryBody, Buffer.from(" ")]), { status: 200, headers: { ...Object.fromEntries(queryHeaders), "content-type": "application/json" } }) }), /signature/);
    await assert.rejects(() => queryWechatSubmission({ ...queryOptions, transport: async () => new Response("x".repeat(65_537), { status: 200, headers: { ...Object.fromEntries(queryHeaders), "content-type": "application/json" } }) }), /could not be read/);
    registerWechatSigningKey(db, masterKey, { ...signingInput, id: "revoke-in-flight", serial: "revoke-in-flight" }, now);
    await assert.rejects(() => queryWechatSubmission({ ...queryOptions, signingKeyId: "revoke-in-flight", transport: async () => {
      revokeWechatSigningKey(db, "revoke-in-flight", "test-admin", "fixture", now + 1);
      return new Response(queryBody, { status: 200, headers: { ...Object.fromEntries(queryHeaders), "content-type": "application/json" } });
    } }), /signing key unavailable/);
    assert.equal(db.read((sql) => sql.prepare("SELECT state FROM epay_wechat_submissions WHERE trade_no=?").get(second.tradeNo))?.state, "UNCERTAIN");
    assert.equal(db.read((sql) => sql.prepare("SELECT status FROM epay_orders WHERE trade_no=?").get(second.tradeNo))?.status, "PENDING");
    assert.deepEqual(await queryWechatSubmission(queryOptions), { duplicate: false });
    assert.equal(queries, 1);
    const paymentB = notification(second.tradeNo, "provider-b");
    assert.deepEqual(confirmRegisteredWechatNotification(db, masterKey, paymentB.body, paymentB.headers, now + 1), { duplicate: true });
    assert.deepEqual(db.read((sql) => sql.prepare("SELECT state FROM epay_wechat_submissions ORDER BY state,trade_no").all()).map((row) => row.state), ["SETTLED", "SETTLED"]);
    assert.throws(() => markWechatSubmissionUncertain(db, second.tradeNo, secondReservation.leaseToken, now + 1), /stale/);
    const counts = db.read((sql) => ({ paid: sql.prepare("SELECT count(*) AS n FROM epay_orders WHERE status='PAID'").get(), ledger: sql.prepare("SELECT count(*) AS n FROM epay_balance_ledger WHERE available_delta_cents=96").get(), jobs: sql.prepare("SELECT count(*) AS n FROM epay_callback_jobs").get() }));
    assert.equal(Number(counts.paid?.n), 2);
    assert.equal(Number(counts.ledger?.n), 2);
    assert.equal(Number(counts.jobs?.n), 2);
    assert.equal(db.integrityCheck().ok, true);
    db.write((sql) => {
      sql.exec("SAVEPOINT audit_submission_fixture");
      try {
        assert.equal(auditConfirmedPayments(sql).inconsistent, 0);
        sql.exec("DROP TRIGGER epay_wechat_submissions_transition");
        sql.prepare("UPDATE epay_wechat_submissions SET state='UNCERTAIN' WHERE trade_no=?").run(first.tradeNo);
        assert.equal(auditConfirmedPayments(sql).inconsistent, 1);
      } finally {
        sql.exec("ROLLBACK TO audit_submission_fixture; RELEASE audit_submission_fixture");
      }
    });
    db.write((sql) => {
      sql.exec("SAVEPOINT conflicting_confirmation");
      try {
        sql.prepare("INSERT INTO epay_alipay_intents VALUES (?,1,'app','seller','key',101,5,0)").run(first.tradeNo);
        sql.prepare("INSERT INTO epay_alipay_confirmations VALUES (?,'other-provider',1,101,5,0)").run(first.tradeNo);
        assert.equal(countWechatSubmissionViolations(sql), 1);
      } finally {
        sql.exec("ROLLBACK TO conflicting_confirmation; RELEASE conflicting_confirmation");
      }
    });
    db.write((sql) => sql.prepare("UPDATE epay_orders SET type_code='alipay' WHERE trade_no=?").run(first.tradeNo));
    assert.equal(db.integrityCheck().ok, false);
    db.write((sql) => sql.prepare("UPDATE epay_orders SET type_code='wxpay' WHERE trade_no=?").run(first.tradeNo));
    assert.equal(db.integrityCheck().ok, true);
    db.write((sql) => sql.prepare("UPDATE epay_balance_ledger SET available_delta_cents=97 WHERE entry_id=?").run(`epay_payment:${first.tradeNo}`));
    assert.equal(db.integrityCheck().ok, false);
    db.write((sql) => sql.prepare("UPDATE epay_balance_ledger SET available_delta_cents=96 WHERE entry_id=?").run(`epay_payment:${first.tradeNo}`));
    assert.equal(db.integrityCheck().ok, true);
    let delivered = 0;
    const processor = new EPayCallbackProcessor({ database: db, clock: () => now + 1, secret: () => signingKey, transport: () => ({
      async post() {
        delivered++;
        return { status: 200, contentType: "text/plain", contentEncoding: null, body: Buffer.from("success"), responseFingerprint: "", resolvedAddressesFingerprint: "", connectedAddress: "" };
      },
    }) });
    const policy = { timeoutMilliseconds: 1000, leaseMilliseconds: 2000, maximumAttempts: 1, retryDelayMilliseconds: 50 };
    assert.equal(await processor.processOne(policy), true);
    assert.equal(await processor.processOne(policy), true);
    assert.equal(delivered, 2);
    const oldTradeNo = "12345678-1234-4234-8234-123456789abc";
    const oldFingerprint = createHash("sha256").update(JSON.stringify(["epay-exact-wechat-v1", 1, site.clientId, "external-old", 101, "item", "wxpay", fields.notify_url, "", "", "pc", ""])).digest("hex");
    const oldKey = cipher.encrypt(`epay:config:wechat-intent:${oldTradeNo}`, 1, apiKey);
    db.write((sql) => {
      sql.prepare(`INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,type_code,name,money_cents,notify_url,device,status,notify_status,notify_count,created_at,updated_at)
        VALUES (?,'external-old',1,'wxpay','item',101,?,'pc','PENDING','PENDING',0,?,?)`).run(oldTradeNo, fields.notify_url, now, now);
      sql.prepare(`INSERT INTO epay_wechat_intents(trade_no,merchant_id,app_id,provider_merchant_id,platform_key,platform_key_id,key_nonce,key_ciphertext,key_tag,amount_cents,fee_cents,created_at)
        VALUES (?,1,'app','provider-merchant',?,'serial',?,?,?,101,5,?)`).run(oldTradeNo, publicKey, oldKey.nonce, oldKey.ciphertext, oldKey.authenticationTag, now);
      sql.prepare("INSERT INTO epay_exact_order_requests VALUES (?, ?,?,'channel-one',500,?)").run(oldTradeNo, site.clientId, oldFingerprint, now);
    });
    assert.deepEqual(createExactWechatOrder(db, masterKey, signed({ ...fields, out_trade_no: "external-old" }), "api", channel.id, now), { tradeNo: oldTradeNo, credentialId: channel.id, created: false });
    assert.throws(() => reserveWechatSubmission(db, cipher, oldTradeNo, now, 1000), /invalid WeChat submission/);
    assert.throws(() => confirmRegisteredWechatQuery(db, masterKey, oldTradeNo, channel.id, 200, queryBody, queryHeaders, now + 1), /no registered submission/);
    registerWechatCredential(db, masterKey, { ...channel, id: "channel-duplicate" }, now);
    await assert.rejects(() => queryWechatSubmission(queryOptions), /ambiguous/);
    revokeWechatCredential(db, "channel-duplicate", "test-admin", "fixture", now + 1);
    assert.deepEqual(await queryWechatSubmission(queryOptions), { duplicate: true });
    await assert.rejects(() => queryWechatSubmission({ ...queryOptions, transport: async () => {
      revokeWechatSigningKey(db, "merchant-key", "test-admin", "fixture", now + 1);
      return new Response(queryBody, { status: 200, headers: { ...Object.fromEntries(queryHeaders), "content-type": "application/json" } });
    } }), /signing key unavailable/);
    await assert.rejects(() => queryWechatSubmission(queryOptions), /signing key unavailable/);
    registerWechatSigningKey(db, masterKey, { ...signingInput, id: "merchant-key-rotated", serial: "merchant-serial-rotated" }, now);
    await assert.rejects(() => queryWechatSubmission({ ...queryOptions, signingKeyId: "merchant-key-rotated", transport: async () => {
      revokeWechatCredential(db, channel.id, "test-admin", "fixture", now + 1);
      return new Response(queryBody, { status: 200, headers: { ...Object.fromEntries(queryHeaders), "content-type": "application/json" } });
    } }), /credential unavailable/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
