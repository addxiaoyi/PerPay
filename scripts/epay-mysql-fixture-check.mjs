import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createConnection } from "mysql2/promise";
import { snapshotIsolatedMysql, mysqlSnapshotConfig } from "../dist/epay-compat/mysql-snapshot.js";
import { EPAY_COMPATIBILITY_SCHEMA_SQL } from "../dist/epay-compat/schema.js";
import { RuntimeSecretCipher } from "../dist/settings/crypto.js";

if (process.env.EPAY_ISOLATED_TEST !== "1" || !process.env.EPAY_TEST_MYSQL_URL) throw new Error("explicit isolated test configuration required");
const source = await createConnection(mysqlSnapshotConfig(process.env.EPAY_TEST_MYSQL_URL));
const sqlite = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true, readBigInts: true });
sqlite.exec(EPAY_COMPATIBILITY_SCHEMA_SQL);
const database = {
  read: (operation) => operation(sqlite),
  write: (operation) => {
    sqlite.exec("BEGIN IMMEDIATE");
    try { const value = operation(sqlite); sqlite.exec("COMMIT"); return value; }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  },
};
try {
  await source.query("SET SESSION time_zone = '+08:00'");
  await assert.rejects(source.query("INSERT INTO `Config` (`key`, `value`) VALUES ('permission-probe', 'test')"), /denied/i);
  const masterKey = randomBytes(32), instanceId = randomUUID();
  const snapshot = await snapshotIsolatedMysql({ mysqlUrl: process.env.EPAY_TEST_MYSQL_URL, database, masterKey, instanceId, sourceName: "fixture" });
  const cipher = new RuntimeSecretCipher(masterKey, instanceId);
  assert.deepEqual(snapshot.verified, snapshot.counts);
  assert.equal(Object.keys(snapshot.counts).length, 11);
  for (const [table, count] of Object.entries(snapshot.counts)) {
    assert.equal(count, 1);
    const [rows] = await source.query(`SELECT * FROM \`${table}\``);
    const stored = sqlite.prepare("SELECT * FROM epay_snapshot_rows WHERE snapshot_id=? AND source_table=? AND row_index=0").get(snapshot.snapshotId, table);
    const plain = cipher.decrypt(`epay:snapshot:${snapshot.snapshotId}:${table}:0`, 1, { cipherVersion: 1, nonce: Buffer.from(stored.nonce), ciphertext: Buffer.from(stored.ciphertext), authenticationTag: Buffer.from(stored.authentication_tag) });
    try { assert.deepEqual(JSON.parse(plain.toString()), rows[0]); }
    finally { plain.fill(0); }
  }
  console.log(JSON.stringify({ tables: 11, rowsPerTable: 1, readOnly: true, encryptedSnapshotVerified: true, productionDataUsed: false }));
} finally { await source.end(); sqlite.close(); }
