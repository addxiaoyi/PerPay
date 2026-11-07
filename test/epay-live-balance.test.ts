import assert from "node:assert/strict";
import { createCipheriv, generateKeyPairSync, sign } from "node:crypto";
import { it } from "node:test";
import { installBalanceOpenings, planBalanceOpenings } from "../src/epay-compat/balance-opening.ts";
import { adjustMerchantBalance, readLiveBalance } from "../src/epay-compat/live-balance.ts";
import { balanceFixture } from "./epay-live-balance-fixture.ts";
import { confirmAlipayInTransaction, confirmAlipayPayment } from "../src/epay-compat/confirm-alipay.ts";
import { confirmWechatPayment } from "../src/epay-compat/confirm-wechat.ts";

const now = 1_800_000_000_000;
const pairs = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKey = pairs.publicKey.export({ type: "spki", format: "pem" }).toString();

it("carries legacy balances once, preserves quarantine and refuses stale opening plans", async () => {
  const f = await balanceFixture();
  try {
    const plan = f.db.write(sql => planBalanceOpenings(sql, f.cipher, "a".repeat(64)));
    assert.deepEqual(plan.merchants.map(m => m.availableCents), [950, 1900]);
    assert.throws(() => f.db.write(sql => installBalanceOpenings(sql, f.cipher, { ...plan, sourceReportSha256: "b".repeat(64) }, now)), /plan changed/);
    const opened = f.db.write(sql => installBalanceOpenings(sql, f.cipher, plan, now));
    assert.equal(opened.merchantsOpened, 2);
    assert.equal(opened.replayedPayments, 0);
    assert.throws(() => f.db.write(sql => installBalanceOpenings(sql, f.cipher, plan, now)), /unopened/);
    f.db.read(sql => {
      assert.equal(readLiveBalance(sql, 1).availableCents, 950);
      assert.throws(() => readLiveBalance(sql, 3), /opening/);
      assert.equal(Number(sql.prepare("SELECT count(*) n FROM epay_balance_ledger").get()?.n), 0);
      assert.equal(Number(sql.prepare("SELECT count(*) n FROM epay_callback_jobs").get()?.n), 0);
    });
    assert.throws(() => f.db.write(sql => sql.exec("UPDATE epay_balance_openings SET available_cents=0")), /immutable/);
  } finally { f.close(); }
});

