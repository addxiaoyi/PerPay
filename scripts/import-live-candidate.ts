import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createConnection } from "mysql2/promise";
import { loadConfig } from "../src/config.ts";
import { AppDatabase } from "../src/database/database.ts";
import { EPAY_MYSQL_OFFSET_MINUTES, mysqlSnapshotConfig } from "../src/epay-compat/mysql-snapshot.ts";
import { captureEPaySnapshot, SOURCE_TABLES } from "../src/epay-compat/snapshot.ts";
import { importCandidate, verifyCandidateArchive } from "../src/epay-compat/candidate-import.ts";
import { sealLiveState } from "../src/epay-compat/live-state-envelope.ts";
import { writeLiveStateArchive } from "../src/epay-compat/live-state-archive.ts";

let phase = "prepare";
async function run() {
  process.umask(0o077);
  const [directory, recipientFile, fingerprint] = process.argv.slice(2);
  if (!directory || !recipientFile || !fingerprint || !/^\/var\/lib\/perpay-candidate-[0-9a-z-]+$/.test(directory) || resolve(directory) !== directory || existsSync(directory)) throw new Error("new candidate directory and recovery recipient required");
  const recipient = readFileSync(recipientFile, "utf8");
  const key = randomBytes(32);
  const envelope = sealLiveState(key, recipient, randomBytes(16).toString("hex"), fingerprint);
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(join(directory, "secrets"), { mode: 0o700 });
  writeFileSync(join(directory, "secrets/master-key"), key.toString("hex") + "\n", { mode: 0o600, flag: "wx", flush: true });
  writeLiveStateArchive(join(directory, "master-key-recovery.json"), envelope);
  const config = loadConfig({ PERPAY_HOST: "127.0.0.1", PERPAY_PORT: "16191", PERPAY_DATA_DIR: join(directory,"data"), PERPAY_BACKUP_DIR: join(directory,"backups"), PERPAY_SECRETS_DIR: join(directory,"secrets"), PERPAY_PUBLIC_URL: "http://127.0.0.1:16191" });
  const processes = JSON.parse(execFileSync("pm2", ["jlist"], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 15000 }));
  const matches = processes.filter((p: { name?: string; pm2_env?: { status?: string; pm_cwd?: string } }) => p.name === "epay-next-reconcile-v1" && p.pm2_env?.status === "online" && p.pm2_env.pm_cwd?.startsWith("/www/wwwroot/epay-next-releases/"));
  if (matches.length !== 1) throw new Error("candidate legacy process is ambiguous");
  phase = "source_connect";
  const source = await createConnection(mysqlSnapshotConfig(matches[0].pm2_env.DATABASE_URL));
  let snapshotDb: AppDatabase | undefined;
  let target: AppDatabase | undefined;
  try {
    await source.query("SET SESSION TRANSACTION READ ONLY");
    const [mode] = await source.query("SELECT @@session.tx_read_only AS read_only");
    if (Number((mode as Array<{read_only: number}>)[0]?.read_only) !== 1) throw new Error("candidate source is not read only");
    await source.query("SET SESSION time_zone = '+00:00'");
    const [tables] = await source.query("SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()");
    const engines = new Map((tables as Array<{TABLE_NAME:string;ENGINE:string}>).map(row=>[row.TABLE_NAME,row.ENGINE]));
    const expected = Object.keys(SOURCE_TABLES);
    if ([...engines.keys()].some(name=>!expected.includes(name)) || expected.some(name=>engines.get(name)?.toUpperCase() !== "INNODB")) throw new Error("candidate source schema differs");
    const payment = JSON.parse(readFileSync("/www/wwwroot/starmc-api/data/store.json", "utf8")).payment;
    const paymentDigest = createHash("sha256").update(JSON.stringify(payment)).digest("hex");
    snapshotDb = await AppDatabase.open(join(directory,"snapshot/snapshot.sqlite3"), { masterKey: key });
    const options = { source, database: snapshotDb, masterKey: key, instanceId: snapshotDb.instanceId(), sourceName: "epay-live-candidate", requireColumnMetadata: true, sourceOffsetMinutes: EPAY_MYSQL_OFFSET_MINUTES };
    phase = "snapshot";
    const capture = await captureEPaySnapshot(options);
    phase = "import";
    target = await AppDatabase.open(config.databasePath, { masterKey: key });
    const report = importCandidate(target, options, capture.snapshotId, payment);
    target.close();
    target = undefined;
    target = await AppDatabase.open(config.databasePath, { masterKey: key });
    phase = "reopen_verify";
    const verification = verifyCandidateArchive(target, key, payment);
    const current = JSON.parse(readFileSync("/www/wwwroot/starmc-api/data/store.json", "utf8")).payment;
    const paymentUnchanged = createHash("sha256").update(JSON.stringify(current)).digest("hex") === paymentDigest;
    if (!paymentUnchanged) throw new Error("candidate main payment changed during capture");
    const summary = { createdAt: new Date().toISOString(), instanceId: target.instanceId(), sourceCounts: capture.counts, paymentDigest, paymentUnchanged, report, verification };
    writeFileSync(join(directory,"import-report.json"), JSON.stringify(summary), { mode: 0o600, flag: "wx", flush: true });
    console.log(JSON.stringify(summary));
  } finally {
    target?.close();
    snapshotDb?.close();
    await source.end();
    key.fill(0);
    config.masterKey.fill(0);
  }
}

run().catch(() => {
  // Driver errors may include connection credentials. Failed candidates stay private for inspection.
  console.error(JSON.stringify({ error: "candidate_import_failed", phase, productionRoutingChanged: false }));
  process.exitCode = 1;
});
