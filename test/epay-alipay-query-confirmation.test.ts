import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { it } from "node:test";
import { createV3ResponseSignature } from "../src/infrastructure/alipay/v3.ts";
import { alipaySigningFingerprint } from "../src/epay-compat/isolated-alipay-client.ts";
import { queryAndConfirmAlipaySubmission } from "../src/epay-compat/isolated-alipay-query.ts";
import { balanceFixture } from "./epay-live-balance-fixture.ts";
import { installBalanceOpenings, planBalanceOpenings } from "../src/epay-compat/balance-opening.ts";
import { readLiveBalance } from "../src/epay-compat/live-balance.ts";
import { verifyAlipayQueryAccount } from "../src/epay-compat/alipay-query-account.ts";
import { accountCertificate } from "./fixtures/alipay-account-certificate.ts";

const now = Date.now();
const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 });
const platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKey = platform.publicKey.export({ type: "spki", format: "pem" }).toString();

async function buildFixture(identity = { appId: "app", sellerId: "seller" }) {
  const fixture = await balanceFixture();
  fixture.db.write(sql => {
    installBalanceOpenings(sql, fixture.cipher, planBalanceOpenings(sql, fixture.cipher, "a".repeat(64)), now);
    for (const id of [1, 2]) {
      sql.prepare("INSERT INTO api_client_config VALUES(?,?,1,1,0,0)").run(`site-${id}`, "a".repeat(64));
      sql.prepare("INSERT INTO sites(client_id,revision,configuration,created_at,updated_at) VALUES(?,0,'{}',0,0)").run(`site-${id}`);
      sql.prepare("INSERT INTO epay_alipay_bindings VALUES(?,?,?,?,?)").run(`site-${id}`, identity.appId, identity.sellerId, publicKey, alipaySigningFingerprint(merchant.privateKey));
      sql.prepare(`INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,type_code,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at)
        VALUES(?,?,?,'alipay','fixture',100,'https://example.test/callback','PENDING','PENDING',0,?,?)`).run(`order_${id}`, `external_${id}`, id, now, now);
      sql.prepare("INSERT INTO epay_alipay_intents VALUES(?,?,?,?,?,100,5,?)").run(`order_${id}`, id, identity.appId, identity.sellerId, publicKey, now);
      sql.prepare("INSERT INTO epay_alipay_orders VALUES(?,?)").run(`order_${id}`, `site-${id}`);
      sql.prepare("INSERT INTO epay_alipay_submissions VALUES(?,?,'UNCERTAIN',NULL,NULL,?,?)").run(`order_${id}`, randomUUID(), now, now);
    }
  });
  return fixture;
}

function response(fields: Record<string, unknown> = {}, timestamp = String(now)) {
  const body = JSON.stringify({ out_trade_no: "order_1", trade_no: "provider_1", trade_status: "TRADE_SUCCESS", total_amount: "1.00", seller_id: "seller", ...fields });
  return { status: 200, body: Buffer.from(body), headers: { "alipay-timestamp": timestamp, "alipay-nonce": "fixture", "alipay-signature": createV3ResponseSignature(body, timestamp, "fixture", platform.privateKey) } };
}

it("confirms authenticated queries atomically and never assigns equal amounts to another merchant", async () => {
  const fixture = await buildFixture();
  const run = (fields: Record<string, unknown> = {}) => queryAndConfirmAlipaySubmission({ database: fixture.db, tradeNo: "order_1", privateKey: merchant.privateKey, clock: () => now, transport: { request: async () => response(fields) } });
  try {
    for (const fields of [{ seller_id: "other" }, { total_amount: "1.01" }, { out_trade_no: "order_2" }, { app_id: "other" }]) await assert.rejects(run(fields));
    assert.equal(fixture.db.read(sql => readLiveBalance(sql, 1)).availableCents, 950);
    assert.deepEqual(await run({ trade_status: "WAIT_BUYER_PAY" }), { paymentConfirmed: false, tradeStatus: "WAIT_BUYER_PAY" });
    const first = await run();
    assert.deepEqual(first, { paymentConfirmed: true, duplicate: false, tradeStatus: "TRADE_SUCCESS" });
    assert.deepEqual(await run(), { paymentConfirmed: true, duplicate: true, tradeStatus: "TRADE_SUCCESS" });
    fixture.db.read(sql => {
      assert.equal(readLiveBalance(sql, 1).availableCents, 1045);
      assert.equal(readLiveBalance(sql, 2).availableCents, 1900);
      assert.equal(sql.prepare("SELECT state FROM epay_alipay_submissions WHERE trade_no='order_1'").get()?.state, "SETTLED");
      assert.equal(sql.prepare("SELECT status FROM epay_orders WHERE trade_no='order_2'").get()?.status, "PENDING");
      assert.equal(Number(sql.prepare("SELECT count(*) n FROM epay_balance_ledger WHERE source='perpay_epay'").get()?.n), 1);
      assert.equal(Number(sql.prepare("SELECT count(*) n FROM epay_callback_jobs").get()?.n), 1);
    });
  } finally { fixture.close(); }
});

