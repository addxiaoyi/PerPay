import assert from "node:assert/strict";
import { createCipheriv, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { confirmAlipayPayment } from "../src/epay-compat/confirm-alipay.ts";
import { EPayCallbackProcessor } from "../src/epay-compat/callback-processor.ts";
import { EPayCallbackScheduler } from "../src/epay-compat/callback-scheduler.ts";
import { verifyEPaySign } from "../src/epay-compat/sign.ts";
import { confirmWechatPayment } from "../src/epay-compat/confirm-wechat.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { auditConfirmedPayments } from "../src/epay-compat/confirmation-audit.ts";

it("recovers an authenticated payment and retries its signed merchant callback after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "epay-confirm-delivery-"));
  const path = join(directory, "db.sqlite"), masterKey = randomBytes(32);
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const fields = { app_id: "app", seller_id: "seller", out_trade_no: "trade", trade_no: "provider", trade_status: "TRADE_SUCCESS", total_amount: "1.00" };
  const canonical = Object.keys(fields).sort().map((key) => `${key}=${fields[key as keyof typeof fields]}`).join("&");
  const notification = { ...fields, sign_type: "RSA2", sign: sign("RSA-SHA256", Buffer.from(canonical), keys.privateKey).toString("base64") };
  let db = await AppDatabase.open(path, { masterKey });
  let now = 100, sends = 0;
  try {
    db.write((sql) => {
      sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'merchant',0,1,0,0);
        INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,type_code,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at)
        VALUES ('trade','external',1,'alipay','item',100,'https://example.test/notify','PENDING','PENDING',0,1,1)`);
      sql.prepare("INSERT INTO epay_alipay_intents VALUES (?, ?, 'app', 'seller', ?, 100, 5, 1)").run("trade", 1, publicKey);
    });
    assert.deepEqual(confirmAlipayPayment(db, notification, now), { duplicate: false });
    db.close();
    db = await AppDatabase.open(path, { masterKey });
    assert.deepEqual(confirmAlipayPayment(db, notification, now + 1), { duplicate: true });
    const processor = new EPayCallbackProcessor({ database: db, clock: () => now, secret: () => "fixture-key", transport: () => ({
      async post(request) {
        sends++;
        const params = Object.fromEntries(new URLSearchParams(request.body.toString()));
        assert.equal(verifyEPaySign(params, "fixture-key"), true);
        assert.equal(params.trade_no, "trade");
        return { status: 200, body: Buffer.from(sends === 1 ? "retry" : "success"), contentType: null, contentEncoding: null, responseFingerprint: "", resolvedAddressesFingerprint: "", connectedAddress: "" };
      },
    }) });
    const scheduler = new EPayCallbackScheduler({ processor, policy: { timeoutMilliseconds: 1000, leaseMilliseconds: 2000, maximumAttempts: 2, retryDelayMilliseconds: 10 }, intervalMilliseconds: 1000, maximumPerRun: 5, onError: () => assert.fail("unexpected scheduler error") });
    try {
      assert.equal(await scheduler.trigger(), 1);
      now = 110;
      assert.equal(await scheduler.trigger(), 1);
      assert.equal(await scheduler.trigger(), 0);
    } finally { await scheduler.stop(); }
    const state = db.read((sql) => ({
      order: sql.prepare("SELECT status, notify_status FROM epay_orders WHERE trade_no='trade'").get(),
      ledger: sql.prepare("SELECT count(*) AS n, sum(available_delta_cents) AS amount FROM epay_balance_ledger WHERE entry_id='epay_payment:trade'").get(),
      attempts: sql.prepare("SELECT outcome FROM epay_callback_attempts ORDER BY attempt_number").all(),
    }));
    assert.equal(state.order?.status, "PAID");
    assert.equal(state.order?.notify_status, "SUCCESS");
    assert.equal(Number(state.ledger?.n), 1);
    assert.equal(Number(state.ledger?.amount), 95);
    assert.deepEqual(state.attempts.map((row) => row.outcome), ["RETRY", "SUCCESS"]);
    assert.equal(sends, 2);
    assert.deepEqual(db.read(auditConfirmedPayments), { confirmed: 1, inconsistent: 0, unconfirmedLedger: 0, unconfirmedCallbacks: 0, paidWithoutConfirmation: 0, intentPaidWithoutConfirmation: 0, paidWithoutIntent: 0 });
  } finally { db.close(); masterKey.fill(0); rmSync(directory, { recursive: true, force: true }); }
});

it("recovers a verified WeChat payment and delivers its signed callback after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "epay-wechat-delivery-"));
  const path = join(directory, "db.sqlite"), masterKey = randomBytes(32);
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const apiKey = "x".repeat(32), now = 1_800_000_000_000;
  const transaction = { appid: "app", mchid: "provider-merchant", out_trade_no: "trade", transaction_id: "provider", trade_state: "SUCCESS", amount: { total: 100, currency: "CNY" } };
  const encryption = createCipheriv("aes-256-gcm", Buffer.from(apiKey), Buffer.from("123456789012"));
  encryption.setAAD(Buffer.from("transaction"));
  const ciphertext = Buffer.concat([encryption.update(JSON.stringify(transaction)), encryption.final(), encryption.getAuthTag()]).toString("base64");
  const body = Buffer.from(JSON.stringify({ event_type: "TRANSACTION.SUCCESS", resource: { algorithm: "AEAD_AES_256_GCM", nonce: "123456789012", associated_data: "transaction", ciphertext } }));
  const timestamp = String(now / 1000);
  const signature = sign("RSA-SHA256", Buffer.concat([Buffer.from(`${timestamp}\nnonce\n`), body, Buffer.from("\n")]), keys.privateKey).toString("base64");
  const headers = new Headers({ "wechatpay-timestamp": timestamp, "wechatpay-nonce": "nonce", "wechatpay-serial": "serial", "wechatpay-signature": signature });
  let db = await AppDatabase.open(path, { masterKey });
  let sends = 0;
  try {
    const cipher = new RuntimeSecretCipher(masterKey, db.instanceId());
    const sealed = cipher.encrypt("epay:config:wechat-intent:trade", 1, apiKey);
    db.write((sql) => {
      sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'merchant',0,1,0,0);
        INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,type_code,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at)
        VALUES ('trade','external',1,'wxpay','item',100,'https://example.test/notify','PENDING','PENDING',0,1,1)`);
      sql.prepare("INSERT INTO epay_wechat_intents VALUES (?,?,'app','provider-merchant',?,'serial',?,?,?,100,5,1)").run("trade", 1, publicKey, sealed.nonce, sealed.ciphertext, sealed.authenticationTag);
    });
    assert.deepEqual(confirmWechatPayment(db, masterKey, "trade", body, headers, now), { duplicate: false });
    db.close();
    db = await AppDatabase.open(path, { masterKey });
    assert.deepEqual(confirmWechatPayment(db, masterKey, "trade", body, headers, now), { duplicate: true });
    const processor = new EPayCallbackProcessor({ database: db, clock: () => now, secret: () => "fixture-key", transport: () => ({
      async post(request) {
        sends++;
        const params = Object.fromEntries(new URLSearchParams(request.body.toString()));
        assert.equal(verifyEPaySign(params, "fixture-key"), true);
        assert.equal(params.trade_no, "trade");
        return { status: 200, body: Buffer.from("success"), contentType: null, contentEncoding: null, responseFingerprint: "", resolvedAddressesFingerprint: "", connectedAddress: "" };
      },
    }) });
    const scheduler = new EPayCallbackScheduler({ processor, policy: { timeoutMilliseconds: 1000, leaseMilliseconds: 2000, maximumAttempts: 2, retryDelayMilliseconds: 10 }, intervalMilliseconds: 1000, maximumPerRun: 5, onError: () => assert.fail("unexpected scheduler error") });
    try { assert.equal(await scheduler.trigger(), 1); assert.equal(await scheduler.trigger(), 0); } finally { await scheduler.stop(); }
    const state = db.read((sql) => ({ order: sql.prepare("SELECT status, notify_status FROM epay_orders WHERE trade_no='trade'").get(), ledger: sql.prepare("SELECT count(*) AS n, sum(available_delta_cents) AS amount FROM epay_balance_ledger WHERE entry_id='epay_payment:trade'").get() }));
    assert.equal(state.order?.status, "PAID");
    assert.equal(state.order?.notify_status, "SUCCESS");
    assert.equal(Number(state.ledger?.n), 1);
    assert.equal(Number(state.ledger?.amount), 95);
    assert.equal(sends, 1);
    assert.deepEqual(db.read(auditConfirmedPayments), { confirmed: 1, inconsistent: 0, unconfirmedLedger: 0, unconfirmedCallbacks: 0, paidWithoutConfirmation: 0, intentPaidWithoutConfirmation: 0, paidWithoutIntent: 0 });
  } finally { db.close(); masterKey.fill(0); rmSync(directory, { recursive: true, force: true }); }
});
