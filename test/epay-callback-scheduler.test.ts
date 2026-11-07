import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { EPayCallbackOutbox } from "../src/epay-compat/outbox.ts";
import { EPayCallbackProcessor } from "../src/epay-compat/callback-processor.ts";
import { EPayCallbackScheduler } from "../src/epay-compat/callback-scheduler.ts";
import { recordSyntheticAlipayConfirmation } from "./epay-payment-fixture.ts";

const policy = { timeoutMilliseconds: 1000, leaseMilliseconds: 2000, maximumAttempts: 2, retryDelayMilliseconds: 10 };

it("does not leave a timer active after the initial run fails", async () => {
  let calls = 0;
  const scheduler = new EPayCallbackScheduler({ policy, intervalMilliseconds: 250, maximumPerRun: 1, onError: () => assert.fail("unexpected timer run"), processor: {
    async processOne() { calls++; if (calls === 1) throw new Error("fixture startup failure"); return false; },
  } });
  try {
    await assert.rejects(scheduler.start(), /fixture startup failure/);
    assert.equal(scheduler.health().state, "idle");
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(calls, 1);
    assert.equal(await scheduler.start(), 0);
    assert.equal(scheduler.health().state, "running");
  } finally { await scheduler.stop(); }
});

it("reports failures and recovery without exposing error details", async () => {
  let attempts = 0;
  const scheduler = new EPayCallbackScheduler({ policy, intervalMilliseconds: 1000, maximumPerRun: 1, onError: () => assert.fail("unexpected timer error"), processor: {
    async processOne() {
      if (++attempts < 3) throw new Error("sensitive upstream details");
      return false;
    },
  } });
  assert.deepEqual(scheduler.health(), { state: "idle", inFlight: false, lastSuccessAt: null, lastFailureAt: null, consecutiveFailures: 0 });
  await assert.rejects(scheduler.trigger());
  await assert.rejects(scheduler.trigger());
  const failed = scheduler.health();
  assert.equal(failed.consecutiveFailures, 2);
  assert.equal(typeof failed.lastFailureAt, "number");
  assert.equal(JSON.stringify(failed).includes("sensitive"), false);
  assert.equal(await scheduler.trigger(), 0);
  const recovered = scheduler.health();
  assert.equal(recovered.consecutiveFailures, 0);
  assert.equal(typeof recovered.lastSuccessAt, "number");
  assert.equal(recovered.lastFailureAt, failed.lastFailureAt);
  await scheduler.stop();
  assert.equal(scheduler.health().state, "stopped");
});

it("coalesces concurrent triggers, bounds runs, and waits for cancellation", async () => {
  let calls = 0;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const scheduler = new EPayCallbackScheduler({ policy, intervalMilliseconds: 1000, maximumPerRun: 2, onError: () => assert.fail("unexpected error"), processor: {
    async processOne({ signal }) {
      calls++;
      started();
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      return true;
    },
  } });
  const first = scheduler.trigger();
  await ready;
  assert.equal(scheduler.health().inFlight, true);
  assert.equal(scheduler.trigger(), first);
  await scheduler.stop();
  assert.equal(await first, 1);
  assert.equal(scheduler.health().lastSuccessAt, null);
  assert.equal(calls, 1);
  await assert.rejects(scheduler.trigger(), /stopped/);
});

