import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createConnection } from "mysql2/promise";
import { readAuthenticatedEPaySnapshot } from "../../src/epay-compat/authenticated-snapshot.ts";
import { mysqlSnapshotConfig, snapshotIsolatedMysql } from "../../src/epay-compat/mysql-snapshot.ts";
import { EPAY_COMPATIBILITY_SCHEMA_SQL } from "../../src/epay-compat/schema.ts";
import { SOURCE_TABLES } from "../../src/epay-compat/snapshot.ts";

if (process.env.EPAY_ISOLATED_TEST !== "1" || !process.env.EPAY_TEST_MYSQL_URL) throw new Error("isolated MySQL fixture is required");
const mysqlUrl = process.env.EPAY_TEST_MYSQL_URL;
const source = await createConnection(mysqlSnapshotConfig(mysqlUrl));
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(EPAY_COMPATIBILITY_SCHEMA_SQL);
const database = {
  read: operation => operation(sqlite),
  write: operation => {
    sqlite.exec("BEGIN IMMEDIATE");
    try { const value = operation(sqlite); sqlite.exec("COMMIT"); return value; }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  },
};
try {
  await assert.rejects(source.query("INSERT INTO `Config` (`key`, `value`) VALUES ('probe', 'probe')"), /denied/i);
  const options = { mysqlUrl, database, masterKey: randomBytes(32), instanceId: randomUUID(), sourceName: "fixture" };
  const captured = await snapshotIsolatedMysql(options);
  const snapshot = readAuthenticatedEPaySnapshot({ ...options, requireColumnMetadata: true }, captured.snapshotId);
  assert.deepEqual(captured.verified, captured.counts);
  assert.equal(snapshot.counts.NotifyLog, 0);
  for (const [table, primaryKey] of Object.entries(SOURCE_TABLES)) {
    assert.ok(snapshot.columns?.[table]?.includes(primaryKey), `missing authenticated columns: ${table}`);
  }
  assert.ok(snapshot.columns.NotifyLog.includes("status"));
  console.log(JSON.stringify({ tables: Object.keys(SOURCE_TABLES).length, emptyTableColumnsVerified: true, readOnlyAccount: true, syntheticData: true }));
} finally {
  await source.end();
  sqlite.close();
}
