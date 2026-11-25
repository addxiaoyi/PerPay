import { readFileSync, mkdtempSync, rmSync, statfsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createConnection } from "mysql2/promise";
import { AppDatabase } from "../dist/database/database.js";
import { mysqlSnapshotConfig } from "../dist/epay-compat/mysql-snapshot.js";
import { captureEPaySnapshot, SOURCE_TABLES } from "../dist/epay-compat/snapshot.js";
import { readAuthenticatedEPaySnapshot } from "../dist/epay-compat/authenticated-snapshot.js";
import { importEPaySnapshotInTransaction } from "../dist/epay-compat/isolated-import.js";
import { RuntimeSecretCipher } from "../dist/settings/crypto.js";

if (process.env.EPAY_ISOLATED_TEST !== "1" || statfsSync("/dev/shm").type !== 0x01021994) throw new Error("explicit tmpfs rehearsal is required");
const pid = process.env.EPAY_SOURCE_PID;
if (!pid || !/^[1-9]\d*$/.test(pid)) throw new Error("source process ID is required");
const environment = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
const urls = environment.filter(entry => entry.startsWith("DATABASE_URL="));
if (urls.length !== 1) throw new Error("source process database configuration is unavailable");
const sourceUrl = new URL(urls[0].slice("DATABASE_URL=".length));
sourceUrl.search = "";
const directory = mkdtempSync("/dev/shm/perpay-live-rehearsal-");
const key = randomBytes(32);
let connection;
let snapshotDb;
let target;
try {
  connection = await createConnection(mysqlSnapshotConfig(sourceUrl.href));
  await connection.query("SET SESSION time_zone = '+08:00'");
  const [tableRows] = await connection.query("SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()");
  const engines = new Map(tableRows.map(row => [row.TABLE_NAME, row.ENGINE]));
  const tables = Object.keys(SOURCE_TABLES);
  if ([...engines.keys()].some(name => !tables.includes(name)) || tables.some(name => engines.get(name)?.toUpperCase() !== "INNODB")) throw new Error("source tables are incomplete, unhandled or nontransactional");
  snapshotDb = await AppDatabase.open(join(directory, "snapshot.sqlite"), { masterKey: key });
  const options = { source: connection, database: snapshotDb, masterKey: key, instanceId: snapshotDb.instanceId(), sourceName: "live-readonly-rehearsal", requireColumnMetadata: true };
  const captured = await captureEPaySnapshot(options);
  const snapshot = readAuthenticatedEPaySnapshot(options, captured.snapshotId);
  const merchantFeeBps = Object.fromEntries(snapshot.tables.Merchant.map(row => [String(row.id), 0]));
  target = await AppDatabase.open(join(directory, "target.sqlite"), { masterKey: key });
  const targetId = target.instanceId();
  const cipher = new RuntimeSecretCipher(key, targetId);
  const guard = cipher.createGuard();
  target.write(db => db.prepare("INSERT INTO runtime_master_key_guard(singleton_key,cipher_version,nonce,ciphertext,authentication_tag,created_at) VALUES(1,1,?,?,?,0)").run(guard.nonce, guard.ciphertext, guard.authenticationTag));
  const report = target.write(db => importEPaySnapshotInTransaction({ ...options, merchantFeeBps, sourceOffsetMinutes: 480 }, captured.snapshotId, { database: db, instanceId: targetId }));
  if (!target.integrityCheck().ok) throw new Error("imported database integrity check failed");
  target.close();
  target = await AppDatabase.open(join(directory, "target.sqlite"), { masterKey: key });
  if (!target.integrityCheck().ok) throw new Error("reopened database integrity check failed");
  console.log(JSON.stringify({ sourceCounts: captured.counts, identifiersVerified: report.identifiersVerified, reopenedIntegrity: true, assumedFees: true, financiallyReconciled: false, productionReady: false }));
} catch (error) {
  console.error(`rehearsal failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
} finally {
  target?.close();
  snapshotDb?.close();
  await connection?.end();
  key.fill(0);
  rmSync(directory, { recursive: true, force: true });
}