it("drains the current callback without claiming another during shutdown", async () => {
  let calls = 0, aborted = false;
  let release!: () => void, started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const scheduler = new EPayCallbackScheduler({ policy, intervalMilliseconds: 1000, maximumPerRun: 2, onError: () => assert.fail("unexpected error"), processor: {
    async processOne({ signal }) {
      calls++;
      signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
      started();
      await pending;
      return true;
    },
  } });
  const run = scheduler.trigger();
  await ready;
  const stopped = scheduler.stop({ drain: true });
  let finished = false;
  void stopped.then(() => { finished = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.equal(aborted, false);
  release();
  await stopped;
  assert.equal(await run, 1);
  assert.equal(calls, 1);
  assert.equal(scheduler.health().state, "stopped");
});

it("persists an acknowledged final attempt while leaving later callbacks queued", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-scheduler-drain-"));
  const key = randomBytes(32);
  const db = await AppDatabase.open(join(dir, "db.sqlite"), { masterKey: key });
  let release!: () => void, started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  let aborted = false;
  try {
    db.write(sql => {
      sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'merchant',0,1,0,0);
        INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES
        ('a','a',1,'item',100,100,'https://example.test','PAID','PENDING',0,0,0),
        ('b','b',1,'item',100,100,'https://example.test','PAID','PENDING',0,0,0)`);
      recordSyntheticAlipayConfirmation(sql, "a", 1);
      recordSyntheticAlipayConfirmation(sql, "b", 1);
    });
    const queue = new EPayCallbackOutbox(db);
    queue.enqueue("a", 1, 100);
    queue.enqueue("b", 1, 100);
    const processor = new EPayCallbackProcessor({ database: db, clock: () => 100, secret: () => "test", transport: () => ({ async post({ signal }) {
      signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
      started();
      await pending;
      return { status: 200, body: Buffer.from("success"), contentType: null, contentEncoding: null, responseFingerprint: "", resolvedAddressesFingerprint: "", connectedAddress: "" };
    } }) });
    const scheduler = new EPayCallbackScheduler({ processor, policy: { ...policy, maximumAttempts: 1 }, intervalMilliseconds: 1000, maximumPerRun: 2, onError: () => assert.fail("unexpected error") });
    const running = scheduler.trigger();
    await ready;
    const stopping = scheduler.stop({ drain: true });
    release();
    await stopping;
    assert.equal(await running, 1);
    assert.equal(aborted, false);
    const jobs = db.read(sql => sql.prepare("SELECT trade_no,status,attempts FROM epay_callback_jobs ORDER BY trade_no").all());
    assert.deepEqual(jobs.map(row => ({ ...row, attempts: Number(row.attempts) })), [{ trade_no: "a", status: "SUCCEEDED", attempts: 1 }, { trade_no: "b", status: "PENDING", attempts: 0 }]);
  } finally { release(); db.close(); key.fill(0); rmSync(dir, { recursive: true, force: true }); }
});

it("processes a bounded isolated queue and resumes remaining work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-scheduler-"));
  const db = await AppDatabase.open(join(dir, "db.sqlite"), { masterKey: randomBytes(32) });
  try {
    db.write((sql) => sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'merchant',0,1,0,0);
      INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES
      ('a','a',1,'item',100,100,'https://example.test','PAID','PENDING',0,0,0),
      ('b','b',1,'item',100,100,'https://example.test','PAID','PENDING',0,0,0)`));
    db.write((sql) => { recordSyntheticAlipayConfirmation(sql, "a", 1); recordSyntheticAlipayConfirmation(sql, "b", 1); });
    const queue = new EPayCallbackOutbox(db);
    queue.enqueue("a", 1, 100);
    queue.enqueue("b", 1, 100);
    const processor = new EPayCallbackProcessor({ database: db, clock: () => 100, secret: () => "test", transport: () => ({ async post() { return { status: 200, body: Buffer.from("success"), contentType: null, contentEncoding: null, responseFingerprint: "", resolvedAddressesFingerprint: "", connectedAddress: "" }; } }) });
    const scheduler = new EPayCallbackScheduler({ processor, policy, intervalMilliseconds: 1000, maximumPerRun: 1, onError: () => assert.fail("unexpected error") });
    assert.equal(await scheduler.trigger(), 1);
    assert.equal(await scheduler.trigger(), 1);
    assert.equal(await scheduler.trigger(), 0);
    await scheduler.stop();
    const count = db.read((sql) => sql.prepare("SELECT count(*) AS n FROM epay_callback_jobs WHERE status='SUCCEEDED'").get());
    assert.equal(Number(count?.n), 2);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
