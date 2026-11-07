import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { EPayCallbackOutbox, enqueuePaidCallback } from "../src/epay-compat/outbox.ts";

it("persists callback attempts, fences stale leases and retries after restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perpay-epay-outbox-"));
  const path = join(dir, "db.sqlite");
  const masterKey = randomBytes(32);
  let db: AppDatabase | undefined;
  try {
    db = await AppDatabase.open(path, { masterKey });
    db.write((connection) => {
      connection.prepare("INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'merchant',0,1,0,0)").run();
      connection.prepare(`INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at)
        VALUES ('trade','external',1,'item',100,100,'https://example.test/notify','PAID','PENDING',7,0,0)`).run();
      connection.prepare(`INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at)
        VALUES ('mismatch','other',1,'item',100,101,'https://example.test/notify','PAID','PENDING',0,0,0)`).run();
    });
    let queue = new EPayCallbackOutbox(db);
    assert.throws(() => queue.enqueue("trade", 2, 100), /exact-amount/);
    assert.throws(() => queue.enqueue("mismatch", 1, 100), /exact-amount/);
    assert.equal(queue.enqueue("trade", 1, 100), true);
    assert.equal(queue.enqueue("trade", 1, 100), false);
    const first = queue.claim(100, 10, 3)!;
    assert.throws(() => queue.complete({ ...first, now: 99, acknowledged: true, retryDelayMilliseconds: 20, maximumAttempts: 3 }), /predates attempt/);
    assert.equal(db.read((connection) => connection.prepare("SELECT outcome FROM epay_callback_attempts WHERE attempt_id = ?").get(first.attemptId))?.outcome, "STARTED");
    const firstOrder = db.read((connection) => connection.prepare("SELECT notify_status, notify_count, notify_last_at FROM epay_orders WHERE trade_no = 'trade'").get())!;
    assert.deepEqual([firstOrder.notify_status, Number(firstOrder.notify_count), Number(firstOrder.notify_last_at)], ["PENDING", 8, 100]);
    assert.equal(queue.claim(105, 10, 3), null);
    db.close();
    db = await AppDatabase.open(path, { masterKey });
    queue = new EPayCallbackOutbox(db);
    const second = queue.claim(110, 10, 3)!;
    assert.notEqual(second.leaseToken, first.leaseToken);
    assert.throws(() => queue.complete({ ...first, now: 111, acknowledged: true, retryDelayMilliseconds: 20, maximumAttempts: 3 }), /stale/);
    queue.complete({ ...second, now: 111, acknowledged: false, retryDelayMilliseconds: 20, maximumAttempts: 3, httpStatus: 500, errorCode: "http_error" });
    assert.equal(db.read((connection) => connection.prepare("SELECT notify_status FROM epay_orders WHERE trade_no = 'trade'").get())?.notify_status, "PENDING");
    assert.equal(queue.claim(130, 10, 3), null);
    const third = queue.claim(131, 10, 3)!;
    queue.complete({ ...third, now: 132, acknowledged: true, retryDelayMilliseconds: 20, maximumAttempts: 3, httpStatus: 200 });
    const finalOrder = db.read((connection) => connection.prepare("SELECT notify_status, notify_count, notify_last_at FROM epay_orders WHERE trade_no = 'trade'").get())!;
    assert.deepEqual([finalOrder.notify_status, Number(finalOrder.notify_count), Number(finalOrder.notify_last_at)], ["SUCCESS", 10, 131]);
    const rows = db.read((connection) => connection.prepare("SELECT outcome FROM epay_callback_attempts ORDER BY attempt_number").all());
    assert.deepEqual(rows.map((row) => row.outcome), ["EXPIRED", "RETRY", "SUCCESS"]);
    assert.equal(queue.claim(200, 10, 3), null);
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("rolls back a payment state update and callback enqueue together", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perpay-epay-atomic-"));
  const db = await AppDatabase.open(join(dir, "db.sqlite"), { masterKey: randomBytes(32) });
  try {
    db.write((connection) => {
      connection.prepare("INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'merchant',0,1,0,0)").run();
      connection.prepare(`INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at)
        VALUES ('trade','external',1,'item',100,'https://example.test/notify','PENDING','PENDING',0,0,0)`).run();
    });
    assert.throws(() => db.read((connection) => enqueuePaidCallback(connection, "trade", 1, 100)), /active transaction/);
    assert.throws(() => db.write((connection) => {
      connection.prepare("UPDATE epay_orders SET status = 'PAID', real_money_cents = 100 WHERE trade_no = 'trade'").run();
      assert.equal(enqueuePaidCallback(connection, "trade", 1, 100), true);
      throw new Error("simulate later failure");
    }), /simulate later failure/);
    const state = db.read((connection) => connection.prepare("SELECT status, real_money_cents FROM epay_orders WHERE trade_no = 'trade'").get());
    assert.equal(state?.status, "PENDING");
    assert.equal(state?.real_money_cents, null);
    assert.equal(db.read((connection) => connection.prepare("SELECT COUNT(*) AS count FROM epay_callback_jobs").get())?.count, 0n);
    db.write((connection) => {
      connection.prepare("UPDATE epay_orders SET status = 'PAID', real_money_cents = 100 WHERE trade_no = 'trade'").run();
      assert.equal(enqueuePaidCallback(connection, "trade", 1, 100), true);
      assert.equal(enqueuePaidCallback(connection, "trade", 1, 100), false);
    });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("marks an expired final attempt as failed instead of retrying indefinitely", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perpay-epay-outbox-limit-"));
  const db = await AppDatabase.open(join(dir, "db.sqlite"), { masterKey: randomBytes(32) });
  try {
    db.write((connection) => {
      connection.prepare("INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'merchant',0,1,0,0)").run();
      connection.prepare(`INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at)
        VALUES ('trade','external',1,'item',100,100,'https://example.test/notify','PAID','PENDING',0,0,0)`).run();
    });
    const queue = new EPayCallbackOutbox(db);
    queue.enqueue("trade", 1, 100);
    queue.claim(100, 10, 1);
    assert.equal(queue.claim(110, 10, 1), null);
    const status = db.read((connection) => connection.prepare("SELECT status FROM epay_callback_jobs WHERE trade_no = 'trade'").get());
    assert.equal(status?.status, "FAILED");
    assert.equal(db.read((connection) => connection.prepare("SELECT notify_status FROM epay_orders WHERE trade_no = 'trade'").get())?.notify_status, "FAILED");
    const attempt = db.read((connection) => connection.prepare("SELECT outcome FROM epay_callback_attempts WHERE trade_no = 'trade'").get());
    assert.equal(attempt?.outcome, "EXPIRED");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("allows one GET only after a final 405 or 415 and fences its expired lease", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-get-lease-"));
  const db = await AppDatabase.open(join(dir, "db.sqlite"), { masterKey: randomBytes(32) });
  try {
    db.write((sql) => sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'merchant',0,1,0,0);
      INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES
      ('a','a',1,'item',100,100,'https://example.test','PAID','PENDING',0,0,0),
      ('b','b',1,'item',100,100,'https://example.test','PAID','PENDING',0,0,0)`));
    const queue = new EPayCallbackOutbox(db);
    queue.enqueue("a", 1, 100);
    const post = queue.claim(100, 10, 1)!;
    queue.complete({ ...post, now: 101, acknowledged: false, retryDelayMilliseconds: 1, maximumAttempts: 1, httpStatus: 415 });
    const fallback = queue.claim(102, 10, 1)!;
    assert.equal(fallback.method, "GET");
    assert.equal(queue.claim(112, 10, 1), null);
    assert.throws(() => queue.complete({ ...fallback, now: 113, acknowledged: true, retryDelayMilliseconds: 1, maximumAttempts: 1 }), /stale/);
    queue.enqueue("b", 1, 120);
    const failed = queue.claim(120, 10, 1)!;
    queue.complete({ ...failed, now: 121, acknowledged: false, retryDelayMilliseconds: 1, maximumAttempts: 1, httpStatus: 500 });
    assert.equal(queue.claim(122, 10, 1), null);
    const rows = db.read((sql) => sql.prepare("SELECT trade_no, method, outcome FROM epay_callback_attempts ORDER BY trade_no, attempt_number").all());
    assert.deepEqual(rows.map((row) => [row.trade_no, row.method, row.outcome]), [["a", "POST", "RETRY"], ["a", "GET", "EXPIRED"], ["b", "POST", "FAILED"]]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("retries an expired GET lease within its own bounded attempt budget after reopening", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-get-retry-"));
  const path = join(dir, "db.sqlite");
  const key = randomBytes(32);
  let db = await AppDatabase.open(path, { masterKey: key });
  try {
    db.write((sql) => sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'m',0,1,0,0);
      INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at)
      VALUES ('trade','outside',1,'item',100,100,'https://example.test/callback','PAID','PENDING',0,0,0)`));
    let queue = new EPayCallbackOutbox(db);
    queue.enqueue("trade", 1, 100);
    for (const now of [100, 102]) {
      const post = queue.claim(now, 10, 2)!;
      assert.equal(post.method, "POST");
      queue.complete({ ...post, now: now + 1, acknowledged: false, retryDelayMilliseconds: 1, maximumAttempts: 2, httpStatus: 405 });
    }
    const firstGet = queue.claim(104, 10, 2)!;
    assert.equal(firstGet.method, "GET");
    db.close();
    db = await AppDatabase.open(path, { masterKey: key });
    queue = new EPayCallbackOutbox(db);
    const secondGet = queue.claim(114, 10, 2)!;
    assert.equal(secondGet.method, "GET");
    assert.throws(() => queue.complete({ ...firstGet, now: 115, acknowledged: true, retryDelayMilliseconds: 1, maximumAttempts: 2 }), /stale/);
    queue.complete({ ...secondGet, now: 115, acknowledged: true, retryDelayMilliseconds: 1, maximumAttempts: 2 });
    assert.equal(queue.claim(120, 10, 2), null);
    const attempts = db.read((sql) => sql.prepare("SELECT method, outcome FROM epay_callback_attempts ORDER BY attempt_number").all());
    assert.deepEqual(attempts.map((row) => [row.method, row.outcome]), [["POST", "RETRY"], ["POST", "RETRY"], ["GET", "EXPIRED"], ["GET", "SUCCESS"]]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
