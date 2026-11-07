import assert from "node:assert/strict";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { mainOrderFixture, mainIdentity, mainInput } from "./epay-main-native-fixture.ts";
import { createMainNativeOrder } from "../src/epay-compat/main-native-order.ts";
import { EPayPaymentQueryScheduler } from "../src/epay-compat/payment-query-scheduler.ts";
import { completePaymentQuery, reservePaymentQuery } from "../src/epay-compat/payment-query-jobs.ts";
import { balanceFixture } from "./epay-live-balance-fixture.ts";
import { installBalanceOpenings, planBalanceOpenings } from "../src/epay-compat/balance-opening.ts";

async function buildFixture() {
  const fixture = await balanceFixture();
  fixture.db.write(sql => {
    installBalanceOpenings(sql, fixture.cipher, planBalanceOpenings(sql, fixture.cipher, "a".repeat(64)), 100);
    sql.exec(`INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,type_code,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at)
      VALUES('query-a','external-a',1,'alipay','query',100,'https://example.test','PENDING','PENDING',0,100,100),
      ('query-w','external-w',2,'wxpay','query',100,'https://example.test','PENDING','PENDING',0,100,100),
      ('not-eligible','external-n',1,'alipay','query',100,'https://example.test','PENDING','PENDING',0,100,100);
      INSERT INTO api_client_config VALUES('query-site','${"a".repeat(64)}',1,1,0,0);
      INSERT INTO sites(client_id,revision,configuration,created_at,updated_at) VALUES('query-site',0,'{}',0,0);
      INSERT INTO epay_alipay_bindings(client_id,app_id,seller_id,platform_public_key,signing_key_fingerprint) VALUES('query-site','app','seller','key','${"a".repeat(64)}');
      INSERT INTO epay_wechat_site_bindings VALUES('query-site','app','seller',0);
      INSERT INTO epay_wechat_credentials VALUES('fixture','app','seller','fixture-key','serial',zeroblob(12),zeroblob(32),zeroblob(16),0,1000000,0,'fixture');
      INSERT INTO epay_exact_order_requests VALUES('query-w','query-site','${"c".repeat(64)}','fixture',500,100);
      INSERT INTO epay_alipay_intents VALUES('query-a',1,'app','seller','key',100,5,100);
      INSERT INTO epay_alipay_orders VALUES('query-a','query-site');
      INSERT INTO epay_alipay_requests VALUES('query-a','${"b".repeat(64)}',500);
      INSERT INTO epay_alipay_submissions VALUES('query-a','00000000-0000-4000-8000-000000000001','UNCERTAIN',NULL,NULL,100,100);
      INSERT INTO epay_wechat_submissions VALUES('query-w','00000000-0000-4000-8000-000000000002','UNCERTAIN',NULL,NULL,100,100);`);
  });
  return fixture;
}

it("reserves channel-specific unresolved orders and records pending, failure and confirmation outcomes", async () => {
  const fixture = await buildFixture();
  let now = 10_000, calls = 0;
  try {
    const scheduler = new EPayPaymentQueryScheduler({ database: fixture.db, clock: () => now, intervalMilliseconds: 1_000, maximumPerRun: 5, onError: () => undefined, query: {
      alipay: async tradeNo => { calls++; assert.equal(tradeNo, "query-a"); return { paymentConfirmed: false }; },
      wxpay: async tradeNo => { calls++; assert.equal(tradeNo, "query-w"); throw new Error("provider unavailable"); },
    } });
    assert.equal(await scheduler.trigger(), 2);
    assert.equal(calls, 2);
    const states = fixture.db.read(sql => sql.prepare("SELECT key,value FROM system_metadata WHERE key LIKE 'epay_payment_query:%' ORDER BY key").all());
    assert.equal(states.length, 2);
    assert.equal(JSON.parse(String(states[0]!.value)).lastOutcome, "pending");
    assert.equal(JSON.parse(String(states[1]!.value)).lastOutcome, "failed");
    now += 16_000;
    const query = reservePaymentQuery(fixture.db, now);
    assert.ok(query);
    completePaymentQuery(fixture.db, query, "confirmed", now);
    assert.equal(JSON.parse(String(fixture.db.read(sql => sql.prepare("SELECT value FROM system_metadata WHERE key=?").get("epay_payment_query:" + query.tradeNo)?.value))).lastOutcome, "confirmed");
    await scheduler.stop();
  } finally { fixture.close(); }
});

