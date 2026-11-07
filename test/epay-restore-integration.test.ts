import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createConnection } from "mysql2/promise";

import { AppDatabase } from "../src/database/database.ts";
import { mysqlSnapshotConfig, snapshotIsolatedMysql } from "../src/epay-compat/mysql-snapshot.ts";
import { requireIsolatedMysql } from "./epay-isolation-guard.ts";

it("captures and verifies every restored row using a read-only account", { skip: !process.env.EPAY_RESTORE_MYSQL_URL }, async () => {
  const url = process.env.EPAY_RESTORE_MYSQL_URL!;
  requireIsolatedMysql(url, "epay_restore", process.env.EPAY_ISOLATED_TEST);
  const key = randomBytes(32);
  const dir = mkdtempSync(join(tmpdir(), "epay-restore-"));
  const db = await AppDatabase.open(join(dir, "snapshot.sqlite"), { masterKey: key });
  const source = await createConnection(mysqlSnapshotConfig(url));
  try {
    await assert.rejects(source.query("CREATE TABLE restore_permission_probe (id INT)"), /denied/i);
    const snapshot = await snapshotIsolatedMysql({ mysqlUrl: url, database: db, masterKey: key, instanceId: db.instanceId(), sourceName: "isolated-backup" });
    assert.deepEqual(snapshot.verified, snapshot.counts);
    assert.equal(Object.keys(snapshot.verified).length, 11);
    console.log(`Verified row counts: ${JSON.stringify(snapshot.verified)}`);
  } finally {
    await source.end();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
