import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "mysql2/promise";
import { AppDatabase } from "../src/database/database.ts";
import { mysqlSnapshotConfig } from "../src/epay-compat/mysql-snapshot.ts";
import { captureSharedCutoff, capturedSnapshotSource } from "../src/epay-compat/shared-cutoff.ts";
import { captureEPaySnapshot, SOURCE_TABLES } from "../src/epay-compat/snapshot.ts";
import { readAuthenticatedEPaySnapshot } from "../src/epay-compat/authenticated-snapshot.ts";

if (process.env.EPAY_ISOLATED_TEST !== "1" || readFileSync("/proc/net/route", "utf8").trim().split("\n").length !== 1) throw new Error("network-isolated fixture is required");
const reportPath = process.argv[2];
if (!reportPath?.startsWith("/root/perpay-recovery-20261105/")) throw new Error("private rehearsal report path is required");
const control = await createConnection(mysqlSnapshotConfig("mysql://root@127.0.0.1:3306/mysql"));
const directory = mkdtempSync("/dev/shm/perpay-cutoff-mysql-");
const key = randomBytes(32);
let reader: Awaited<ReturnType<typeof createConnection>> | undefined;
let writer: Awaited<ReturnType<typeof createConnection>> | undefined;
let db: AppDatabase | undefined;
try {
  await control.query("CREATE DATABASE epay_fixture");
  await control.query("USE epay_fixture");
  for (const [name, primary] of Object.entries(SOURCE_TABLES)) {
    await control.query(`CREATE TABLE \`${name}\` (\`${primary}\` VARCHAR(64) PRIMARY KEY,value VARCHAR(128) NOT NULL) ENGINE=InnoDB`);
    await control.query(`INSERT INTO \`${name}\` VALUES ('fixture','before')`);
  }
  await control.query("CREATE USER 'cutoff_reader'@'127.0.0.1' IDENTIFIED BY 'isolated-read-lock'");
  await control.query("GRANT SELECT,LOCK TABLES ON epay_fixture.* TO 'cutoff_reader'@'127.0.0.1'");
  reader = await createConnection(mysqlSnapshotConfig("mysql://cutoff_reader:isolated-read-lock@127.0.0.1:3306/epay_fixture"));
  writer = await createConnection(mysqlSnapshotConfig("mysql://root@127.0.0.1:3306/epay_fixture"));
  await assert.rejects(reader.query("INSERT INTO Config VALUES ('forbidden','forbidden')"), /denied/i);
  let completed = false;
  let pendingWrite: Promise<unknown> | undefined;
  const capture = await captureSharedCutoff({ query: sql => reader!.query({ sql, timeout: 5000 }) }, async () => {
    pendingWrite = writer!.query("UPDATE Merchant SET value='after' WHERE id='fixture'").then(() => { completed = true; });
    // This wait tests a competing fixture writer; it never targets the production database.
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(completed, false, "a concurrent writer escaped the read locks");
    return { payment: { merchants: [], orders: [] }, capturedAt: new Date().toISOString(), responseSha256: "a".repeat(64) };
  });
  await pendingWrite;
  assert.equal(completed, true);
  assert.equal(capture.tables.Merchant[0]?.value, "before");
  const [updated] = await control.query("SELECT value FROM Merchant WHERE id='fixture'");
  assert.equal((updated as Array<{ value: string }>)[0]?.value, "after");
  db = await AppDatabase.open(directory + "/snapshot.sqlite3", { masterKey: key });
  const options = { source: capturedSnapshotSource(capture), database: db, masterKey: key, instanceId: db.instanceId(), sourceName: "shared-cutoff-fixture", requireColumnMetadata: true };
  const encrypted = await captureEPaySnapshot(options);
  const restored = readAuthenticatedEPaySnapshot(options, encrypted.snapshotId);
  assert.deepEqual(restored.tables, capture.tables);
  await assert.rejects(captureSharedCutoff(reader, async () => { throw new Error("isolated capture failure"); }), /isolated capture failure/);
  await writer.query({ sql: "UPDATE Merchant SET value='unlocked' WHERE id='fixture'", timeout: 2000 });
  const report = { isolated: true, networkIsolated: true, mysqlVersion: String((await control.query("SELECT VERSION() version"))[0][0].version),
    sharedCutoffVerified: true, selectOnlyWithReadLocks: true, concurrentWriterBlocked: true, failureReleasedLocks: true,
    encryptedSnapshotRoundTrip: true, tables: Object.keys(encrypted.counts).length, sourceUsed: "synthetic_fixture", productionCutover: false };
  writeFileSync(reportPath, JSON.stringify(report), { flag: "wx", mode: 0o600, flush: true });
  console.log(JSON.stringify(report));
} finally {
  db?.close(); key.fill(0);
  await reader?.end(); await writer?.end(); await control.end();
  rmSync(directory, { recursive: true, force: true });
}
