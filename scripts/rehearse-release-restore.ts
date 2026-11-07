import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLOutputValue } from "node:sqlite";
import { pathToFileURL } from "node:url";

interface TableContents {
  readonly rows: number;
  readonly sha256: string;
}

export type ReleaseContents = Readonly<Record<string, TableContents>>;
const PROCESS_TABLES = new Set(["app_lease", "schema_migrations"]);

function encodeCell(value: SQLOutputValue): readonly string[] {
  if (value === null) return ["null"];
  if (value instanceof Uint8Array) return ["blob", Buffer.from(value).toString("hex")];
  if (typeof value === "number" && Object.is(value, -0)) return ["number", "-0"];
  return [typeof value, String(value)];
}

/** Compare complete records without exposing their values in rehearsal reports. */
export function captureReleaseContents(sql: DatabaseSync, options: { keyMigrationProjection?: boolean } = {}): ReleaseContents {
  if (!sql.isTransaction) throw new Error("release fingerprint requires a consistent read transaction");
  const contents: Record<string, TableContents> = Object.create(null) as Record<string, TableContents>;
  const tables = sql.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all();
  for (const entry of tables) {
    const table = String(entry.name);
    if (PROCESS_TABLES.has(table)) continue;
    const identifier = `"${table.replaceAll('"', '""')}"`;
    const filter = table === "system_metadata" ? " WHERE key IS NULL OR key <> 'last_started_version'" : "";
    const columns = table === "epay_callback_jobs" && options.keyMigrationProjection
      ? new Set(sql.prepare("PRAGMA table_info(epay_callback_jobs)").all().map(column => String(column.name))) : null;
    const defaults = columns && !columns.has("retry_base_attempts") ? ",0 AS retry_base_attempts,0 AS retry_base_gets" : "";
    contents[table] = fingerprintQuery(sql, `SELECT *${defaults} FROM ${identifier}${filter}`);
  }
  if (options.keyMigrationProjection && contents.epay_merchant_secrets && !contents.epay_merchant_key_versions) {
    contents.epay_merchant_key_versions = fingerprintQuery(sql, `SELECT merchant_id,secret_version,cipher_version,nonce,ciphertext,authentication_tag,secret_fingerprint,updated_at AS created_at FROM epay_merchant_secrets`);
    contents.epay_order_key_versions = fingerprintQuery(sql, `SELECT o.trade_no,o.merchant_id,s.secret_version FROM epay_orders o JOIN epay_merchant_secrets s ON s.merchant_id=o.merchant_id
      WHERE EXISTS(SELECT 1 FROM epay_alipay_intents i WHERE i.trade_no=o.trade_no) OR EXISTS(SELECT 1 FROM epay_wechat_intents i WHERE i.trade_no=o.trade_no)`);
  }
  return contents;
}

function fingerprintQuery(sql: DatabaseSync, queryText: string): TableContents {
    const query = sql.prepare(queryText);
    query.setReadBigInts(true);
    const hashes: string[] = [];
    for (const row of query.iterate()) {
      const cells = Object.keys(row).sort().map(column => [column, encodeCell(row[column]!)]);
      hashes.push(createHash("sha256").update(JSON.stringify(cells)).digest("hex"));
    }
    // Sorting retains duplicate rows while ignoring insertion and query-plan order.
    hashes.sort();
    return { rows: hashes.length, sha256: createHash("sha256").update(hashes.join("\n")).digest("hex") };
}

export function compareReleaseContents(before: ReleaseContents, after: ReleaseContents): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter(name => {
    const prior = before[name], current = after[name];
    if (!prior) return current!.rows !== 0;
    return !current || prior.rows !== current.rows || prior.sha256 !== current.sha256;
  }).sort();
}

function captureFile(path: string) {
  const sql = new DatabaseSync(path, { readOnly: true });
  try {
    sql.exec("BEGIN");
    const contents = captureReleaseContents(sql, { keyMigrationProjection: true });
    const schema = Number(sql.prepare("SELECT max(version) version FROM schema_migrations").get()?.version);
    const integrity = sql.prepare("PRAGMA integrity_check").all();
    assert.deepEqual(integrity.map(row => row.integrity_check), ["ok"], "database integrity check failed");
    assert.deepEqual(sql.prepare("PRAGMA foreign_key_check").all(), [], "foreign key check failed");
    return { schema, contents };
  } finally { sql.close(); }
}

function requireSameContents(baseline: ReleaseContents, path: string) {
  const snapshot = captureFile(path);
  const differences = compareReleaseContents(baseline, snapshot.contents);
  if (differences.length) throw new Error(`restored record contents differ in tables: ${differences.join(", ")}`);
  return snapshot;
}

function existingPath(path: string): string {
  if (resolve(path) !== path || realpathSync(path) !== path) throw new Error("rehearsal paths must be absolute and must not use symlinks");
  return path;
}

