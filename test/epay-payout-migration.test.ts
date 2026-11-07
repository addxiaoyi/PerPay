import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/database/database.ts";
import { migrations, migrationChecksum } from "../src/database/migrations.ts";
import { createLegacySettingsDatabase } from "./legacy-settings-fixture.ts";
import { keyMaster } from "./application-key-fixture.ts";
import { migrateSiteData } from "../src/sites/migrations/data.ts";
import { migrateAlipayAccounts } from "../src/alipay-accounts/migration.ts";
import { captureReleaseContents, compareReleaseContents } from "../scripts/rehearse-release-restore.ts";

it("upgrades schema 66 without rewriting historical payments, settlements or keys and restores the new schema", async () => {
  const directory = mkdtempSync(join(tmpdir(), "starpay-payout-migration-")), path = join(directory, "state.sqlite");
  const old = createLegacySettingsDatabase(path); let current: AppDatabase | undefined;
  try {
    old.owner.write(sql => {
      for (const migration of migrations.filter(row => row.version >= 34 && row.version <= 66)) {
        sql.exec(migration.sql);
        if (migration.postApply === "migrate_websites_v1") migrateSiteData(sql, keyMaster);
        if (migration.postApply === "migrate_alipay_accounts_v1") migrateAlipayAccounts(sql, keyMaster);
        sql.prepare("INSERT INTO schema_migrations VALUES(?,?,?,?)").run(migration.version, migration.name, migrationChecksum(migration), new Date().toISOString());
      }
      sql.exec("INSERT INTO epay_merchant_accounts VALUES(1,'synthetic',0,1,500,0,0)");
    });
    const before = old.owner.write(sql => captureReleaseContents(sql)); old.owner.close();
    current = await AppDatabase.open(path, { masterKey: keyMaster });
    const after = current.write(sql => captureReleaseContents(sql));
    assert.deepEqual(compareReleaseContents(before, after), []);
    for (const table of ["epay_payout_accounts", "epay_payouts", "epay_payout_attempts"]) assert.equal(after[table]?.rows, 0);
    assert.equal(current.integrityCheck().ok, true);
    const backup = join(directory, "backup.sqlite"); await current.backup(backup); current.close(); current = undefined;
    current = await AppDatabase.open(backup, { masterKey: keyMaster });
    assert.deepEqual(compareReleaseContents(after, current.write(sql => captureReleaseContents(sql))), []);
    assert.equal(current.integrityCheck().ok, true);
  } finally { current?.close(); old.owner.close(); rmSync(directory, { recursive: true, force: true }); }
});
