import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const [productionPid, productionRoot, rehearsalRoot] = process.argv.slice(2);
if (!/^\d+$/.test(productionPid ?? "") || !productionRoot?.startsWith("/opt/perpay-") ||
    !/^\/root\/perpay-invoice-rehearsal-20261121-[a-z0-9]+$/.test(rehearsalRoot ?? "")) throw new Error("invalid rehearsal scope");
process.umask(0o077);
const candidateRoot = realpathSync(join(rehearsalRoot, "app"));
assert.equal(realpathSync(process.cwd()), candidateRoot);
const reportPath = join(rehearsalRoot, "report.json");
assert.equal(existsSync(reportPath), false, "rehearsal report already exists");
const productionEnv = Object.fromEntries(readFileSync(`/proc/${productionPid}/environ`, "utf8").split("\0")
  .filter(line => line.includes("=")).map(line => { const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)]; }));
const productionData = resolve(productionEnv.PERPAY_DATA_DIR);
assert.ok(!productionData.startsWith(rehearsalRoot));
const load = (root, path) => import(pathToFileURL(join(root, path)).href);
const { createOperationalBackup, restoreOperationalBackup } = await load(candidateRoot, "src/database/maintenance.ts");
const { AppDatabase, inspectDatabaseIntegrity } = await load(candidateRoot, "src/database/database.ts");
const { loadConfig } = await load(candidateRoot, "src/config.ts");
const { migrations: productionMigrations } = await load(productionRoot, "src/database/migrations.ts");
const productionSchema = Math.max(...productionMigrations.map(migration => migration.version));
const productionVersion = JSON.parse(readFileSync(join(productionRoot, "package.json"), "utf8")).version;
const baselineRoot = join(rehearsalRoot, "backups"), targetData = join(rehearsalRoot, "migration-data");
for (const path of [baselineRoot, targetData, join(rehearsalRoot, "runtime-backups")]) mkdirSync(path, { mode: 0o700 });
const master = Buffer.from(productionEnv.PERPAY_MASTER_KEY || readFileSync(join(productionEnv.PERPAY_SECRETS_DIR, "master-key"), "utf8").trim(), "hex");
assert.equal(master.length, 32);
const stable = value => JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item);
const quote = value => `"${value.replaceAll('"', '""')}"`;

function inspect(path, tableNames) {
  const sql = new DatabaseSync(path, { readOnly: true, readBigInts: true });
  try {
    sql.exec("PRAGMA query_only=ON; BEGIN");
    const tables = tableNames ?? sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .map(row => row.name).filter(name => !["app_lease", "schema_migrations", "system_metadata"].includes(name));
    const fingerprints = {};
    for (const table of tables) {
      const columns = sql.prepare(`PRAGMA table_info(${quote(table)})`).all().map(row => quote(row.name));
      const hash = createHash("sha256");
      let count = 0;
      for (const row of sql.prepare(`SELECT * FROM ${quote(table)} ORDER BY ${columns.join(",")}`).iterate()) {
        hash.update(stable(row)).update("\n"); count++;
      }
      fingerprints[table] = { count, sha256: hash.digest("hex") };
    }
    const integrity = inspectDatabaseIntegrity(sql);
    const fullIntegrity = sql.prepare("PRAGMA integrity_check").all().map(row => String(row.integrity_check));
    assert.deepEqual(fullIntegrity, ["ok"]);
    assert.equal(integrity.ok, true);
    const schema = Number(sql.prepare("SELECT max(version) version FROM schema_migrations").get().version);
    return { tables, fingerprints, schema, integrity, fullIntegrity };
  } finally { sql.close(); }
}

