import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createConnection } from "mysql2/promise";
import { readAuthenticatedEPaySnapshot } from "../src/epay-compat/authenticated-snapshot.ts";
import { auditAuthenticatedMerchantSnapshot } from "../src/epay-compat/authenticated-merchant-audit.ts";
import { assertMappedSourceMetadata, importEPaySnapshotIntoMemory } from "../src/epay-compat/isolated-import.ts";
import { EPAY_COMPATIBILITY_SCHEMA_SQL } from "../src/epay-compat/schema.ts";
import { captureEPaySnapshot, SOURCE_TABLES } from "../src/epay-compat/snapshot.ts";
import { verifyEPaySnapshot } from "../src/epay-compat/verify-snapshot.ts";
import { rehearsePersistentMainOrders } from "./epay-persistent-order-rehearsal.ts";
import { rehearseCombinedImport } from "./epay-combined-import-rehearsal.ts";

const container = process.env.EPAY_AUDIT_CONTAINER;
const mainFile = process.env.EPAY_MAIN_STORE;
if (!container || !/^[a-f0-9]{64}$/.test(container) || !mainFile || process.env.EPAY_ISOLATED_TEST !== "1") throw new Error("isolated container and main store are required");
const inspected = JSON.parse(execFileSync("docker", ["inspect", container], { encoding: "utf8", maxBuffer: 1_048_576 }));
const instance = inspected[0];
if (inspected.length !== 1 || instance?.Config?.Labels?.["starmc.epay.audit"] !== "isolated-v1" || instance?.HostConfig?.NetworkMode !== "none" || !instance?.HostConfig?.Tmpfs?.["/var/lib/mysql"] || instance?.State?.Running !== true || !Number.isSafeInteger(instance?.State?.Pid) || instance.State.Pid < 1) throw new Error("source is not the designated isolated restore");

const before = statSync(mainFile);
const main = JSON.parse(readFileSync(mainFile, "utf8"));
const after = statSync(mainFile);
if ((["dev", "ino", "size", "mtimeMs", "ctimeMs"] as const).some((key) => before[key] !== after[key])) throw new Error("main-site store changed while reading");
if (!main || typeof main !== "object" || !main.payment) throw new Error("main-site payment data is missing");

const socket = process.env.EPAY_AUDIT_SOCKET ?? "/var/run/mysqld/mysqld.sock";
if (socket !== "/var/run/mysqld/mysqld.sock" && socket !== "/run/mysql/mysql.sock") throw new Error("invalid isolated MySQL socket path");
const connection = await createConnection({ socketPath: `/proc/${instance.State.Pid}/root${socket}`, user: "epay_audit", database: "epay_starmc", dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false, multipleStatements: false, connectTimeout: 10000 });
const sqlite = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
sqlite.exec(EPAY_COMPATIBILITY_SCHEMA_SQL);
const database = {
  read: <T>(operation: (db: DatabaseSync) => T): T => operation(sqlite),
  write: <T>(operation: (db: DatabaseSync) => T): T => {
    sqlite.exec("BEGIN IMMEDIATE");
    try { const result = operation(sqlite); sqlite.exec("COMMIT"); return result; }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  },
};
const key = randomBytes(32);
try {
  try { await connection.query("CREATE TABLE audit_permission_probe (id INT)"); throw new Error("isolated audit account unexpectedly has write permission"); }
  catch (error) { if (!(error instanceof Error) || !/denied/i.test(error.message)) throw error; }
  await connection.query("SET SESSION time_zone = '+08:00'");
  const [tables] = await connection.query("SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()");
  if (!Array.isArray(tables)) throw new Error("cannot inspect source tables");
  const engines = new Map((tables as Array<{ TABLE_NAME: string; ENGINE: string | null }>).map((row) => [row.TABLE_NAME, row.ENGINE]));
  const expected = Object.keys(SOURCE_TABLES);
  if ([...engines.keys()].some((name) => !expected.includes(name)) || expected.some((name) => engines.get(name)?.toUpperCase() !== "INNODB")) throw new Error("source contains unhandled or nontransactional tables");
  const checkColumns = async () => {
    const [columns] = await connection.query("SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()");
    assertMappedSourceMetadata(columns);
  };
  await checkColumns();
  const options = { source: connection, database, masterKey: key, instanceId: randomUUID(), sourceName: "isolated-historical-restore", requireColumnMetadata: true };
  const snapshot = await captureEPaySnapshot(options);
  const verified = await verifyEPaySnapshot(options, snapshot.snapshotId);
  await checkColumns();
  if (JSON.stringify(snapshot.counts) !== JSON.stringify(verified)) throw new Error("snapshot counts differ from source");
  const rows = readAuthenticatedEPaySnapshot(options, snapshot.snapshotId);
  if (!rows.columns) throw new Error("snapshot has no authenticated column metadata");
  assertMappedSourceMetadata(Object.entries(rows.columns).flatMap(([TABLE_NAME, names]) => names.map((COLUMN_NAME) => ({ TABLE_NAME, COLUMN_NAME }))));
  const merchantAudit = auditAuthenticatedMerchantSnapshot(main.payment, rows.tables);
  const merchantFeeBps = Object.fromEntries(rows.tables.Merchant.map((merchant) => [String(merchant.id), 0]));
  const report = importEPaySnapshotIntoMemory({ ...options, merchantFeeBps, sourceOffsetMinutes: 480, mainPayment: main.payment }, snapshot.snapshotId);
  const persistent = await rehearsePersistentMainOrders(main.payment, rows.tables.Merchant, rows.tables.MerchantBinding);
  if (persistent.count !== report.mainOrderCount || persistent.ledgerCount !== report.mainLedgerCount) throw new Error("persistent and memory order or ledger counts differ");
  const combined = await rehearseCombinedImport({ ...options, merchantFeeBps, sourceOffsetMinutes: 480 }, snapshot.snapshotId, main.payment);
  if (combined.mainOrders !== report.mainOrderCount || combined.mainLedger !== report.mainLedgerCount) throw new Error("combined and memory order or ledger counts differ");
  console.log(JSON.stringify({ counts: snapshot.counts, merchantAudit, mainLedgerCount: report.mainLedgerCount, mainOrderCount: report.mainOrderCount, mainPaymentsVerified: report.mainPaymentsVerified, persistentOrdersReopened: persistent.reopenedVerified, wrongKeyRejected: persistent.rejectedWrongKey, combined, identifiersVerified: report.identifiersVerified, sourceFileModifiedAt: after.mtime.toISOString(), assumedFees: true, assumedTimezone: true, coordinatedSnapshot: false, financiallyReconciled: report.financiallyReconciled, productionReady: report.productionReady }));
} finally {
  key.fill(0);
  await connection.end();
  sqlite.close();
}
