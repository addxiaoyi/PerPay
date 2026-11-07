import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { EPayCallbackOutbox } from "../src/epay-compat/outbox.ts";
import { EPayCallbackProcessor } from "../src/epay-compat/callback-processor.ts";
import { verifyEPaySign } from "../src/epay-compat/sign.ts";
import { recordSyntheticAlipayConfirmation } from "./epay-payment-fixture.ts";

it("retries an order read failure without sending a callback before evidence is checked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-callback-order-read-"));
  const db = await AppDatabase.open(join(dir, "db.sqlite"), { masterKey: randomBytes(32) });
  try {
    db.write((sql) => {
      sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'m',0,1,0,0);
        INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES ('trade','outside',1,'item',100,100,'https://example.test/callback','PAID','PENDING',0,0,0)`);
      recordSyntheticAlipayConfirmation(sql, "trade", 1);
    });
    new EPayCallbackOutbox(db).enqueue("trade", 1, 100);
    let now = 100;
    let failRead = true;
    let sends = 0;
    const database = new Proxy(db, { get(target, property) {
      if (property === "read") return (...args: Parameters<typeof db.read>) => {
        if (failRead) { failRead = false; throw new Error("database temporarily unavailable"); }
        return target.read(...args);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const processor = new EPayCallbackProcessor({ database, clock: () => now, secret: () => "test-key", transport: () => ({ async post(request) {
      sends++;
      assert.equal(verifyEPaySign(Object.fromEntries(new URLSearchParams(request.body.toString())), "test-key"), true);
      return { status: 200, body: Buffer.from("success"), contentType: null, contentEncoding: null, responseFingerprint: "", resolvedAddressesFingerprint: "", connectedAddress: "" };
    } }) });
    const policy = { timeoutMilliseconds: 1000, leaseMilliseconds: 2000, maximumAttempts: 2, retryDelayMilliseconds: 50 };
    assert.equal(await processor.processOne(policy), true);
    assert.equal(sends, 0);
    assert.equal(db.read((sql) => sql.prepare("SELECT status FROM epay_callback_jobs WHERE trade_no='trade'").get())?.status, "PENDING");
    assert.equal(db.read((sql) => sql.prepare("SELECT error_code FROM epay_callback_attempts WHERE trade_no='trade'").get())?.error_code, "callback_order_read_failed");
    now = 150;
    assert.equal(await processor.processOne(policy), true);
    assert.equal(sends, 1);
    assert.deepEqual(db.read((sql) => sql.prepare("SELECT outcome FROM epay_callback_attempts ORDER BY attempt_number").all()).map((row) => row.outcome), ["RETRY", "SUCCESS"]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("stops retrying persistent order read failures at the configured limit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-callback-order-limit-"));
  const db = await AppDatabase.open(join(dir, "db.sqlite"), { masterKey: randomBytes(32) });
  try {
    db.write((sql) => {
      sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'m',0,1,0,0);
        INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES ('trade','outside',1,'item',100,100,'https://example.test/callback','PAID','PENDING',0,0,0)`);
      recordSyntheticAlipayConfirmation(sql, "trade", 1);
    });
    new EPayCallbackOutbox(db).enqueue("trade", 1, 100);
    const database = new Proxy(db, { get(target, property) {
      if (property === "read") return () => { throw new Error("database unavailable"); };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const processor = new EPayCallbackProcessor({ database, clock: () => 100, secret: () => { throw new Error("must not read secret"); } });
    const policy = { timeoutMilliseconds: 1000, leaseMilliseconds: 2000, maximumAttempts: 1, retryDelayMilliseconds: 50 };
    assert.equal(await processor.processOne(policy), true);
    assert.equal(await processor.processOne(policy), false);
    assert.equal(db.read((sql) => sql.prepare("SELECT status FROM epay_callback_jobs WHERE trade_no='trade'").get())?.status, "FAILED");
    const attempt = db.read((sql) => sql.prepare("SELECT outcome,error_code FROM epay_callback_attempts WHERE trade_no='trade'").get());
    assert.equal(attempt?.outcome, "FAILED");
    assert.equal(attempt?.error_code, "callback_order_read_failed");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("does not claim or consume a callback attempt when already cancelled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-callback-cancel-"));
  const db = await AppDatabase.open(join(dir, "db.sqlite"), { masterKey: randomBytes(32) });
  try {
    db.write(sql => {
      sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'m',0,1,0,0);
        INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES ('trade','outside',1,'item',100,100,'https://example.test/callback','PAID','PENDING',0,0,0)`);
      recordSyntheticAlipayConfirmation(sql, "trade", 1);
    });
    new EPayCallbackOutbox(db).enqueue("trade", 1, 100);
    const signal = AbortSignal.abort();
    const processor = new EPayCallbackProcessor({ database: db, clock: () => 100, secret: () => { throw new Error("must not read secret"); } });
    assert.equal(await processor.processOne({ timeoutMilliseconds: 1000, leaseMilliseconds: 2000, maximumAttempts: 1, retryDelayMilliseconds: 50, signal }), false);
    const state = db.read(sql => ({ job: sql.prepare("SELECT status,attempts FROM epay_callback_jobs WHERE trade_no='trade'").get(), attempts: sql.prepare("SELECT count(*) AS n FROM epay_callback_attempts").get(), order: sql.prepare("SELECT notify_count FROM epay_orders WHERE trade_no='trade'").get() }));
    assert.equal(state.job?.status, "PENDING");
    assert.equal(Number(state.job?.attempts), 0);
    assert.equal(Number(state.attempts?.n), 0);
    assert.equal(Number(state.order?.notify_count), 0);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const failure of ["exception", "empty"] as const) it(`retries a temporary ${failure} signing key read failure without sending an unsigned callback`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-callback-secret-"));
  const db = await AppDatabase.open(join(dir, "db.sqlite"), { masterKey: randomBytes(32) });
  try {
    db.write((sql) => {
      sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'m',0,1,0,0);
        INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES ('trade','outside',1,'item',100,100,'https://example.test/callback','PAID','PENDING',0,0,0)`);
      recordSyntheticAlipayConfirmation(sql, "trade", 1);
    });
    new EPayCallbackOutbox(db).enqueue("trade", 1, 100);
    let now = 100;
    let reads = 0;
    let sends = 0;
    const processor = new EPayCallbackProcessor({ database: db, clock: () => now, secret: () => {
      if (++reads === 1) {
        if (failure === "empty") return "";
        throw new Error("temporary secret store failure");
      }
      return "test-key";
    }, transport: () => ({ async post(request) {
      sends++;
      assert.equal(verifyEPaySign(Object.fromEntries(new URLSearchParams(request.body.toString())), "test-key"), true);
      return { status: 200, body: Buffer.from("success"), contentType: null, contentEncoding: null, responseFingerprint: "", resolvedAddressesFingerprint: "", connectedAddress: "" };
    } }) });
    const policy = { timeoutMilliseconds: 1000, leaseMilliseconds: 2000, maximumAttempts: 2, retryDelayMilliseconds: 50 };
    assert.equal(await processor.processOne(policy), true);
    assert.equal(sends, 0);
    assert.equal(db.read((sql) => sql.prepare("SELECT status FROM epay_callback_jobs WHERE trade_no='trade'").get())?.status, "PENDING");
    assert.equal(db.read((sql) => sql.prepare("SELECT error_code FROM epay_callback_attempts WHERE trade_no='trade'").get())?.error_code, "callback_secret_read_failed");
    now = 150;
    assert.equal(await processor.processOne(policy), true);
    assert.equal(sends, 1);
    assert.deepEqual(db.read((sql) => sql.prepare("SELECT outcome FROM epay_callback_attempts ORDER BY attempt_number").all()).map((row) => row.outcome), ["RETRY", "SUCCESS"]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("stops retrying a persistent signing key read failure at the configured limit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-callback-secret-limit-"));
  const db = await AppDatabase.open(join(dir, "db.sqlite"), { masterKey: randomBytes(32) });
  try {
    db.write((sql) => {
      sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'m',0,1,0,0);
        INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES ('trade','outside',1,'item',100,100,'https://example.test/callback','PAID','PENDING',0,0,0)`);
      recordSyntheticAlipayConfirmation(sql, "trade", 1);
    });
    new EPayCallbackOutbox(db).enqueue("trade", 1, 100);
    const processor = new EPayCallbackProcessor({ database: db, clock: () => 100, secret: () => { throw new Error("secret store unavailable"); } });
    const policy = { timeoutMilliseconds: 1000, leaseMilliseconds: 2000, maximumAttempts: 1, retryDelayMilliseconds: 50 };
    assert.equal(await processor.processOne(policy), true);
    assert.equal(await processor.processOne(policy), false);
    assert.equal(db.read((sql) => sql.prepare("SELECT status FROM epay_callback_jobs WHERE trade_no='trade'").get())?.status, "FAILED");
    const attempt = db.read((sql) => sql.prepare("SELECT outcome,error_code FROM epay_callback_attempts WHERE trade_no='trade'").get());
    assert.equal(attempt?.outcome, "FAILED");
    assert.equal(attempt?.error_code, "callback_secret_read_failed");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("delivers only the claimed merchant's paid order and retries an unacknowledged callback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perpay-epay-processor-"));
  const db = await AppDatabase.open(join(dir, "db.sqlite"), { masterKey: randomBytes(32) });
  try {
    db.write((connection) => {
      connection.prepare("INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'merchant',0,1,0,0)").run();
      connection.prepare(`INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,type_code,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at)
        VALUES ('trade','external',1,'alipay','item',100,100,'https://example.test/notify','PAID','PENDING',0,0,0)`).run();
      recordSyntheticAlipayConfirmation(connection, "trade", 1);
    });
    const queue = new EPayCallbackOutbox(db);
    queue.enqueue("trade", 1, 100);
    let now = 100;
    let calls = 0;
    const processor = new EPayCallbackProcessor({ database: db, clock: () => now, secret: (id) => { assert.equal(id, 1); return "test-key"; }, transport: (origin) => {
      assert.equal(origin, "https://example.test");
      return { async post(request) {
        calls++;
        const params = Object.fromEntries(new URLSearchParams(request.body.toString()));
        assert.equal(verifyEPaySign(params, "test-key"), true);
        assert.equal(params.trade_no, "trade");
        return { status: 200, contentType: "text/plain", contentEncoding: null, body: Buffer.from(calls === 1 ? "not yet" : "success"), responseFingerprint: "", resolvedAddressesFingerprint: "", connectedAddress: "" };
      } };
    } });
    const policy = { timeoutMilliseconds: 1000, leaseMilliseconds: 2000, maximumAttempts: 2, retryDelayMilliseconds: 50 };
    assert.equal(await processor.processOne(policy), true);
    assert.equal(await processor.processOne(policy), false);
    now = 150;
    assert.equal(await processor.processOne(policy), true);
    assert.equal(calls, 2);
    const outcomes = db.read((connection) => connection.prepare("SELECT outcome FROM epay_callback_attempts ORDER BY attempt_number").all());
    assert.deepEqual(outcomes.map((row) => row.outcome), ["RETRY", "SUCCESS"]);
    db.write((connection) => {
      connection.prepare(`INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,type_code,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at)
        VALUES ('refunded','other',1,'alipay','item',100,100,'https://example.test/notify','PAID','PENDING',0,0,0)`).run();
    });
    queue.enqueue("refunded", 1, now);
    db.write((connection) => connection.prepare("UPDATE epay_orders SET status = 'REFUNDED' WHERE trade_no = 'refunded'").run());
    assert.equal(await processor.processOne(policy), true);
    assert.equal(calls, 2);
    const job = db.read((connection) => connection.prepare("SELECT status FROM epay_callback_jobs WHERE trade_no = 'refunded'").get());
    assert.equal(job?.status, "FAILED");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("records a signed GET fallback separately after final 405 and survives a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-get-fallback-"));
  const path = join(dir, "db.sqlite");
  const key = randomBytes(32);
  let db = await AppDatabase.open(path, { masterKey: key });
  let now = 100;
  let posts = 0;
  let gets = 0;
  const transport = () => ({
    async post() { posts++; return { status: 405, body: Buffer.alloc(0), contentType: null, contentEncoding: null, responseFingerprint: "", resolvedAddressesFingerprint: "", connectedAddress: "" }; },
    async get(input: { targetUrl: string }) {
      gets++;
      const url = new URL(input.targetUrl);
      assert.equal(url.searchParams.get("existing"), "yes");
      assert.equal(verifyEPaySign(Object.fromEntries([...url.searchParams].filter(([name]) => name !== "existing")), "test-key"), true);
      return { status: 200, body: Buffer.from("success"), contentType: null, contentEncoding: null, responseFingerprint: "", resolvedAddressesFingerprint: "", connectedAddress: "" };
    },
  });
  try {
    db.write((sql) => sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'m',0,1,0,0);
      INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES ('trade','outside',1,'item',100,100,'https://example.test/callback?existing=yes','PAID','PENDING',0,0,0)`));
    db.write((sql) => recordSyntheticAlipayConfirmation(sql, "trade", 1));
    new EPayCallbackOutbox(db).enqueue("trade", 1, now);
    const policy = { timeoutMilliseconds: 1000, leaseMilliseconds: 2000, maximumAttempts: 2, retryDelayMilliseconds: 50 };
    let processor = new EPayCallbackProcessor({ database: db, clock: () => now, secret: () => "test-key", transport });
    await processor.processOne(policy);
    now = 150;
    await processor.processOne(policy);
    db.close();
    db = await AppDatabase.open(path, { masterKey: key });
    processor = new EPayCallbackProcessor({ database: db, clock: () => now, secret: () => "test-key", transport });
    now = 200;
    assert.equal(await processor.processOne(policy), true);
    assert.equal(await processor.processOne(policy), false);
    assert.equal(posts, 2);
    assert.equal(gets, 1);
    const rows = db.read((sql) => sql.prepare("SELECT method, outcome, http_status FROM epay_callback_attempts ORDER BY attempt_number").all());
    assert.deepEqual(rows.map((row) => [row.method, row.outcome, Number(row.http_status)]), [["POST", "RETRY", 405], ["POST", "RETRY", 405], ["GET", "SUCCESS", 200]]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("retries an unacknowledged GET fallback without exceeding its attempt budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-get-retry-limit-"));
  const db = await AppDatabase.open(join(dir, "db.sqlite"), { masterKey: randomBytes(32) });
  try {
    db.write((sql) => {
      sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'m',0,1,0,0);
        INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES ('trade','outside',1,'item',100,100,'https://example.test/callback','PAID','PENDING',0,0,0)`);
      recordSyntheticAlipayConfirmation(sql, "trade", 1);
    });
    new EPayCallbackOutbox(db).enqueue("trade", 1, 100);
    let now = 100;
    let gets = 0;
    const processor = new EPayCallbackProcessor({ database: db, clock: () => now, secret: () => "test-key", transport: () => ({
      async post() { return { status: 405, body: Buffer.alloc(0), contentType: null, contentEncoding: null, responseFingerprint: "", resolvedAddressesFingerprint: "", connectedAddress: "" }; },
      async get() { gets++; return { status: 503, body: Buffer.alloc(0), contentType: null, contentEncoding: null, responseFingerprint: "", resolvedAddressesFingerprint: "", connectedAddress: "" }; },
    }) });
    const policy = { timeoutMilliseconds: 1000, leaseMilliseconds: 2000, maximumAttempts: 2, retryDelayMilliseconds: 1 };
    for (now = 100; now < 104; now++) assert.equal(await processor.processOne(policy), true);
    assert.equal(await processor.processOne(policy), false);
    assert.equal(gets, 2);
    assert.equal(db.read((sql) => sql.prepare("SELECT status FROM epay_callback_jobs WHERE trade_no='trade'").get())?.status, "FAILED");
    const attempts = db.read((sql) => sql.prepare("SELECT method, outcome FROM epay_callback_attempts ORDER BY attempt_number").all());
    assert.deepEqual(attempts.map((row) => [row.method, row.outcome]), [["POST", "RETRY"], ["POST", "RETRY"], ["GET", "RETRY"], ["GET", "FAILED"]]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("never sends callbacks for unconfirmed payments or inconsistent ledger entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-callback-evidence-"));
  const db = await AppDatabase.open(join(dir, "db.sqlite"), { masterKey: randomBytes(32) });
  try {
    db.write((sql) => {
      sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'m',0,1,0,0);
        INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES
        ('unverified','unverified',1,'item',100,100,'https://example.test','PAID','PENDING',0,0,0),
        ('bad-ledger','bad-ledger',1,'item',100,100,'https://example.test','PAID','PENDING',0,0,0),
        ('bad-channel','bad-channel',1,'item',100,100,'https://example.test','PAID','PENDING',0,0,0),
        ('double-confirmed','double-confirmed',1,'item',100,100,'https://example.test','PAID','PENDING',0,0,0)`);
      recordSyntheticAlipayConfirmation(sql, "bad-ledger", 1);
      recordSyntheticAlipayConfirmation(sql, "bad-channel", 1);
      recordSyntheticAlipayConfirmation(sql, "double-confirmed", 1);
      sql.prepare("INSERT INTO epay_wechat_intents VALUES ('double-confirmed',1,'app','provider','key','serial',?,?,?,100,5,0)").run(Buffer.alloc(12), Buffer.alloc(1), Buffer.alloc(16));
      sql.prepare("INSERT INTO epay_wechat_confirmations VALUES ('double-confirmed','different-provider-id',1,100,5,0)").run();
      sql.prepare("UPDATE epay_balance_ledger SET available_delta_cents=100 WHERE entry_id='epay_payment:bad-ledger'").run();
      sql.prepare("UPDATE epay_orders SET type_code='wxpay' WHERE trade_no='bad-channel'").run();
    });
    const queue = new EPayCallbackOutbox(db);
    queue.enqueue("unverified", 1, 100);
    queue.enqueue("bad-ledger", 1, 100);
    queue.enqueue("bad-channel", 1, 100);
    queue.enqueue("double-confirmed", 1, 100);
    let deliveries = 0;
    const processor = new EPayCallbackProcessor({ database: db, clock: () => 100, secret: () => { deliveries++; return "key"; } });
    const policy = { timeoutMilliseconds: 1000, leaseMilliseconds: 2000, maximumAttempts: 1, retryDelayMilliseconds: 50 };
    assert.equal(await processor.processOne(policy), true);
    assert.equal(await processor.processOne(policy), true);
    assert.equal(await processor.processOne(policy), true);
    assert.equal(await processor.processOne(policy), true);
    assert.equal(deliveries, 0);
    const jobs = db.read((sql) => sql.prepare("SELECT status FROM epay_callback_jobs ORDER BY trade_no").all());
    assert.deepEqual(jobs.map((job) => job.status), ["FAILED", "FAILED", "FAILED", "FAILED"]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
