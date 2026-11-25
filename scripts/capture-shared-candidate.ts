import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createConnection } from "mysql2/promise";

import { AppDatabase } from "../src/database/database.ts";
import { planBalanceOpenings } from "../src/epay-compat/balance-opening.ts";
import { importCandidate, verifyCandidateArchive } from "../src/epay-compat/candidate-import.ts";
import { writeLiveStateArchive } from "../src/epay-compat/live-state-archive.ts";
import { sealLiveState, validateLiveStateRecipient } from "../src/epay-compat/live-state-envelope.ts";
import { readMainMemorySnapshot } from "../src/epay-compat/main-snapshot-client.ts";
import { EPAY_MYSQL_OFFSET_MINUTES, mysqlSnapshotConfig } from "../src/epay-compat/mysql-snapshot.ts";
import { captureSharedCutoff, capturedSnapshotSource } from "../src/epay-compat/shared-cutoff.ts";
import { canonicalSource } from "../src/epay-compat/source-drift.ts";
import { captureEPaySnapshot, SOURCE_TABLES } from "../src/epay-compat/snapshot.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";

const digest = (value: unknown) => createHash("sha256").update(canonicalSource(value)).digest("hex");
const RESTRICTED_SOURCE_FILE = "/etc/helstera/perpay-snapshot.json";
let phase = "arguments";