it("rejects incomplete, stale, tampered queries and rolls back settlement when outbox insertion fails", async () => {
  const fixture = await buildFixture();
  const run = (reply: ReturnType<typeof response>) => queryAndConfirmAlipaySubmission({ database: fixture.db, tradeNo: "order_1", privateKey: merchant.privateKey, clock: () => now, transport: { request: async () => reply } });
  try {
    for (const reply of [response({ seller_id: undefined }), response({ total_amount: undefined }), response({ trade_no: undefined }), response({}, String(now - 301_000)), { ...response(), body: Buffer.from("{}") }]) await assert.rejects(run(reply));
    fixture.db.write(sql => sql.exec("CREATE TRIGGER reject_query_outbox BEFORE INSERT ON epay_callback_jobs BEGIN SELECT RAISE(ABORT,'outbox unavailable'); END"));
    await assert.rejects(run(response()), /outbox unavailable/);
    fixture.db.read(sql => {
      assert.equal(sql.prepare("SELECT status FROM epay_orders WHERE trade_no='order_1'").get()?.status, "PENDING");
      assert.equal(sql.prepare("SELECT state FROM epay_alipay_submissions WHERE trade_no='order_1'").get()?.state, "UNCERTAIN");
      assert.equal(readLiveBalance(sql, 1).availableCents, 950);
      assert.equal(Number(sql.prepare("SELECT count(*) n FROM epay_alipay_confirmations").get()?.n), 0);
      assert.equal(Number(sql.prepare("SELECT count(*) n FROM epay_balance_ledger WHERE source='perpay_epay'").get()?.n), 0);
    });
  } finally { fixture.close(); }
});

