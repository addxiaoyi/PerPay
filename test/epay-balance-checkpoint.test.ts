import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { auditBalanceMovements, captureBalanceCheckpoint } from "../src/epay-compat/balance-checkpoint.ts";
import { recordSyntheticAlipayConfirmation } from "./epay-payment-fixture.ts";

it("flags a confirmed payment whose merchant balance did not move with its ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-balance-checkpoint-"));
  const db = await AppDatabase.open(join(dir, "db.sqlite"), { masterKey: randomBytes(32) });
  try {
    db.write((sql) => sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'one',1000,1,0,0),(2,'two',2000,1,0,0);
      INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES ('trade','outside',1,'item',100,100,'https://example.test/callback','PAID','PENDING',0,0,0)`));
    assert.throws(() => db.read(captureBalanceCheckpoint), /requires a transaction/);
    const baseline = db.write(captureBalanceCheckpoint);
    db.write((sql) => recordSyntheticAlipayConfirmation(sql, "trade", 1));
    const unpaidBalance = db.write(captureBalanceCheckpoint);
    assert.deepEqual(auditBalanceMovements(baseline, unpaidBalance), { merchantsCompared: 2, missingMerchants: 0, newMerchants: 0, changedEntries: 0, removedEntries: 0, balanceMismatches: 1, baselineVerified: false, financiallyReconciled: false });
    db.write((sql) => sql.exec("UPDATE epay_merchant_accounts SET balance_cents=1095 WHERE merchant_id=1"));
    assert.equal(auditBalanceMovements(baseline, db.write(captureBalanceCheckpoint)).balanceMismatches, 0);
    const captured = db.write(captureBalanceCheckpoint);
    db.write((sql) => sql.exec("UPDATE epay_balance_ledger SET reason='changed' WHERE entry_id='epay_payment:trade'"));
    assert.equal(auditBalanceMovements(captured, db.write(captureBalanceCheckpoint)).changedEntries, 1);
    db.write((sql) => sql.exec("DELETE FROM epay_balance_ledger WHERE entry_id='epay_payment:trade'"));
    assert.equal(auditBalanceMovements(captured, db.write(captureBalanceCheckpoint)).removedEntries, 1);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("rejects incomplete or unsafe checkpoint values without claiming reconciliation", () => {
  const empty = { accounts: [], ledger: [] };
  assert.throws(() => auditBalanceMovements({ accounts: [{ merchant_id: 1, balance_cents: 0 }, { merchant_id: 1, balance_cents: 0 }], ledger: [] }, empty), /duplicate/);
  assert.throws(() => auditBalanceMovements({ accounts: [{ merchant_id: 1, balance_cents: Number.MAX_SAFE_INTEGER + 1 }], ledger: [] }, empty), /invalid/);
  const added = auditBalanceMovements(empty, { accounts: [{ merchant_id: 1, balance_cents: 0 }], ledger: [] });
  assert.equal(added.newMerchants, 1);
  assert.equal(added.financiallyReconciled, false);
});
