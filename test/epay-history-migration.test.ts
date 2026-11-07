import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { migrationChecksum, migrations } from "../src/database/migrations.ts";
import { migrateSiteData } from "../src/sites/migrations/data.ts";
import { migrateAlipayAccounts } from "../src/alipay-accounts/migration.ts";
import { createLegacySettingsDatabase } from "./legacy-settings-fixture.ts";
import { keyMaster } from "./application-key-fixture.ts";

it("upgrades schema 50 without changing merchant balances or orders", async () => {
  const directory = mkdtempSync(join(tmpdir(), "perpay-history-upgrade-"));
  const path = join(directory, "state.sqlite3");
  const legacy = createLegacySettingsDatabase(path);
  let current: AppDatabase | undefined;
  try {
    legacy.owner.write(db => {
      for (const migration of migrations.filter(item => item.version >= 34 && item.version <= 50)) {
        db.exec(migration.sql);
        if (migration.postApply === "migrate_websites_v1") migrateSiteData(db, keyMaster);
        if (migration.postApply === "migrate_alipay_accounts_v1") migrateAlipayAccounts(db, keyMaster);
        db.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?, ?)").run(migration.version, migration.name, migrationChecksum(migration), new Date().toISOString());
      }
      db.prepare("INSERT INTO epay_merchant_accounts VALUES (?, ?, ?, ?, ?, ?, ?)").run(101, "merchant", 93795, 1, 500, 1, 1);
      db.prepare(`INSERT INTO epay_orders
        (trade_no, out_trade_no, merchant_id, name, money_cents, notify_url, status, notify_status, notify_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run("trade-1", "merchant-order-1", 101, "order", 1200, "https://example.test/notify", "PAID", "SUCCESS", 1, 1, 2);
      db.prepare(`INSERT INTO epay_balance_ledger
        (entry_id, merchant_id, entry_type, available_delta_cents, frozen_delta_cents, occurred_at, source)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run("entry-1", 101, "payment_paid", 1140, 0, 2, "perpay_epay");
      db.prepare(`INSERT INTO epay_callback_jobs
        (trade_no, merchant_id, status, attempts, next_attempt_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run("trade-1", 101, "SUCCEEDED", 1, 2, 2, 3);
      db.prepare(`INSERT INTO epay_callback_attempts
        (attempt_id, trade_no, attempt_number, started_at, finished_at, outcome, http_status)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run("attempt-1", "trade-1", 1, 2, 3, "SUCCESS", 200);
    });
    const merchant = legacy.connection.prepare("SELECT * FROM epay_merchant_accounts").all();
    const orders = legacy.connection.prepare("SELECT * FROM epay_orders").all();
    const ledger = legacy.connection.prepare("SELECT * FROM epay_balance_ledger").all();
    const jobColumns = "trade_no,merchant_id,status,attempts,next_attempt_at,lease_token,lease_until,created_at,updated_at,next_method";
    const jobs = legacy.connection.prepare(`SELECT ${jobColumns} FROM epay_callback_jobs`).all();
    const attemptColumns = "attempt_id,trade_no,attempt_number,started_at,finished_at,outcome,http_status,error_code,method";
    const attempts = legacy.connection.prepare(`SELECT ${attemptColumns} FROM epay_callback_attempts`).all();
    const priorMigrations = legacy.connection.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    legacy.owner.close();

    for (let attempt = 0; attempt < 2; attempt++) {
      current = await AppDatabase.open(path, { masterKey: keyMaster });
      assert.deepEqual(current.read(db => db.prepare("SELECT * FROM epay_merchant_accounts").all()), merchant);
      assert.deepEqual(current.read(db => db.prepare("SELECT * FROM epay_orders").all()), orders);
      assert.deepEqual(current.read(db => db.prepare("SELECT * FROM epay_balance_ledger").all()), ledger);
      assert.deepEqual(current.read(db => db.prepare(`SELECT ${jobColumns} FROM epay_callback_jobs`).all()), jobs);
      assert.deepEqual(current.read(db => db.prepare("SELECT retry_base_attempts,retry_base_gets FROM epay_callback_jobs").all()).map(row => [row.retry_base_attempts, row.retry_base_gets]), [[0n, 0n]]);
      assert.deepEqual(current.read(db => db.prepare(`SELECT ${attemptColumns} FROM epay_callback_attempts`).all()), attempts);
      assert.equal(current.read(db => db.prepare("SELECT wire_format FROM epay_callback_attempts WHERE attempt_id = ?").get("attempt-1")!.wire_format), null);
      assert.deepEqual(current.read(db => db.prepare("SELECT * FROM schema_migrations WHERE version <= 50 ORDER BY version").all()), priorMigrations);
      for (const table of ["epay_main_order_sources", "epay_main_order_import_runs", "epay_main_ledger_sources", "epay_main_ledger_import_runs", "epay_main_refund_sources", "epay_main_refund_import_runs"]) {
        assert.equal(current.read(db => db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count), 0n, table);
      }
      assert.equal(current.integrityCheck().ok, true);
      current.close();
      current = undefined;
    }
  } finally {
    current?.close();
    legacy.owner.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