async function boot(root, label, expectedVersion) {
  const env = { ...productionEnv, PERPAY_HOST: "127.0.0.1", PERPAY_PORT: "6198", PERPAY_DATA_DIR: targetData,
    PERPAY_BACKUP_DIR: join(rehearsalRoot, "runtime-backups"), PERPAY_PUBLIC_URL: "https://rehearsal.invalid", PERPAY_BASE_PATH: "/pay",
    PERPAY_TRUSTED_PROXY_CIDRS: "127.0.0.1/32", PERPAY_EPAY_GATEWAY_MODE: "maintenance", PERPAY_EPAY_CALLBACK_DELIVERY: "false",
    PERPAY_EPAY_INVOICE_ENABLED: "false", PERPAY_TAX_INVOICE_ENABLED: "false", PERPAY_TAX_INVOICE_AUTO_SYNC_ENABLED: "false",
    PERPAY_SETUP_TOKEN_ENABLED: "false", PERPAY_EPAY_SHADOW_IDENTITY_ORIGIN: "http://127.0.0.1:8787",
    PERPAY_EPAY_SHADOW_MAIN_ORDERS: "false", PERPAY_EPAY_SHADOW_BALANCE: "false" };
  for (const name of ["PERPAY_EPAY_ALIPAY_CHANNEL_ID", "PERPAY_EPAY_ALIPAY_CERTIFICATE_FILE", "PERPAY_EPAY_MAIN_BRIDGE_SECRET_FILE",
    "PERPAY_EPAY_WECHAT_CREDENTIAL_ID", "PERPAY_EPAY_WECHAT_SIGNING_KEY_ID", "PERPAY_TAX_INVOICE_WECHAT_CREDENTIAL_ID", "PERPAY_TAX_INVOICE_WECHAT_SIGNING_KEY_ID"]) delete env[name];
  const config = loadConfig(env);
  assert.equal(config.taxInvoices, undefined);
  assert.equal(config.epayGateway.callbackDelivery, false);
  config.masterKey.fill(0);
  let log = "", exited = false, summary, stopped;
  const child = spawn(process.execPath, [join(root, "dist/main.js")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  const exit = new Promise(resolveExit => child.once("exit", (code, signal) => { exited = true; resolveExit({ code, signal }); }));
  child.stdout.on("data", bytes => { log += bytes.toString(); });
  child.stderr.on("data", bytes => { log += bytes.toString(); });
  child.once("error", () => { exited = true; });
  try {
    const startedAt = Date.now();
    while (!log.includes('"event":"server_started"')) {
      if (exited || Date.now() - startedAt > 60_000) throw new Error(`${label} did not start`);
      await new Promise(done => setTimeout(done, 250));
    }
    const started = log.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line)).find(row => row.event === "server_started");
    assert.equal(started.version, expectedVersion);
    const health = await fetch("http://127.0.0.1:6198/pay/healthz");
    const healthBody = await health.json();
    assert.equal(health.status, 200);
    const paths = label === "candidate" ? ["applications", "query", "files"] : [];
    const rejected = {};
    for (const path of paths) {
      const response = await fetch(`http://127.0.0.1:6198/pay/epay/tax-invoices/${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      rejected[path] = response.status;
      assert.equal(response.status, 503);
    }
    summary = { version: started.version, healthStatus: health.status, health: healthBody.status ?? "ok", invoiceEnabled: false,
      networkNamespace: readFileSync("/proc/net/dev", "utf8").split("\n").filter(line => line.includes(":" )).map(line => line.split(":")[0].trim()), rejected };
  } finally {
    child.kill("SIGTERM");
    let timeout;
    const stop = await Promise.race([exit, new Promise(done => { timeout = setTimeout(() => done(null), 15_000); })]);
    clearTimeout(timeout);
    if (!stop) { child.kill("SIGKILL"); await exit; throw new Error(`${label} required forced shutdown`); }
    // Store only event names; diagnostics could contain customer identifiers.
    const events = log.split("\n").filter(line => line.startsWith("{")).flatMap(line => { try { const entry = JSON.parse(line); return entry.event ? [entry.event] : []; } catch { return []; } });
    writeFileSync(join(rehearsalRoot, `${label}-events.json`), JSON.stringify({ events, exit: stop }, null, 2), { flag: "wx", mode: 0o600 });
    writeFileSync(join(rehearsalRoot, `${label}-private.log`), log, { flag: "wx", mode: 0o600 });
    assert.equal(stop.code, 0, `${label} must exit cleanly`);
    assert.equal(stop.signal, null, `${label} must not exit from a terminating signal`);
    stopped = stop;
  }
  return { ...summary, exit: stopped };
}

try {
  assert.deepEqual(readFileSync("/proc/net/dev", "utf8").split("\n").filter(line => line.includes(":" )).map(line => line.split(":")[0].trim()), ["lo"]);
  const backup = await createOperationalBackup({ dataDirectory: productionData, backupDirectory: baselineRoot });
  const baseline = inspect(join(baselineRoot, backup.name));
  assert.equal(baseline.schema, productionSchema);
  const restored = restoreOperationalBackup({ dataDirectory: targetData, backupDirectory: baselineRoot, backupName: backup.name,
    expectedSha256: backup.sha256, confirmReplaceCurrentDatabase: true, masterKey: master });
  assert.equal(restored.restoredSchemaVersion, productionSchema);
  const db = await AppDatabase.open(join(targetData, "perpay.sqlite3"), { masterKey: master });
  const queryPlan = db.read(sql => sql.prepare("EXPLAIN QUERY PLAN SELECT invoice_id FROM epay_tax_invoice_requests WHERE status IN ('UNKNOWN','PROCESSING','REVERSING') AND updated_at<=? ORDER BY updated_at,invoice_id LIMIT 1").all(Date.now()));
  db.close();
  const migrated = inspect(join(targetData, "perpay.sqlite3"), baseline.tables);
  assert.equal(migrated.schema, 69);
  assert.deepEqual(migrated.fingerprints, baseline.fingerprints);
  assert.match(stable(queryPlan), /epay_tax_invoice_pending_query/);
  assert.doesNotMatch(stable(queryPlan), /TEMP B-TREE/);
  const candidateBoot = await boot(candidateRoot, "candidate", "1.0.0-rc.13");
  const rejectedInvoiceCount = (() => { const sql = new DatabaseSync(join(targetData, "perpay.sqlite3"), { readOnly: true }); try { return Number(sql.prepare("SELECT count(*) n FROM epay_tax_invoice_requests").get().n); } finally { sql.close(); } })();
  assert.equal(rejectedInvoiceCount, 0);
  const rolledBack = restoreOperationalBackup({ dataDirectory: targetData, backupDirectory: baselineRoot, backupName: backup.name,
    expectedSha256: backup.sha256, confirmReplaceCurrentDatabase: true, masterKey: master });
  assert.equal(rolledBack.restoredSchemaVersion, productionSchema);
  const rollback = inspect(join(targetData, "perpay.sqlite3"), baseline.tables);
  assert.deepEqual(rollback.fingerprints, baseline.fingerprints);
  const oldBoot = await boot(productionRoot, "rollback", productionVersion);
  const report = { completed: true, observedAt: new Date().toISOString(), backup, isolatedRoot: rehearsalRoot, productionRoot,
    sourceSchema: baseline.schema, targetSchema: migrated.schema, migratedIntegrity: migrated.integrity,
    comparedBusinessTables: baseline.tables.length, businessDataUnchanged: true,
    paymentCounts: Object.fromEntries(Object.entries(baseline.fingerprints).filter(([name]) => ["epay_orders", "epay_balance_ledger", "epay_native_refunds", "epay_wechat_confirmations", "epay_alipay_confirmations", "epay_settlements"].includes(name)).map(([name, info]) => [name, info.count])),
    queryPlan, candidateBoot, rollback: { schema: rollback.schema, integrity: rollback.integrity, dataUnchanged: true, previousVersionBoot: oldBoot, quarantined: Boolean(rolledBack.quarantinedDatabaseName) },
    actualInvoicesIssued: 0, productionModified: false, secretsExported: false };
  writeFileSync(reportPath, stable(report), { flag: "wx", mode: 0o600 });
  console.log(stable(report));
} catch (error) {
  const reason = error instanceof Error ? error.message : "unknown failure";
  const safe = reason.replaceAll(productionData, "<production-data>");
  writeFileSync(join(rehearsalRoot, "failure.json"), JSON.stringify({ completed: false, reason: safe, productionModified: false }, null, 2), { flag: "wx", mode: 0o600 });
  console.error(JSON.stringify({ completed: false, reason: safe }));
  process.exitCode = 1;
} finally { master.fill(0); }
