import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { createConnection } from "mysql2/promise";
import { AppDatabase } from "../src/database/database.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { readAuthenticatedEPaySnapshot } from "../src/epay-compat/authenticated-snapshot.ts";
import { planBalanceOpenings, installBalanceOpenings } from "../src/epay-compat/balance-opening.ts";
import { verifyCandidateArchive } from "../src/epay-compat/candidate-import.ts";
import { readMainPaymentArchive } from "../src/epay-compat/main-payment-archive.ts";
import { initializeLegacyCursor } from "../src/epay-compat/legacy-delta.ts";
import { applySharedPaymentDelta } from "../src/epay-compat/shared-delta.ts";
import { projectLegacyLiabilities } from "../src/epay-compat/legacy-projection.ts";
import { readMainMemorySnapshot } from "../src/epay-compat/main-snapshot-client.ts";
import { readLiveBalance, safeCents } from "../src/epay-compat/live-balance.ts";
import { auditMainLedger } from "../src/epay-compat/main-ledger-audit.ts";
import { mysqlSnapshotConfig } from "../src/epay-compat/mysql-snapshot.ts";
import { captureSharedCutoff } from "../src/epay-compat/shared-cutoff.ts";
import { canonicalSource, compareMigrationRows } from "../src/epay-compat/source-drift.ts";
import { SOURCE_TABLES } from "../src/epay-compat/snapshot.ts";

const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
let phase = "arguments";