async function rehearse(args: readonly string[]) {
  const [oldRoot, newRoot, backupPath, backupSha256, keyPath, reportPath] = args;
  if (process.env.EPAY_ISOLATED_TEST !== "1" || args.length !== 6 || !oldRoot || !newRoot || !backupPath || !backupSha256 || !keyPath || !reportPath) {
    throw new Error("usage: EPAY_ISOLATED_TEST=1 node scripts/rehearse-release-restore.ts OLD_APP NEW_APP BACKUP SHA256 MASTER_KEY_FILE NEW_REPORT");
  }
  for (const path of [oldRoot, newRoot, backupPath, keyPath, dirname(reportPath)]) existingPath(path);
  if (resolve(reportPath) !== reportPath || existsSync(reportPath)) throw new Error("report must be a fresh absolute path");
  if (!/^[a-f0-9]{64}$/.test(backupSha256)) throw new Error("invalid expected backup digest");
  const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  assert.equal(digest(backupPath), backupSha256, "backup digest mismatch");
  const encodedKey = readFileSync(keyPath, "utf8").trim();
  if (!/^[a-fA-F0-9]{64}$/.test(encodedKey)) throw new Error("invalid master key file");
  const masterKey = Buffer.from(encodedKey, "hex");
  process.umask(0o077);
  const workspace = mkdtempSync(join(process.platform === "linux" ? "/dev/shm" : tmpdir(), "perpay-release-restore-"));
  type DatabaseModule = typeof import("../src/database/database.ts");
  type MaintenanceModule = typeof import("../src/database/maintenance.ts");
  let database: Awaited<ReturnType<DatabaseModule["AppDatabase"]["open"]>> | undefined;
  try {
    const load = <T>(root: string, file: string): Promise<T> => import(pathToFileURL(join(root, "dist", file)).href) as Promise<T>;
    const oldDatabase = await load<DatabaseModule>(oldRoot, "database/database.js");
    const newDatabase = await load<DatabaseModule>(newRoot, "database/database.js");
    const oldMaintenance = await load<MaintenanceModule>(oldRoot, "database/maintenance.js");
    const newMaintenance = await load<MaintenanceModule>(newRoot, "database/maintenance.js");
    const backups = join(workspace, "backups");
    mkdirSync(backups);
    const backupName = basename(backupPath);
    copyFileSync(backupPath, join(backups, backupName), constants.COPYFILE_EXCL);
    const baseline = captureFile(join(backups, backupName));
    const restore = (name: string, maintenance: MaintenanceModule) => {
      const dataDirectory = join(workspace, name);
      mkdirSync(dataDirectory);
      const restored = maintenance.restoreOperationalBackup({ dataDirectory, backupDirectory: backups, backupName, expectedSha256: backupSha256, confirmReplaceCurrentDatabase: true, masterKey });
      assert.equal(restored.restoredSchemaVersion, baseline.schema);
      const path = join(dataDirectory, "perpay.sqlite3");
      requireSameContents(baseline.contents, path);
      return path;
    };
    const upgradePath = restore("upgrade", newMaintenance);
    database = await newDatabase.AppDatabase.open(upgradePath, { masterKey });
    assert.equal(database.health().ok, true);
    database.close();
    database = undefined;
    const upgraded = requireSameContents(baseline.contents, upgradePath);
    assert.ok(upgraded.schema > baseline.schema, "candidate did not exercise a schema upgrade");
    database = await newDatabase.AppDatabase.open(upgradePath, { masterKey });
    assert.equal(database.health().ok, true);
    database.close();
    database = undefined;
    requireSameContents(baseline.contents, upgradePath);
    // A code-only rollback must fail, rather than silently opening an unknown schema.
    await assert.rejects(async () => {
      database = await oldDatabase.AppDatabase.open(upgradePath, { masterKey });
    }, (error: unknown) => {
      if (!(error instanceof Error)) return false;
      if (error.message === "database schema is newer than this application; refusing startup") return true;
      const unknownMigration = /^database contains unknown or renamed migration (\d+) [a-z0-9_]+$/.exec(error.message);
      return unknownMigration !== null && Number(unknownMigration[1]) > baseline.schema && Number(unknownMigration[1]) <= upgraded.schema;
    });
    requireSameContents(baseline.contents, upgradePath);
    const rollbackPath = restore("rollback", oldMaintenance);
    database = await oldDatabase.AppDatabase.open(rollbackPath, { masterKey });
    assert.equal(database.health().ok, true);
    database.close();
    database = undefined;
    assert.equal(requireSameContents(baseline.contents, rollbackPath).schema, baseline.schema);
    assert.equal(digest(backupPath), backupSha256, "source backup changed during rehearsal");
    const report = {
      completedAt: new Date().toISOString(), isolated: true, backupSha256,
      nodeVersion: process.version, oldApp: oldRoot, newApp: newRoot,
      oldSchema: baseline.schema, newSchema: upgraded.schema,
      comparedTables: Object.keys(baseline.contents).length,
      contents: baseline.contents, upgradedContents: upgraded.contents,
      integrity: "ok", upgradedAndReopened: true, codeOnlyRollbackRejected: true,
      oldReleaseRestored: true, originalMasterKeyVerified: true, sourceBackupUnchanged: true,
      scope: "pre-cutover release recovery; never restore this backup over new financial records",
    };
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600, flush: true });
    console.log(JSON.stringify({ ...report, contents: undefined, upgradedContents: undefined }));
  } finally {
    try { database?.close(); }
    finally {
      masterKey.fill(0);
      rmSync(workspace, { recursive: true });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await rehearse(process.argv.slice(2));
}
