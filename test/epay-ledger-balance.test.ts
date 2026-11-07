import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { projectMerchantLedgerBalance } from "../src/epay-compat/ledger-balance.ts";
import { importMainLedgerInTransaction } from "../src/epay-compat/isolated-import.ts";
import { writeEncryptedMainLedgerSource } from "../src/epay-compat/main-ledger-source.ts";
import { preserveMainPaymentArchive } from "../src/epay-compat/main-payment-archive.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { RuntimeSettingsStore } from "../src/settings/store.ts";

it("projects retained main ledger entries and fails closed on incomplete or unexpected data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-ledger-projection-"));
  const key = randomBytes(32);
  const db = await AppDatabase.open(join(dir, "db.sqlite"), { masterKey: key });
  const cipher = new RuntimeSecretCipher(key, db.instanceId());
  try {
    new RuntimeSettingsStore(db, key).initialize();
    db.write(sql => {
      sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'a',900,1,0,0),(2,'b',0,1,0,0);
        INSERT INTO epay_merchant_bindings VALUES ('b','api','main',1,0,0),('b2','api2','missing',2,0,0);
        INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,frozen_delta_cents,occurred_at,source) VALUES ('entry',1,'payment_paid',100,25,1000,'main_site');
        INSERT INTO epay_main_ledger_import_runs(singleton_key,entry_count) VALUES(1,1)`);
      assert.throws(() => projectMerchantLedgerBalance(sql, cipher, 1), /archive is unavailable/);
      const entry = { id: "entry", merchantId: "main", type: "payment_paid", availableDelta: 100, frozenDelta: 25, at: "1970-01-01T00:00:01.000Z" };
      sql.exec("SAVEPOINT incomplete_settlements");
      preserveMainPaymentArchive(sql, cipher, { merchants: [{ id: "main", apiId: "api", feeRate: 0.05 }], ledger: [entry], refunds: [] });
      assert.throws(() => projectMerchantLedgerBalance(sql, cipher, 1), /settlement archive is inconsistent/);
      sql.exec("ROLLBACK TO incomplete_settlements; RELEASE incomplete_settlements");
      sql.exec("SAVEPOINT inconsistent_settlement");
      preserveMainPaymentArchive(sql, cipher, { merchants: [{ id: "main", apiId: "api", feeRate: 0.05 }], ledger: [entry], refunds: [], settlements: [{ id: "missing-freeze", merchantId: "main", amountCents: 10, status: "pending" }] });
      assert.throws(() => projectMerchantLedgerBalance(sql, cipher, 1), /settlement archive is inconsistent/);
      sql.exec("ROLLBACK TO inconsistent_settlement; RELEASE inconsistent_settlement");
      preserveMainPaymentArchive(sql, cipher, { merchants: [{ id: "main", apiId: "api", feeRate: 0.05 }], ledger: [entry], refunds: [], settlements: [] });
      assert.throws(() => projectMerchantLedgerBalance(sql, cipher, 1), /baseline is incomplete/);
      writeEncryptedMainLedgerSource(sql, cipher, "entry", JSON.stringify(entry));
      assert.deepEqual(projectMerchantLedgerBalance(sql, cipher, 1), { availableCents: 100, frozenCents: 25, scope: "shadow_ledger_projection", financiallyReconciled: false });
      for (const change of ["available_delta_cents=101", "frozen_delta_cents=26", "entry_type='manual_adjustment'", "occurred_at=1001", "reason='changed'", "actor_id='changed'"]) {
        sql.exec("SAVEPOINT mapped_entry");
        sql.exec(`UPDATE epay_balance_ledger SET ${change} WHERE entry_id='entry'`);
        assert.throws(() => projectMerchantLedgerBalance(sql, cipher, 1), /main ledger source values mismatch/);
        sql.exec("ROLLBACK TO mapped_entry; RELEASE mapped_entry");
      }
      sql.exec("SAVEPOINT changed_source");
      const changed = cipher.encrypt("epay:ledger-source:1:entry", 1, JSON.stringify({ ...entry, extra: "unexpected" }));
      sql.prepare("UPDATE epay_main_ledger_sources SET nonce=?,ciphertext=?,authentication_tag=? WHERE entry_id='entry'").run(changed.nonce, changed.ciphertext, changed.authenticationTag);
      assert.throws(() => projectMerchantLedgerBalance(sql, cipher, 1), /does not match archive/);
      sql.exec("ROLLBACK TO changed_source; RELEASE changed_source");
      assert.throws(() => projectMerchantLedgerBalance(sql, new RuntimeSecretCipher(randomBytes(32), db.instanceId()), 1));
      assert.throws(() => projectMerchantLedgerBalance(sql, cipher, 2), /absent from main ledger archive/);
      assert.throws(() => projectMerchantLedgerBalance(sql, cipher, 3), /binding/);
      sql.exec("INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,occurred_at,source) VALUES ('unknown',1,'adjustment',1,1000,'legacy_epay')");
      assert.throws(() => projectMerchantLedgerBalance(sql, cipher, 1), /unrecognized ledger source/);
    });
    assert.throws(() => db.read(sql => projectMerchantLedgerBalance(sql, cipher, 1)), /requires a transaction/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("projects imported refunds and settlement freezes without treating the result as reconciled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-ledger-movements-"));
  const key = randomBytes(32);
  const db = await AppDatabase.open(join(dir, "db.sqlite"), { masterKey: key });
  const cipher = new RuntimeSecretCipher(key, db.instanceId());
  const base = { merchantId: "main", at: "2024-01-02T03:04:05.000Z", frozenDelta: 0 };
  const payment = {
    merchants: [{ id: "main", apiId: "api", feeRate: 0.05 }],
    orders: [{ id: "order", merchantId: "main", amountCents: 1000 }],
    refunds: [{ id: "refund", merchantId: "main", orderId: "order", amountCents: 100, status: "recorded" }],
    settlements: [{ id: "settlement", merchantId: "main", amountCents: 200, status: "pending" }],
    ledger: [
      { ...base, id: "credit", type: "payment_paid", availableDelta: 1000 },
      { ...base, id: "freeze", type: "settlement_freeze", settlementId: "settlement", availableDelta: -200, frozenDelta: 200 },
      { ...base, id: "refund-entry", type: "manual_refund", refundId: "refund", availableDelta: -100 },
    ],
    balanceSummaryVersion: 1,
    balanceSummaries: { main: { availableCents: 700, frozenCents: 200 } },
  };
  try {
    new RuntimeSettingsStore(db, key).initialize();
    db.write(sql => {
      sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'a',0,1,0,0);
        INSERT INTO epay_merchant_bindings VALUES ('binding','api','main',1,0,0)`);
      preserveMainPaymentArchive(sql, cipher, payment);
      assert.deepEqual(importMainLedgerInTransaction(sql, cipher, payment), { count: 3, summaryVerified: true });
      assert.deepEqual(projectMerchantLedgerBalance(sql, cipher, 1), { availableCents: 700, frozenCents: 200, scope: "shadow_ledger_projection", financiallyReconciled: false });
    });
  } finally {
    db.close();
    key.fill(0);
    rmSync(dir, { recursive: true, force: true });
  }
});