async function rehearse() {
  process.umask(0o077);
  const [sourceRoot, targetRoot] = process.argv.slice(2);
  if (process.env.EPAY_ISOLATED_TEST !== "1" || !sourceRoot || !targetRoot || sourceRoot === targetRoot || [sourceRoot, targetRoot].some(path => !/^\/var\/lib\/perpay-candidate-[a-z0-9-]+$/.test(path) || resolve(path) !== path) || existsSync(targetRoot)) throw new Error("fresh isolated rehearsal paths required");
  const sourcePath = join(sourceRoot, "data/perpay.sqlite3"), snapshotPath = join(sourceRoot, "snapshot/snapshot.sqlite3");
  const before = hash(readFileSync(sourcePath)), snapshotHash = hash(readFileSync(snapshotPath));
  const key = Buffer.from(readFileSync(join(sourceRoot, "secrets/master-key"), "utf8").trim(), "hex");
  const secretFile = "/etc/helstera/perpay-migration.secret";
  if ((statSync(secretFile).mode & 0o077) !== 0 || key.length !== 32) throw new Error("invalid rehearsal secrets");
  const secret = Buffer.from(readFileSync(secretFile, "utf8").trim(), "hex");
  if (secret.length !== 32) throw new Error("invalid snapshot authentication key");
  const legacy = new DatabaseSync(sourcePath, { readOnly: true }), snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
  let candidate: AppDatabase | undefined, mysql: Awaited<ReturnType<typeof createConnection>> | undefined;
  try {
    phase = "copy_isolated_database";
    mkdirSync(targetRoot, { mode: 0o700 });
    for (const path of ["data", "secrets"]) mkdirSync(join(targetRoot, path), { mode: 0o700 });
    copyFileSync(join(sourceRoot, "secrets/master-key"), join(targetRoot, "secrets/master-key"));
    await backup(legacy, join(targetRoot, "data/perpay.sqlite3"));
    candidate = await AppDatabase.open(join(targetRoot, "data/perpay.sqlite3"), { masterKey: key });
    const cipher = new RuntimeSecretCipher(key, candidate.instanceId());
    const raw = candidate.read(sql => readMainPaymentArchive(sql, cipher));
    if (!raw) throw new Error("main archive is missing");
    const archive = JSON.parse(raw);
    verifyCandidateArchive(candidate, key, archive);
    const marker = candidate.read(sql => JSON.parse(String(sql.prepare("SELECT value FROM system_metadata WHERE key='epay_candidate_import'").get()?.value)));
    const proof = candidate.read(sql => JSON.parse(String(sql.prepare("SELECT value FROM system_metadata WHERE key='epay_shared_cutoff'").get()?.value)));
    if (!marker.sharedCutoff || !proof.sharedCutoff || marker.cutoff !== proof.cutoff || marker.snapshotId !== proof.snapshotId) throw new Error("shared cutoff metadata differs");
    const baseline = readAuthenticatedEPaySnapshot({ database: { read: fn => fn(snapshot), write: () => { throw new Error("snapshot is immutable"); } }, masterKey: key, instanceId: String(snapshot.prepare("SELECT value FROM system_metadata WHERE key='instance_id'").get()?.value), sourceName: "epay-shared-cutoff", requireColumnMetadata: true }, marker.snapshotId);
    phase = "install_isolated_openings";
    const proofHash = createHash("sha256").update(canonicalSource(proof)).digest("hex");
    const plan = candidate.write(sql => planBalanceOpenings(sql, cipher, proofHash));
    const opened = candidate.write(sql => installBalanceOpenings(sql, cipher, plan, Date.parse(proof.cutoff)));
    if (!baseline.columns) throw new Error("legacy source schema is missing");
    candidate.write(sql => initializeLegacyCursor(sql, cipher, { tables: baseline.tables, columns: baseline.columns!, capturedAt: Date.parse(proof.cutoff), sourceOffsetMinutes: 0 }));
    const paymentsBefore = candidate.read(sql => Number(sql.prepare("SELECT count(*) n FROM epay_callback_jobs").get()?.n));
    const processes = JSON.parse(execFileSync("pm2", ["jlist"], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 15000 }));
    const matches = processes.filter((row: { name?: string; pm2_env?: { status?: string; pm_cwd?: string } }) => row.name === "epay-next-reconcile-v1" && row.pm2_env?.status === "online" && row.pm2_env.pm_cwd?.startsWith("/www/wwwroot/epay-next-releases/"));
    if (matches.length !== 1) throw new Error("legacy source process is ambiguous");
    phase = "read_current_shared_cutoff";
    mysql = await createConnection(mysqlSnapshotConfig(matches[0].pm2_env.DATABASE_URL));
    await mysql.query("SET SESSION TRANSACTION READ ONLY");
    const allowed = new Set([
      "SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()",
      "SET SESSION time_zone = '+00:00'", "SET SESSION lock_wait_timeout = 3", "SET SESSION innodb_lock_wait_timeout = 3", "SET autocommit = 0", "UNLOCK TABLES",
      `LOCK TABLES ${Object.keys(SOURCE_TABLES).map(name => `\`${name}\` READ`).join(", ")}`,
      ...Object.entries(SOURCE_TABLES).map(([name, primary]) => `SELECT * FROM \`${name}\` ORDER BY \`${primary}\``),
    ]);
    const current = await captureSharedCutoff({ query: sql => {
      if (!mysql || !allowed.has(sql)) throw new Error("rehearsal SQL is outside the capture protocol");
      return mysql.query({ sql, timeout: 5000 });
    } }, () => readMainMemorySnapshot({ origin: "http://127.0.0.1:8787", secret }));
    const differences = Object.fromEntries(Object.entries(SOURCE_TABLES).map(([name, primary]) => {
      const table = name as keyof typeof SOURCE_TABLES;
      if (canonicalSource(baseline.columns![table]) !== canonicalSource(current.columns[table])) throw new Error("legacy source columns changed");
      const comparison = compareMigrationRows(baseline.tables[table], current.tables[table], primary);
      return [name, { added: comparison.added.length, removed: comparison.removed.length, changed: comparison.changed.length }];
    }));
    const legacyUnchanged = Object.values(differences).every(row => !row.added && !row.removed && !row.changed);
    phase = "apply_isolated_main_delta";
    const applied = applySharedPaymentDelta(candidate, cipher, current, Date.now());
    const duplicate = applySharedPaymentDelta(candidate, cipher, current, Date.now());
    if (!duplicate.duplicate) throw new Error("delta replay was not idempotent");
    const beforeBalances = auditMainLedger(archive).balances;
    const afterBalances = auditMainLedger(current.mainPayment).balances;
    const beforeLegacy = projectLegacyLiabilities(baseline.tables, archive, 0);
    const afterLegacy = projectLegacyLiabilities(current.tables, current.mainPayment, 0);
    const balancesVerified = candidate.read(sql => plan.merchants.every(merchant => {
      const balance = readLiveBalance(sql, merchant.merchantId);
      const before = beforeBalances.find(row => row.merchantId === merchant.mainMerchantId);
      const after = afterBalances.find(row => row.merchantId === merchant.mainMerchantId);
      if (!before || !after) throw new Error("balance comparison merchant is missing");
      const legacyBefore = beforeLegacy.find(row => row.mainMerchantId === merchant.mainMerchantId);
      const legacyAfter = afterLegacy.find(row => row.mainMerchantId === merchant.mainMerchantId);
      if (!legacyBefore || !legacyAfter) throw new Error("legacy balance comparison merchant is missing");
      const available = safeCents(BigInt(merchant.availableCents) + BigInt(after.availableCents) - BigInt(before.availableCents)
        + BigInt(legacyAfter.project(merchant.merchantId)) - BigInt(legacyBefore.project(merchant.merchantId)));
      const frozen = safeCents(BigInt(merchant.frozenCents) + BigInt(after.frozenCents) - BigInt(before.frozenCents));
      return balance.availableCents === available && balance.frozenCents === frozen;
    }));
    if (!balancesVerified) throw new Error("isolated live balances differ from openings");
    if (candidate.read(sql => Number(sql.prepare("SELECT count(*) n FROM epay_callback_jobs").get()?.n)) !== paymentsBefore) throw new Error("legacy callbacks were replayed");
    const report = { version: 1, isolated: true, sharedCutoff: current.cutoff, sourceReadOnly: true, sourceUnchanged: hash(readFileSync(sourcePath)) === before && hash(readFileSync(snapshotPath)) === snapshotHash,
      legacyUnchanged, legacyDifferences: differences, merchantsOpened: opened.merchantsOpened, openingPlanSha256: opened.planSha256, liveBalancesVerified: balancesVerified,
      sharedDelta: applied, duplicateReplaySafe: duplicate.duplicate, callbackJobsUnchanged: true, providerRequests: 0, productionCutover: false, completedAt: new Date().toISOString() };
    if (!report.sourceUnchanged || !candidate.integrityCheck().ok) throw new Error("source or isolated candidate integrity changed");
    writeFileSync(join(targetRoot, "rehearsal-report.json"), JSON.stringify(report), { flag: "wx", mode: 0o600, flush: true });
    console.log(JSON.stringify(report));
  } finally { candidate?.close(); legacy.close(); snapshot.close(); await mysql?.end(); key.fill(0); secret.fill(0); }
}

rehearse().catch(() => { console.error(JSON.stringify({ error: "shared_candidate_rehearsal_failed", phase, productionRoutingChanged: false })); process.exitCode = 1; });