it("rejects stale leases and never creates payment records by itself", async () => {
  const fixture = await buildFixture();
  try {
    const job = reservePaymentQuery(fixture.db, 10_000);
    assert.ok(job);
    assert.throws(() => completePaymentQuery(fixture.db, { ...job, attempt: job.attempt + 1 }, "pending", 10_001), /stale/);
    const counts = fixture.db.read(sql => ["epay_orders", "epay_balance_ledger", "epay_callback_jobs"].map(table => Number(sql.prepare(`SELECT count(*) n FROM ${table}`).get()?.n)));
    assert.deepEqual(counts, [5, 0, 0]);
  } finally { fixture.close(); }
});

it("coalesces concurrent triggers and drains the current request before stop completes", async () => {
  const fixture = await buildFixture();
  let finish!: (outcome: { paymentConfirmed: boolean }) => void;
  let calls = 0, stopped = false;
  const pending = new Promise<{ paymentConfirmed: boolean }>(resolve => { finish = resolve; });
  const query = async () => { calls++; return pending; };
  const scheduler = new EPayPaymentQueryScheduler({ database: fixture.db, clock: () => 10_000, intervalMilliseconds: 60_000, maximumPerRun: 5, onError: () => assert.fail("unexpected query error"), query: { alipay: query, wxpay: query } });
  try {
    const first = scheduler.trigger(), second = scheduler.trigger();
    assert.equal(first, second);
    assert.equal(calls, 1);
    const stop = scheduler.stop().then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false);
    assert.equal(scheduler.health().inFlight, true);
    finish({ paymentConfirmed: false });
    assert.equal(await first, 1);
    await stop;
    assert.equal(stopped, true);
    assert.equal(calls, 1);
    assert.equal(scheduler.health().inFlight, false);
    await assert.rejects(scheduler.trigger(), /stopped/);
  } finally { finish({ paymentConfirmed: false }); await scheduler.stop(); fixture.close(); }
});

it("recovers expired reservations after reopening and fences the previous process completion", async () => {
  const fixture = await mainOrderFixture();
  let reopened: AppDatabase | undefined;
  try {
    const created = createMainNativeOrder({ ...fixture, identity: mainIdentity, input: mainInput, now: 100 });
    fixture.database.write(sql => sql.prepare("INSERT INTO epay_alipay_submissions VALUES (?,'00000000-0000-4000-8000-000000000003','UNCERTAIN',NULL,NULL,100,100)").run(created.tradeNo));
    const first = reservePaymentQuery(fixture.database, 10_000);
    assert.ok(first);
    // The fixture owns the directory; reopening models a process restart without changing the data.
    const filename = fixture.database.read(sql => String(sql.prepare("PRAGMA database_list").get()?.file));
    fixture.database.close();
    reopened = await AppDatabase.open(filename, { masterKey: fixture.masterKey });
    assert.equal(reservePaymentQuery(reopened, 69_999), null);
    const recovered = reservePaymentQuery(reopened, 70_000);
    assert.ok(recovered);
    assert.equal(recovered.tradeNo, first.tradeNo);
    assert.equal(recovered.attempt, first.attempt + 1);
    assert.throws(() => completePaymentQuery(reopened!, first, "confirmed", 70_001), /stale/);
    completePaymentQuery(reopened, recovered, "pending", 70_001);
    assert.equal(Number(reopened.read(sql => sql.prepare("SELECT count(*) n FROM epay_callback_jobs").get()?.n)), 0);
  } finally { reopened?.close(); fixture.close(); }
});
