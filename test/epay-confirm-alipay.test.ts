import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { confirmAlipayInTransaction, confirmAlipayPayment } from "../src/epay-compat/confirm-alipay.ts";
import { auditBalanceMovements, captureBalanceCheckpoint } from "../src/epay-compat/balance-checkpoint.ts";

it("atomically confirms authenticated exact payments, fences replay and rolls back failures", async () => {
  const directory = mkdtempSync(join(tmpdir(), "epay-confirm-"));
  const db = await AppDatabase.open(join(directory, "db.sqlite"), { masterKey: randomBytes(32) });
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const signed = (tradeNo: string, provider: string, changes: Record<string, string> = {}) => {
    const fields: Record<string, string> = { app_id: "app", seller_id: "seller", out_trade_no: tradeNo, trade_no: provider, trade_status: "TRADE_SUCCESS", total_amount: "1.00", ...changes };
    const content = Object.keys(fields).filter((key) => fields[key] !== "").sort().map((key) => `${key}=${fields[key]}`).join("&");
    return { ...fields, sign_type: "RSA2", sign: sign("RSA-SHA256", Buffer.from(content), keys.privateKey).toString("base64") };
  };
  try {
    db.write((sql) => {
      sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'a',1000,1,0,0),(2,'b',2000,1,0,0);
        INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES
          ('a','outside-a',1,'a',100,'https://example.test','PENDING','PENDING',0,1,1),
          ('b','outside-b',2,'b',100,'https://example.test','PENDING','PENDING',0,1,1),
          ('c','outside-c',1,'c',100,'https://example.test','PENDING','PENDING',0,1,1),
          ('d','outside-d',2,'d',100,'https://example.test','PENDING','PENDING',0,1,1)`);
      for (const [trade, merchant] of [["a", 1], ["b", 2], ["c", 1], ["d", 2]] as const) sql.prepare("INSERT INTO epay_alipay_intents VALUES (?, ?, 'app', 'seller', ?, 100, 5, 1)").run(trade, merchant, publicKey);
      sql.exec("UPDATE epay_orders SET type_code='alipay'");
    });
    const baseline = db.write(captureBalanceCheckpoint);
    db.write((sql) => sql.prepare("UPDATE epay_orders SET type_code='wxpay' WHERE trade_no='a'").run());
    assert.throws(() => confirmAlipayPayment(db, signed("a", "provider-a"), 10), /mismatch/);
    assert.equal(Number(db.read((sql) => sql.prepare("SELECT count(*) AS n FROM epay_balance_ledger").get())?.n), 0);
    db.write((sql) => sql.prepare("UPDATE epay_orders SET type_code='alipay' WHERE trade_no='a'").run());
    assert.throws(() => confirmAlipayPayment(db, { ...signed("a", "provider-a"), total_amount: "2.00" }, 10), /signature/);
    assert.throws(() => confirmAlipayPayment(db, signed("a", "provider-a", { seller_id: "other" }), 10), /identity/);
    assert.throws(() => confirmAlipayPayment(db, signed("a", "provider-a", { total_amount: "1.01" }), 10), /amount/);
    for (const missing of [{ app_id: "" }, { seller_id: "" }, { total_amount: "" }, { trade_no: "" }]) {
      assert.throws(() => confirmAlipayPayment(db, signed("a", "provider-a", missing), 10));
    }
    const rejected = db.read(sql => ({
      status: sql.prepare("SELECT status FROM epay_orders WHERE trade_no='a'").get()?.status,
      proofs: sql.prepare("SELECT count(*) AS n FROM epay_alipay_confirmations").get()?.n,
      ledger: sql.prepare("SELECT count(*) AS n FROM epay_balance_ledger").get()?.n,
      callbacks: sql.prepare("SELECT count(*) AS n FROM epay_callback_jobs").get()?.n,
    }));
    assert.deepEqual(rejected, { status: "PENDING", proofs: 0n, ledger: 0n, callbacks: 0n });
    assert.deepEqual(confirmAlipayPayment(db, signed("a", "provider-a"), 10), { duplicate: false });
    assert.deepEqual(confirmAlipayPayment(db, signed("a", "provider-a"), 11), { duplicate: true });
    db.write(sql => sql.prepare("UPDATE epay_callback_jobs SET status='SUCCEEDED' WHERE trade_no='a'").run());
    assert.throws(() => confirmAlipayPayment(db, signed("a", "provider-a"), 11), /incomplete prior payment confirmation/);
    db.write(sql => sql.prepare("UPDATE epay_orders SET notify_status='SUCCESS' WHERE trade_no='a'").run());
    assert.deepEqual(confirmAlipayPayment(db, signed("a", "provider-a"), 11), { duplicate: true });
    db.write(sql => sql.exec("UPDATE epay_callback_jobs SET status='FAILED' WHERE trade_no='a'; UPDATE epay_orders SET notify_status='FAILED' WHERE trade_no='a'"));
    assert.deepEqual(confirmAlipayPayment(db, signed("a", "provider-a"), 11), { duplicate: true });
    db.write(sql => sql.exec("UPDATE epay_callback_jobs SET status='PENDING' WHERE trade_no='a'; UPDATE epay_orders SET notify_status='PENDING' WHERE trade_no='a'"));
    assert.throws(() => confirmAlipayPayment(db, signed("a", "different"), 11), /conflicting/);
    assert.throws(() => confirmAlipayPayment(db, signed("b", "provider-a"), 11), /UNIQUE/);
    const state = db.read((sql) => ({
      order: sql.prepare("SELECT status, real_money_cents, get_money_cents FROM epay_orders WHERE trade_no='a'").get(),
      other: sql.prepare("SELECT status FROM epay_orders WHERE trade_no='b'").get(),
      ledger: sql.prepare("SELECT available_delta_cents FROM epay_balance_ledger WHERE entry_id='epay_payment:a'").get(),
      queue: sql.prepare("SELECT count(*) AS count FROM epay_callback_jobs").get(),
      balance: sql.prepare("SELECT balance_cents FROM epay_merchant_accounts WHERE merchant_id=1").get(),
    }));
    assert.equal(state.order?.status, "PAID");
    assert.equal(Number(state.order?.real_money_cents), 100);
    assert.equal(Number(state.order?.get_money_cents), 100);
    assert.equal(state.other?.status, "PENDING");
    assert.equal(Number(state.ledger?.available_delta_cents), 95);
    assert.equal(Number(state.queue?.count), 1);
    assert.equal(Number(state.balance?.balance_cents), 1000);
    assert.equal(auditBalanceMovements(baseline, db.write(captureBalanceCheckpoint)).balanceMismatches, 1);
    db.write((sql) => sql.prepare("UPDATE epay_merchant_accounts SET enabled=0 WHERE merchant_id=2").run());
    assert.throws(() => confirmAlipayPayment(db, { ...signed("d", "provider-d"), total_amount: "2.00" }, 12), /signature/);
    assert.deepEqual(confirmAlipayPayment(db, signed("d", "provider-d"), 12), { duplicate: false });
    assert.deepEqual(confirmAlipayPayment(db, signed("d", "provider-d"), 13), { duplicate: true });
    db.write((sql) => sql.prepare("INSERT INTO epay_callback_jobs(trade_no,merchant_id,status,next_attempt_at,created_at,updated_at) VALUES ('c',1,'PENDING',0,0,0)").run());
    assert.throws(() => confirmAlipayPayment(db, signed("c", "provider-c"), 20), /callback already exists/);
    db.write(sql => { assert.throws(() => confirmAlipayInTransaction(sql, signed("c", "provider-c"), 20), /callback already exists/); });
    const rolledBack = db.read((sql) => ({ order: sql.prepare("SELECT status FROM epay_orders WHERE trade_no='c'").get(), proof: sql.prepare("SELECT count(*) AS count FROM epay_alipay_confirmations WHERE trade_no='c'").get(), ledger: sql.prepare("SELECT count(*) AS count FROM epay_balance_ledger WHERE entry_id='epay_payment:c'").get() }));
    assert.equal(rolledBack.order?.status, "PENDING");
    assert.equal(Number(rolledBack.proof?.count), 0);
    assert.equal(Number(rolledBack.ledger?.count), 0);
    assert.throws(() => db.write((sql) => sql.prepare("UPDATE epay_alipay_intents SET fee_cents=0 WHERE trade_no='a'").run()), /immutable/);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
