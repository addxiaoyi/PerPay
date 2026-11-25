import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createConnection } from "mysql2/promise";
import { readAuthenticatedEPaySnapshot } from "../src/epay-compat/authenticated-snapshot.ts";
import { readMainPaymentArchive } from "../src/epay-compat/main-payment-archive.ts";
import { mysqlSnapshotConfig } from "../src/epay-compat/mysql-snapshot.ts";
import { SOURCE_TABLES } from "../src/epay-compat/snapshot.ts";
import { canonicalSource, compareMigrationRows } from "../src/epay-compat/source-drift.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";

let phase = "arguments";

async function audit() {
  process.umask(0o077);
  const [directory, reportFile] = process.argv.slice(2);
  if (!directory || !reportFile || !/^\/var\/lib\/perpay-candidate-[0-9a-z-]+$/.test(directory) || resolve(directory) !== directory || !reportFile.startsWith("/root/perpay-recovery-")) throw new Error("invalid private audit paths");
  const key = Buffer.from(readFileSync(join(directory, "secrets/master-key"), "utf8").trim(), "hex");
  if (key.length !== 32) throw new Error("candidate key is invalid");
  const candidate = new DatabaseSync(join(directory, "data/perpay.sqlite3"), { readOnly: true });
  const snapshot = new DatabaseSync(join(directory, "snapshot/snapshot.sqlite3"), { readOnly: true });
  let source: Awaited<ReturnType<typeof createConnection>> | undefined;
  try {
    candidate.exec("BEGIN"); snapshot.exec("BEGIN");
    const id = (db: DatabaseSync) => String(db.prepare("SELECT value FROM system_metadata WHERE key='instance_id'").get()?.value ?? "");
    const marker = JSON.parse(String(candidate.prepare("SELECT value FROM system_metadata WHERE key='epay_candidate_import'").get()?.value ?? "null"));
    if (!marker?.snapshotId || !id(candidate) || !id(snapshot)) throw new Error("candidate import metadata is missing");
    phase = "authenticated_snapshot";
    const baseline = readAuthenticatedEPaySnapshot({ database: { read: fn => fn(snapshot), write: () => { throw new Error("audit cannot write snapshot"); } }, masterKey: key, instanceId: id(snapshot), sourceName: "epay-live-candidate", requireColumnMetadata: true }, marker.snapshotId);
    const raw = readMainPaymentArchive(candidate, new RuntimeSecretCipher(key, id(candidate)));
    if (!raw) throw new Error("candidate main archive is missing");
    const mainBefore = JSON.parse(raw) as Record<string, unknown>;
    phase = "connect_readonly_source";
    const processes = JSON.parse(execFileSync("pm2", ["jlist"], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 15000 }));
    const matches = processes.filter((p: { name?: string; pm2_env?: { status?: string; pm_cwd?: string } }) => p.name === "epay-next-reconcile-v1" && p.pm2_env?.status === "online" && p.pm2_env.pm_cwd?.startsWith("/www/wwwroot/epay-next-releases/"));
    if (matches.length !== 1) throw new Error("legacy source process is ambiguous");
    source = await createConnection(mysqlSnapshotConfig(matches[0].pm2_env.DATABASE_URL));
    await source.query("SET SESSION time_zone = '+00:00'");
    await source.query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await source.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
    phase = "compare_sources";
    const sourceTables = Object.entries(SOURCE_TABLES);
    const [schema] = await source.query("SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()");
    const engines = new Map((schema as Array<{ TABLE_NAME: string; ENGINE: string }>).map(row => [row.TABLE_NAME, row.ENGINE]));
    if (engines.size !== sourceTables.length || sourceTables.some(([name]) => engines.get(name)?.toUpperCase() !== "INNODB")) throw new Error("source schema or engine changed");
    const epay: Record<string, ReturnType<typeof compareMigrationRows>> = {};
    for (const [name, primaryKey] of sourceTables) {
      phase = `compare_epay_${name}`;
      const [rows, fields] = await source.query(`SELECT * FROM \`${name}\` ORDER BY \`${primaryKey}\``);
      const columns = fields.map(field => field.name).sort();
      if (canonicalSource(columns) !== canonicalSource([...baseline.columns![name as keyof typeof SOURCE_TABLES]].sort())) throw new Error("source columns changed");
      epay[name] = compareMigrationRows(baseline.tables[name as keyof typeof SOURCE_TABLES], JSON.parse(JSON.stringify(rows)), primaryKey);
    }
    const mainFile = "/www/wwwroot/starmc-api/data/store.json";
    phase = "read_main_source";
    const beforeStat = statSync(mainFile), live = JSON.parse(readFileSync(mainFile, "utf8")).payment as Record<string, unknown>, afterStat = statSync(mainFile);
    if (beforeStat.ino !== afterStat.ino || beforeStat.size !== afterStat.size || beforeStat.mtimeMs !== afterStat.mtimeMs) throw new Error("main source changed while read");
    await source.query("COMMIT");
    const main: Record<string, unknown> = {};
    for (const name of new Set([...Object.keys(mainBefore), ...Object.keys(live)])) {
      phase = `compare_main_${name}`;
      const left = mainBefore[name], right = live[name];
      if (Array.isArray(left) && Array.isArray(right)) main[name] = compareMigrationRows(left, right, "id");
      else main[name] = { same: Object.hasOwn(mainBefore, name) && Object.hasOwn(live, name) && canonicalSource(left) === canonicalSource(right), baselinePresent: Object.hasOwn(mainBefore, name), currentPresent: Object.hasOwn(live, name) };
    }
    const report = { capturedAt: new Date().toISOString(), snapshotId: marker.snapshotId, sourceReadOnly: true, sharedCutoff: false, mainStableRead: true, mainMtime: new Date(afterStat.mtimeMs).toISOString(), epay, main };
    writeFileSync(reportFile, JSON.stringify(report), { mode: 0o600, flag: "wx", flush: true });
    const summarize = (records: Record<string, unknown>) => Object.fromEntries(Object.entries(records).map(([name, entry]) => {
      const item = entry as ReturnType<typeof compareMigrationRows>;
      return [name, Array.isArray(item.changed) ? { baseline: item.baselineCount, current: item.currentCount, added: item.added.length, removed: item.removed.length, changed: item.changed.length, changedColumns: [...new Set(item.changed.flatMap(row => row.columns))].sort() } : entry];
    }));
    console.log(JSON.stringify({ reportFile, reportSha256: createHash("sha256").update(JSON.stringify(report)).digest("hex"), sourceReadOnly: true, sharedCutoff: false, epay: summarize(epay), main: summarize(main) }));
    candidate.exec("COMMIT"); snapshot.exec("COMMIT");
  } finally {
    await source?.end(); candidate.close(); snapshot.close(); key.fill(0);
  }
}

audit().catch(() => { console.error(JSON.stringify({ error: "source_drift_audit_failed", phase, productionDataChanged: false })); process.exitCode = 1; });