it("settles a certificate-bound query without seller_id once and fences identity changes across the network wait", async () => {
  const identity = { appId: "2026000000000000", sellerId: "2088000000000000", platformPublicKey: publicKey };
  const fixture = await buildFixture(identity);
  try {
    const certificate = accountCertificate(fixture.directory, merchant.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const account = verifyAlipayQueryAccount({ ...identity, ...certificate, privateKey: merchant.privateKey }, Date.now());
    const unchanged = () => fixture.db.read(sql => {
      assert.equal(readLiveBalance(sql, 1).availableCents, 950);
      assert.equal(Number(sql.prepare("SELECT count(*) n FROM epay_callback_jobs").get()?.n), 0);
      assert.equal(sql.prepare("SELECT status FROM epay_orders WHERE trade_no='order_1'").get()?.status, "PENDING");
    });
    const reply = () => response({ seller_id: undefined }, String(Date.now()));
    const run = (duringRequest: () => void = () => {}) => queryAndConfirmAlipaySubmission({ database: fixture.db, tradeNo: "order_1", privateKey: merchant.privateKey, account, transport: { request: async () => { duringRequest(); return reply(); } } });
    await assert.rejects(run(() => fixture.db.write(sql => sql.prepare("UPDATE epay_alipay_bindings SET signing_key_fingerprint=? WHERE client_id='site-1'").run("0".repeat(64)))), /binding is immutable/);
    unchanged();
    await assert.rejects(run(() => fixture.db.write(sql => sql.exec("UPDATE epay_alipay_intents SET seller_id='different' WHERE trade_no='order_1'"))), /immutable/);
    unchanged();
    assert.equal((await run()).paymentConfirmed, true);
    const repeated = await run();
    assert.equal(repeated.paymentConfirmed, true);
    assert.equal(repeated.duplicate, true);
    fixture.db.read(sql => {
      assert.equal(readLiveBalance(sql, 1).availableCents, 1045);
      assert.equal(readLiveBalance(sql, 2).availableCents, 1900);
      assert.equal(Number(sql.prepare("SELECT count(*) n FROM epay_callback_jobs").get()?.n), 1);
    });
  } finally { fixture.close(); }
});

it("retires only an expired missing Alipay trade with verified account evidence and no issued payment details", async () => {
  const identity = { appId: "2026000000000000", sellerId: "2088000000000000", platformPublicKey: publicKey };
  const fixture = await buildFixture(identity);
  try {
    const certificate = accountCertificate(fixture.directory, merchant.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const account = verifyAlipayQueryAccount({ ...identity, ...certificate, privateKey: merchant.privateKey }, Date.now());
    let time = Date.now();
    const missing = (trade = "order_1") => {
      const body = JSON.stringify({ out_trade_no: trade, code: "ACQ.TRADE_NOT_EXIST" }), timestamp = String(time);
      return { status: 400, body: Buffer.from(body), headers: { "alipay-timestamp": timestamp, "alipay-nonce": "fixture", "alipay-signature": createV3ResponseSignature(body, timestamp, "fixture", platform.privateKey) } };
    };
    const options = { database: fixture.db, tradeNo: "order_1", privateKey: merchant.privateKey, account, clock: () => time, absentOrderExpiry: { masterKey: fixture.key, instanceId: fixture.db.instanceId() } };
    assert.equal((await queryAndConfirmAlipaySubmission({ ...options, transport: { request: async () => missing() } })).tradeStatus, "TRADE_NOT_EXIST");
    assert.equal(fixture.db.read(sql => sql.prepare("SELECT status FROM epay_orders WHERE trade_no='order_1'").get()?.status), "PENDING");
    time += 16 * 60000;
    await assert.rejects(queryAndConfirmAlipaySubmission({ ...options, transport: { request: async () => missing("order_2") } }));
    await assert.rejects(queryAndConfirmAlipaySubmission({ ...options, transport: { request: async () => ({ ...missing(), body: Buffer.from("{}") }) } }));
    await queryAndConfirmAlipaySubmission({ ...options, transport: { request: async () => missing() } });
    fixture.db.read(sql => {
      assert.equal(sql.prepare("SELECT status FROM epay_orders WHERE trade_no='order_1'").get()?.status, "CLOSED");
      assert.equal(sql.prepare("SELECT status FROM epay_orders WHERE trade_no='order_2'").get()?.status, "PENDING");
      assert.equal(Number(sql.prepare("SELECT count(*) n FROM epay_callback_jobs").get()?.n), 0);
      assert.equal(Number(sql.prepare("SELECT count(*) n FROM epay_balance_ledger WHERE source='perpay_epay'").get()?.n), 0);
      assert.equal(Number(sql.prepare("SELECT count(*) n FROM audit_events WHERE action='epay.order.closed'").get()?.n), 1);
    });
    fixture.db.write(sql => {
      const sealed = fixture.cipher.encrypt("epay:config:alipay-web:order_2", 1, "https://openapi.alipay.com/gateway.do");
      const attempt = sql.prepare("SELECT attempt_id FROM epay_alipay_submissions WHERE trade_no='order_2'").get()!.attempt_id!;
      sql.prepare("INSERT INTO epay_alipay_web_orders VALUES('order_2','pc',?)").run(now);
      sql.prepare("INSERT INTO epay_alipay_web_links VALUES('order_2',?,?,?,?,?)").run(attempt, sealed.nonce, sealed.ciphertext, sealed.authenticationTag, now);
    });
    await queryAndConfirmAlipaySubmission({ ...options, tradeNo: "order_2", transport: { request: async () => missing("order_2") } });
    assert.equal(fixture.db.read(sql => sql.prepare("SELECT status FROM epay_orders WHERE trade_no='order_2'").get()?.status), "PENDING");
  } finally { fixture.close(); }
});
