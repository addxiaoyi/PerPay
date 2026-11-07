import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { captureReleaseContents, compareReleaseContents } from "./rehearse-release-restore.ts";

const [previous, candidate, source, checkpoint] = process.argv.slice(2);
if (!previous || !candidate || !source || !checkpoint || process.argv.length !== 6) {
  throw new Error("usage: checkpoint-candidate-release.ts OLD_APP NEW_APP DATA_ROOT CHECKPOINT");
}
process.umask(0o077);
type Maintenance = typeof import("../src/database/maintenance.ts");
type Database = typeof import("../src/database/database.ts");
const load = <T>(root: string, file: string): Promise<T> => import(pathToFileURL(join(root, "dist", file)).href) as Promise<T>;
const maintenance = await load<Maintenance>(previous, "database/maintenance.js");
const keyText = readFileSync(join(checkpoint, "secrets", "master-key"), "utf8").trim();
if (!/^[a-fA-F0-9]{64}$/.test(keyText)) throw new Error("checkpoint master key is invalid");
const masterKey = Buffer.from(keyText, "hex");
function contents(path: string) {
  const sql = new DatabaseSync(path, { readOnly: true });
  try {
    sql.exec("BEGIN");
    assert.deepEqual(sql.prepare("PRAGMA integrity_check").all().map(row => row.integrity_check), ["ok"]);
    assert.deepEqual(sql.prepare("PRAGMA foreign_key_check").all(), []);
    return captureReleaseContents(sql);
  } finally { sql.close(); }
}
try {
  const original = join(source, "data", "perpay.sqlite3");
  const baseline = contents(original);
  const backupDirectory = join(checkpoint, "backups");
  mkdirSync(backupDirectory, { mode: 0o700 });
  const backup = await maintenance.createOperationalBackup({ dataDirectory: join(source, "data"), backupDirectory });
  assert.deepEqual(compareReleaseContents(baseline, contents(join(backupDirectory, backup.name))), []);
  for (const [name, root] of [["previous", previous], ["candidate", candidate]] as const) {
    const dataDirectory = join(checkpoint, `restore-${name}`);
    mkdirSync(dataDirectory, { mode: 0o700 });
    const restore = await load<Maintenance>(root, "database/maintenance.js");
    restore.restoreOperationalBackup({ dataDirectory, backupDirectory, backupName: backup.name,
      expectedSha256: backup.sha256, masterKey, confirmReplaceCurrentDatabase: true });
    const { AppDatabase } = await load<Database>(root, "database/database.js");
    const database = await AppDatabase.open(join(dataDirectory, "perpay.sqlite3"), { masterKey });
    try { assert.equal(database.integrityCheck().ok, true); } finally { database.close(); }
    assert.deepEqual(compareReleaseContents(baseline, contents(join(dataDirectory, "perpay.sqlite3"))), []);
  }
  assert.deepEqual(compareReleaseContents(baseline, contents(original)), []);
  const report = { backup, source, previous, candidate, comparedTables: Object.keys(baseline).length,
    oldReleaseRestored: true, candidateRestored: true, sourceUnchanged: true, completedAt: new Date().toISOString() };
  writeFileSync(join(checkpoint, "restore.json"), JSON.stringify(report), { flag: "wx", mode: 0o600, flush: true });
  console.log(JSON.stringify(report));
} finally { masterKey.fill(0); }