async function capture() {
  process.umask(0o077);
  const [directory, recipientPath, fingerprint] = process.argv.slice(2);
  if (process.env.EPAY_SHARED_CAPTURE !== "1" || !directory || !/^\/var\/lib\/perpay-candidate-[0-9a-z-]+$/.test(directory) || resolve(directory) !== directory || existsSync(directory) || !recipientPath?.startsWith("/root/perpay-recovery-") || !fingerprint) throw new Error("explicit fresh capture paths are required");
  const recipient = readFileSync(recipientPath, "utf8");
  validateLiveStateRecipient(recipient, randomBytes(16).toString("hex"), fingerprint);
  const secretPath = "/etc/helstera/perpay-migration.secret";
  const secretStat = statSync(secretPath);
  if (!secretStat.isFile() || (secretStat.mode & 0o077) !== 0) throw new Error("snapshot secret permissions differ");
  const secretText = readFileSync(secretPath, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(secretText)) throw new Error("snapshot secret is invalid");
  const secret = Buffer.from(secretText, "hex"), key = randomBytes(32);
  const restrictedAccount = existsSync(RESTRICTED_SOURCE_FILE);
  const processes = JSON.parse(execFileSync("pm2", ["jlist"], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 15000 })) as Array<{ name?: string; pm2_env?: { status?: string; pm_cwd?: string; DATABASE_URL?: string } }>;
  const matches = processes.filter(row => row.name === "epay-next-reconcile-v1" && row.pm2_env?.status === "online" && row.pm2_env.pm_cwd?.startsWith("/www/wwwroot/epay-next-releases/"));
  if (matches.length !== 1 || !matches[0]?.pm2_env?.DATABASE_URL) throw new Error("source process is ambiguous");
  const config = restrictedAccount ? JSON.parse(readFileSync(RESTRICTED_SOURCE_FILE, "utf8")) as ReturnType<typeof mysqlSnapshotConfig> : mysqlSnapshotConfig(matches[0].pm2_env.DATABASE_URL);
  phase = "source_connect";
  const source = await createConnection(config);
  let snapshot: AppDatabase | undefined, candidate: AppDatabase | undefined;
  try {
    await source.query("SET SESSION TRANSACTION READ ONLY");
    const [readOnly] = await source.query("SELECT @@session.tx_read_only read_only");
    if (Number((readOnly as Array<{ read_only: number }>)[0]?.read_only) !== 1) throw new Error("source session is not read only");
    const allowed = new Set([
      "SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()",
      "SET SESSION time_zone = '+00:00'", "SET SESSION lock_wait_timeout = 3", "SET SESSION innodb_lock_wait_timeout = 3",
      "SET autocommit = 0", "UNLOCK TABLES", `LOCK TABLES ${Object.keys(SOURCE_TABLES).map(name => `\`${name}\` READ`).join(", ")}`,
      ...Object.entries(SOURCE_TABLES).map(([name, primary]) => `SELECT * FROM \`${name}\` ORDER BY \`${primary}\``),
    ]);
    phase = "shared_capture";
    const cutoff = await captureSharedCutoff({ query: async sql => {
      if (!allowed.has(sql)) throw new Error("source query is outside the read-only capture protocol");
      return source.query({ sql, timeout: 5000 });
    } }, () => readMainMemorySnapshot({ origin: "http://127.0.0.1:8787", secret }));
    // The live sources have been unlocked before any encryption, import or report I/O.
    phase = "isolated_import";
    mkdirSync(directory, { mode: 0o700 });
    for (const name of ["secrets", "data", "snapshot", "backups"]) mkdirSync(join(directory, name), { mode: 0o700 });
    writeFileSync(join(directory, "secrets/master-key"), key.toString("hex") + "\n", { flag: "wx", mode: 0o600, flush: true });
    writeLiveStateArchive(join(directory, "master-key-recovery.json"), sealLiveState(key, recipient, randomBytes(16).toString("hex"), fingerprint));
    const cutoffBody = Buffer.from(JSON.stringify(cutoff));
    try {
      const captureId = randomBytes(16).toString("hex");
      const encrypted = writeLiveStateArchive(join(directory, "shared-cutoff-encrypted.json"), sealLiveState(cutoffBody, recipient, captureId, fingerprint));
      writeFileSync(join(directory, "shared-cutoff-encrypted.json.manifest.json"), JSON.stringify({ version: 1, snapshotId: captureId, archiveSha256: encrypted.sha256, archiveBytes: encrypted.bytes, sourceSha256: createHash("sha256").update(cutoffBody).digest("hex"), sourceBytes: cutoffBody.length }), { flag: "wx", mode: 0o600, flush: true });
    } finally { cutoffBody.fill(0); }
    snapshot = await AppDatabase.open(join(directory, "snapshot/snapshot.sqlite3"), { masterKey: key });
    const options = { source: capturedSnapshotSource(cutoff), database: snapshot, masterKey: key, instanceId: snapshot.instanceId(), sourceName: "epay-shared-cutoff", requireColumnMetadata: true, sourceOffsetMinutes: EPAY_MYSQL_OFFSET_MINUTES };
    const captured = await captureEPaySnapshot(options);
    candidate = await AppDatabase.open(join(directory, "data/perpay.sqlite3"), { masterKey: key });
    const imported = importCandidate(candidate, options, captured.snapshotId, cutoff.mainPayment);
    const proof = { version: 1, snapshotId: captured.snapshotId, sharedCutoff: true, cutoff: cutoff.cutoff, lockMilliseconds: cutoff.lockCompletedAt - cutoff.lockedAt, sourceSha256: cutoff.sourceSha256, mainResponseSha256: cutoff.mainResponseSha256, mainPaymentSha256: digest(cutoff.mainPayment), sourceCounts: captured.counts, sourceSessionReadOnly: true, restrictedAccount, sourceProtocolReadOnly: true, productionCutover: false };
    const cipher = new RuntimeSecretCipher(key, candidate.instanceId());
    const openings = candidate.write(sql => planBalanceOpenings(sql, cipher, digest(proof)));
    candidate.write(sql => {
      const marker = JSON.parse(String(sql.prepare("SELECT value FROM system_metadata WHERE key='epay_candidate_import'").get()?.value));
      sql.prepare("UPDATE system_metadata SET value=?,updated_at=? WHERE key='epay_candidate_import'")
        .run(JSON.stringify({ ...marker, sharedCutoff: true, cutoff: cutoff.cutoff, sourceSha256: cutoff.sourceSha256 }), Date.now());
      sql.prepare("INSERT INTO system_metadata(key,value,updated_at) VALUES('epay_shared_cutoff',?,?)").run(JSON.stringify(proof), Date.now());
    });
    candidate.close(); candidate = undefined;
    candidate = await AppDatabase.open(join(directory, "data/perpay.sqlite3"), { masterKey: key });
    const verified = verifyCandidateArchive(candidate, key, cutoff.mainPayment);
    if (!candidate.integrityCheck().ok) throw new Error("shared candidate integrity failed");
    phase = "candidate_backup";
    const backupPath = join(directory, "backups/candidate.sqlite3");
    await candidate.backup(backupPath);
    const backupBody = readFileSync(backupPath);
    try {
      const backupId = randomBytes(16).toString("hex");
      const backup = writeLiveStateArchive(join(directory, "candidate-encrypted.json"), sealLiveState(backupBody, recipient, backupId, fingerprint));
      writeFileSync(join(directory, "candidate-encrypted.json.manifest.json"), JSON.stringify({ version: 1, snapshotId: backupId, archiveSha256: backup.sha256, archiveBytes: backup.bytes, sourceSha256: createHash("sha256").update(backupBody).digest("hex"), sourceBytes: backupBody.length }), { flag: "wx", mode: 0o600, flush: true });
    } finally { backupBody.fill(0); }
    const report = { ...proof, imported, verified, openingPlan: openings, balancesInstalled: false, createdAt: new Date().toISOString() };
    writeFileSync(join(directory, "shared-import-report.json"), JSON.stringify(report), { flag: "wx", mode: 0o600, flush: true });
    console.log(JSON.stringify({ ...proof, archiveVerified: verified.archiveVerified, merchantsReconciled: openings.merchants.length, quarantinedMerchants: imported.candidate.quarantinedMerchants, balancesInstalled: false }));
  } finally {
    candidate?.close(); snapshot?.close(); await source.end(); key.fill(0); secret.fill(0);
  }
}

capture().catch(() => { console.error(JSON.stringify({ error: "shared_candidate_capture_failed", phase, productionRoutingChanged: false })); process.exitCode = 1; });
