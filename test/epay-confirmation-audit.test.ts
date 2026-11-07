import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { auditConfirmedPayments } from "../src/epay-compat/confirmation-audit.ts";
import { recordSyntheticAlipayConfirmation } from "./epay-payment-fixture.ts";

it("detects missing callback and incorrect ledger without treating legacy orders as verified", async () => {
  const directory = mkdtempSync(join(tmpdir(), "perpay-confirm-audit-"));
  const db = await AppDatabase.open(join(directory, "state.sqlite"), { masterKey: randomBytes(32) });
  try {
    db.write(sql => {
      sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'fixture',0,1,0,0);
        INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES
        ('a','a',1,'item',100,100,'https://example.test','PAID','PENDING',0,0,0),
        ('legacy','legacy',1,'legacy',100,100,'https://example.test','PAID','PENDING',0,0,0)`);
      recordSyntheticAlipayConfirmation(sql, "a", 1);
    });
    assert.deepEqual(db.read(auditConfirmedPayments), { confirmed: 1, inconsistent: 1, unconfirmedLedger: 0, unconfirmedCallbacks: 0, paidWithoutConfirmation: 1, intentPaidWithoutConfirmation: 0, paidWithoutIntent: 1 });
    db.write(sql => sql.exec("INSERT INTO epay_callback_jobs(trade_no,merchant_id,status,next_attempt_at,created_at,updated_at) VALUES('a',1,'PENDING',0,0,0)"));
    assert.deepEqual(db.read(auditConfirmedPayments), { confirmed: 1, inconsistent: 0, unconfirmedLedger: 0, unconfirmedCallbacks: 0, paidWithoutConfirmation: 1, intentPaidWithoutConfirmation: 0, paidWithoutIntent: 1 });
    db.write(sql => sql.exec("UPDATE epay_callback_jobs SET status='SUCCEEDED' WHERE trade_no='a'"));
    assert.equal(db.read(auditConfirmedPayments).inconsistent, 1);
    db.write(sql => sql.exec("UPDATE epay_orders SET notify_status='SUCCESS' WHERE trade_no='a'"));
    assert.equal(db.read(auditConfirmedPayments).inconsistent, 0);
    db.write(sql => sql.exec("UPDATE epay_callback_jobs SET status='FAILED' WHERE trade_no='a'"));
    assert.equal(db.read(auditConfirmedPayments).inconsistent, 1);
    db.write(sql => sql.exec("UPDATE epay_orders SET notify_status='FAILED' WHERE trade_no='a'"));
    assert.equal(db.read(auditConfirmedPayments).inconsistent, 0);
    db.write(sql => sql.exec("UPDATE epay_callback_jobs SET status='PENDING' WHERE trade_no='a'; UPDATE epay_orders SET notify_status='PENDING' WHERE trade_no='a'"));
    db.write(sql => sql.exec("UPDATE epay_balance_ledger SET available_delta_cents=94 WHERE entry_id='epay_payment:a'"));
    assert.deepEqual(db.read(auditConfirmedPayments), { confirmed: 1, inconsistent: 1, unconfirmedLedger: 0, unconfirmedCallbacks: 0, paidWithoutConfirmation: 1, intentPaidWithoutConfirmation: 0, paidWithoutIntent: 1 });
    db.write(sql => sql.exec(`INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,occurred_at,source) VALUES('epay_payment:legacy',1,'payment_paid',100,0,'perpay_epay');
      INSERT INTO epay_callback_jobs(trade_no,merchant_id,status,next_attempt_at,created_at,updated_at) VALUES('legacy',1,'PENDING',0,0,0)`));
    assert.deepEqual(db.read(auditConfirmedPayments), { confirmed: 1, inconsistent: 1, unconfirmedLedger: 1, unconfirmedCallbacks: 1, paidWithoutConfirmation: 1, intentPaidWithoutConfirmation: 0, paidWithoutIntent: 1 });
    db.write(sql => sql.exec("INSERT INTO epay_alipay_intents VALUES('legacy',1,'app','seller','fixture-key',100,5,0)"));
    const nativeWithoutProof = db.read(auditConfirmedPayments);
    assert.equal(nativeWithoutProof.intentPaidWithoutConfirmation, 1);
    assert.equal(nativeWithoutProof.paidWithoutIntent, 0);
    assert.equal(nativeWithoutProof.unconfirmedLedger, 1);
    assert.equal(nativeWithoutProof.unconfirmedCallbacks, 1);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
