import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { snapshotIsolatedMysql } from "../../dist/epay-compat/mysql-snapshot.js";
import { EPAY_COMPATIBILITY_SCHEMA_SQL } from "../../dist/epay-compat/schema.js";
import { readAuthenticatedEPaySnapshot } from "../../dist/epay-compat/authenticated-snapshot.js";
import { importEPaySnapshotIntoMemory } from "../../dist/epay-compat/isolated-import.js";

const mysqlUrl = process.env.EPAY_RESTORE_MYSQL_URL;
if (!mysqlUrl || process.env.EPAY_ISOLATED_TEST !== "1") throw new Error("explicit isolated test configuration is required");
const sqlite = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true, readBigInts: true });
sqlite.exec(EPAY_COMPATIBILITY_SCHEMA_SQL);
const database = {
  read: (operation) => operation(sqlite),
  write: (operation) => {
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      const value = operation(sqlite);
      sqlite.exec("COMMIT");
      return value;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  },
};
try {
  const options = { mysqlUrl, database, masterKey: randomBytes(32), instanceId: randomUUID(), sourceName: "isolated-test" };
  const snapshot = await snapshotIsolatedMysql(options);
  assert.deepEqual(snapshot.verified, snapshot.counts);
  assert.equal(Object.keys(snapshot.counts).length, 11);
  const manifest = sqlite.prepare("SELECT count(*) AS count FROM epay_snapshot_rows WHERE snapshot_id = ? AND source_table = ?").get(snapshot.snapshotId, "__manifest__");
  assert.equal(manifest.count, 1n);
  const rows = readAuthenticatedEPaySnapshot(options, snapshot.snapshotId);
  const merchantFeeBps = Object.fromEntries(rows.tables.Merchant.map((merchant) => [String(merchant.id), 0]));
  const rehearsal = importEPaySnapshotIntoMemory({ ...options, merchantFeeBps, sourceOffsetMinutes: 480 }, snapshot.snapshotId);
  assert.equal(rehearsal.identifiersVerified, true);
  console.log(JSON.stringify({ tables: Object.keys(snapshot.counts).length, counts: snapshot.counts, verified: true, authenticatedManifest: true, structuralRehearsal: true, assumedFees: true, assumedTimezone: true, financiallyReconciled: false }));
} finally {
  sqlite.close();
}