it("posts exact signed Alipay and WeChat receipts, balances and callbacks atomically", async () => {
  const f = await balanceFixture(), apiKey = "1".repeat(32);
  const signed = (tradeNo: string, transaction: string, amount = "1.00") => {
    const fields: Record<string, string> = { app_id: "app", seller_id: "seller", out_trade_no: tradeNo, trade_no: transaction, trade_status: "TRADE_SUCCESS", total_amount: amount };
    const content = Object.keys(fields).sort().map(key => `${key}=${fields[key]}`).join("&");
    return { ...fields, sign_type: "RSA2", sign: sign("RSA-SHA256", Buffer.from(content), pairs.privateKey).toString("base64") };
  };
  try {
    f.db.write(sql => installBalanceOpenings(sql, f.cipher, planBalanceOpenings(sql, f.cipher, "a".repeat(64)), now));
    f.db.write(sql => {
      for (const [trade, merchant, channel] of [["native-a", 1, "alipay"], ["native-b", 2, "alipay"], ["native-c", 1, "alipay"], ["native-w", 1, "wxpay"]] as const) {
        sql.prepare(`INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at,type_code)
          VALUES(?,?,?,'native',100,'https://example.test','PENDING','PENDING',0,?,?,?)`).run(trade, trade, merchant, now, now, channel);
        if (channel === "alipay") sql.prepare("INSERT INTO epay_alipay_intents VALUES(?,?,'app','seller',?,100,5,?)").run(trade, merchant, publicKey, now);
      }
      const sealed = f.cipher.encrypt("epay:config:wechat-intent:native-w", 1, apiKey);
      sql.prepare("INSERT INTO epay_wechat_intents VALUES('native-w',1,'app','wx-merchant',?,'serial',?,?,?,100,5,?)").run(publicKey, sealed.nonce, sealed.ciphertext, sealed.authenticationTag, now);
    });
    assert.throws(() => confirmAlipayPayment(f.db, signed("native-a", "provider-a", "1.01"), now), /amount/);
    confirmAlipayPayment(f.db, signed("native-a", "provider-a"), now);
    confirmAlipayPayment(f.db, signed("native-a", "provider-a"), now + 1);
    assert.throws(() => confirmAlipayPayment(f.db, signed("native-b", "provider-a"), now), /UNIQUE/);
    confirmAlipayPayment(f.db, signed("native-b", "provider-b"), now);
    const transaction = { appid: "app", mchid: "wx-merchant", out_trade_no: "native-w", transaction_id: "provider-w", trade_state: "SUCCESS", amount: { total: 100, currency: "CNY" } };
    const encrypt = createCipheriv("aes-256-gcm", Buffer.from(apiKey), Buffer.from("123456789012"));
    encrypt.setAAD(Buffer.from("transaction"));
    const ciphertext = Buffer.concat([encrypt.update(JSON.stringify(transaction)), encrypt.final(), encrypt.getAuthTag()]).toString("base64");
    const body = Buffer.from(JSON.stringify({ event_type: "TRANSACTION.SUCCESS", resource: { algorithm: "AEAD_AES_256_GCM", nonce: "123456789012", associated_data: "transaction", ciphertext } }));
    const timestamp = String(now / 1000);
    const headers = new Headers({ "wechatpay-timestamp": timestamp, "wechatpay-nonce": "nonce", "wechatpay-serial": "serial", "wechatpay-signature": sign("RSA-SHA256", Buffer.concat([Buffer.from(`${timestamp}\nnonce\n`), body, Buffer.from("\n")]), pairs.privateKey).toString("base64") });
    confirmWechatPayment(f.db, f.key, "native-w", body, headers, now);
    confirmWechatPayment(f.db, f.key, "native-w", body, headers, now);
    assert.equal(f.db.read(sql => readLiveBalance(sql, 1)).availableCents, 1140);
    assert.equal(f.db.read(sql => readLiveBalance(sql, 2)).availableCents, 1995);
    f.db.write(sql => sql.exec("CREATE TRIGGER reject_new_callback BEFORE INSERT ON epay_callback_jobs BEGIN SELECT RAISE(ABORT,'test outbox failure'); END"));
    f.db.write(sql => assert.throws(() => confirmAlipayInTransaction(sql, signed("native-c", "provider-c"), now), /outbox failure/));
    f.db.read(sql => {
      assert.equal(readLiveBalance(sql, 1).availableCents, 1140);
      assert.equal(readLiveBalance(sql, 1).version, 2);
      assert.equal(sql.prepare("SELECT status FROM epay_orders WHERE trade_no='native-c'").get()?.status, "PENDING");
      assert.equal(sql.prepare("SELECT 1 FROM epay_alipay_confirmations WHERE trade_no='native-c'").get(), undefined);
    });
    assert.throws(() => f.db.write(sql => sql.exec("DELETE FROM epay_balance_ledger WHERE entry_id='epay_payment:native-a'")), /immutable/);
  } finally { f.close(); }
});

it("adjusts balances once with audit identity, stale-version checks and rollback", async () => {
  const f = await balanceFixture();
  try {
    f.db.write(sql => installBalanceOpenings(sql, f.cipher, planBalanceOpenings(sql, f.cipher, "a".repeat(64)), now));
    const input = { merchantId: 1, requestId: "adjustment-request-1", deltaCents: -50, expectedVersion: 0, actor: "admin", reason: "测试扣减" };
    const changed = adjustMerchantBalance(f.db, input, now);
    assert.equal(changed.availableCents, 900);
    assert.equal(changed.version, 1);
    assert.equal(adjustMerchantBalance(f.db, input, now).duplicate, true);
    assert.throws(() => adjustMerchantBalance(f.db, { ...input, actor: "another-admin" }, now), /already used/);
    assert.throws(() => adjustMerchantBalance(f.db, { ...input, requestId: "adjustment-request-2" }, now), /balance changed/);
    assert.throws(() => adjustMerchantBalance(f.db, { ...input, requestId: "adjustment-request-2", expectedVersion: 1, deltaCents: -901 }, now), /insufficient/);
    f.db.write(sql => sql.exec("CREATE TRIGGER reject_balance_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'test audit failure'); END"));
    assert.throws(() => adjustMerchantBalance(f.db, { ...input, requestId: "adjustment-request-2", expectedVersion: 1 }, now), /audit failure/);
    f.db.read(sql => {
      assert.equal(readLiveBalance(sql, 1).availableCents, 900);
      assert.equal(readLiveBalance(sql, 2).availableCents, 1900);
      assert.equal(Number(sql.prepare("SELECT count(*) n FROM epay_balance_adjustments").get()?.n), 1);
      assert.equal(sql.prepare("SELECT actor_id FROM audit_events WHERE action='epay.merchant_balance.adjusted'").get()?.actor_id, "admin");
    });
    f.db.write(sql => sql.exec("UPDATE epay_live_balances SET available_cents=1000 WHERE merchant_id=1"));
    assert.throws(() => f.db.read(sql => readLiveBalance(sql, 1)), /ledger differ/);
  } finally { f.close(); }
});
