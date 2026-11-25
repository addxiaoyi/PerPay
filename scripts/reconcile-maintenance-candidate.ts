import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createConnection } from "mysql2/promise";
import { AppDatabase } from "../src/database/database.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { importCandidate, verifyCandidateArchive } from "../src/epay-compat/candidate-import.ts";
import { captureSharedCutoff, capturedSnapshotSource } from "../src/epay-compat/shared-cutoff.ts";
import { SOURCE_TABLES, captureEPaySnapshot } from "../src/epay-compat/snapshot.ts";
import { EPAY_MYSQL_OFFSET_MINUTES, mysqlSnapshotConfig } from "../src/epay-compat/mysql-snapshot.ts";
import { readMainMemorySnapshot } from "../src/epay-compat/main-snapshot-client.ts";
import { readCurrentMainPayment } from "../src/epay-compat/main-delta-store.ts";
import { readLegacyCursor } from "../src/epay-compat/legacy-delta.ts";
import { projectLegacyLiabilities } from "../src/epay-compat/legacy-projection.ts";
import { auditMainLedger } from "../src/epay-compat/main-ledger-audit.ts";
import { auditConfirmedPayments } from "../src/epay-compat/confirmation-audit.ts";
import { readLiveBalance } from "../src/epay-compat/live-balance.ts";
import { readMerchantSecret } from "../src/epay-compat/merchant-secret.ts";
import { canonicalSource } from "../src/epay-compat/source-drift.ts";
import { captureReleaseContents, compareReleaseContents } from "./rehearse-release-restore.ts";

const TABLES = ["epay_merchant_accounts", "epay_merchant_bindings", "epay_orders", "epay_notify_logs", "epay_invoices", "epay_invoice_applications", "epay_balance_ledger", "epay_pay_types", "epay_config_values"] as const;
const digest = (value: unknown) => createHash("sha256").update(canonicalSource(value)).digest("hex");
let phase = "arguments";

async function reconcile() {
  const [root, reportPath] = process.argv.slice(2);
  if (process.env.EPAY_READONLY_AUDIT !== "1" || !root || !reportPath || process.argv.length !== 4 || !/^\/var\/lib\/perpay-candidate-\d{8}[a-z]$/.test(root) || resolve(root) !== root || realpathSync(root) !== root || !reportPath.startsWith("/root/perpay-recovery-") || resolve(reportPath) !== reportPath || existsSync(reportPath)) throw new Error("fresh private report and explicit candidate root required");
  process.umask(0o077);
  const scratch = mkdtempSync("/dev/shm/perpay-reconcile-");
  const key = Buffer.from(readFileSync(join(root, "secrets/master-key"), "utf8").trim(), "hex");
  const snapshotSecret = Buffer.from(readFileSync("/etc/helstera/perpay-migration.secret", "utf8").trim(), "hex");
  const isolatedKey = randomBytes(32);
  assert.equal(key.length, 32); assert.equal(snapshotSecret.length, 32);
  const active = new DatabaseSync(join(root, "data/perpay.sqlite3"), { readOnly: true });
  let mysql: Awaited<ReturnType<typeof createConnection>> | undefined;
  let snapshot: AppDatabase | undefined, expected: AppDatabase | undefined;
  try {
    phase = "read_shared_source";
    const processes = JSON.parse(execFileSync("pm2", ["jlist"], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 15000 })) as Array<{ name: string; pm2_env?: { status: string; pm_cwd: string; DATABASE_URL: string } }>;
    const matches = processes.filter(entry => entry.name === "epay-next-reconcile-v1" && entry.pm2_env?.status === "online" && entry.pm2_env.pm_cwd?.startsWith("/www/wwwroot/epay-next-releases/"));
    if (matches.length !== 1 || !matches[0]!.pm2_env?.DATABASE_URL) throw new Error("source process is ambiguous");
    mysql = await createConnection(mysqlSnapshotConfig(matches[0]!.pm2_env.DATABASE_URL));
    await mysql.query("SET SESSION TRANSACTION READ ONLY");
    const allowed = new Set([
      "SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()",
      "SET SESSION time_zone = '+00:00'", "SET SESSION lock_wait_timeout = 3", "SET SESSION innodb_lock_wait_timeout = 3", "SET autocommit = 0", "UNLOCK TABLES",
      `LOCK TABLES ${Object.keys(SOURCE_TABLES).map(name => `\`${name}\` READ`).join(", ")}`,
      ...Object.entries(SOURCE_TABLES).map(([name, id]) => `SELECT * FROM \`${name}\` ORDER BY \`${id}\``),
    ]);
    const source = await captureSharedCutoff({ query: sql => {
      if (!mysql || !allowed.has(sql)) throw new Error("audit source query is outside read-only protocol");
      return mysql.query({ sql, timeout: 5000 });
    } }, () => readMainMemorySnapshot({ origin: "http://127.0.0.1:8787", secret: snapshotSecret }));
    await mysql.end(); mysql = undefined;
    phase = "isolated_reimport";
    snapshot = await AppDatabase.open(join(scratch, "snapshot.sqlite3"), { masterKey: isolatedKey });
    const options = { database: snapshot, source: capturedSnapshotSource(source), masterKey: isolatedKey, instanceId: snapshot.instanceId(), sourceName: "maintenance-reconciliation", requireColumnMetadata: true, sourceOffsetMinutes: EPAY_MYSQL_OFFSET_MINUTES };
    const captured = await captureEPaySnapshot(options);
    expected = await AppDatabase.open(join(scratch, "expected.sqlite3"), { masterKey: isolatedKey });
    const imported = importCandidate(expected, options, captured.snapshotId, source.mainPayment);
    verifyCandidateArchive(expected, isolatedKey, source.mainPayment);
    expected.close(); expected = undefined;
    expected = await AppDatabase.open(join(scratch, "expected.sqlite3"), { masterKey: isolatedKey });
    phase = "compare_current_records";
    active.exec("BEGIN");
    const instance = String(active.prepare("SELECT value FROM system_metadata WHERE key='instance_id'").get()?.value);
    const cipher = new RuntimeSecretCipher(key, instance);
    const main = readCurrentMainPayment(active, cipher), legacy = readLegacyCursor(active, cipher);
    if (digest(main.payment) !== digest(source.mainPayment) || digest(legacy.tables) !== digest(source.tables) || digest(legacy.columns) !== digest(source.columns)) throw new Error("candidate source cursors differ from fresh shared cutoff");
    assert.equal(Number(active.prepare("SELECT (SELECT count(*) FROM epay_alipay_intents)+(SELECT count(*) FROM epay_wechat_intents) n").get()?.n), 0, "audit is limited to pre-cutover candidates");
    const importMarker = JSON.parse(String(active.prepare("SELECT value FROM system_metadata WHERE key='epay_candidate_import'").get()?.value)) as { snapshotId: string; sharedCutoff: boolean };
    assert.equal(importMarker.sharedCutoff, true);
    const actualContents = captureReleaseContents(active);
    const expectedContents = expected.read(sql => {
      sql.exec("BEGIN");
      try { return captureReleaseContents(sql); }
      finally { sql.exec("ROLLBACK"); }
    });
    const select = (contents: typeof actualContents) => Object.fromEntries(TABLES.map(table => [table, contents[table]!]));
    const differences = compareReleaseContents(select(expectedContents), select(actualContents));
    if (differences.length) throw new Error(`reconciled tables differ: ${differences.join(",")}`);
    const archive = verifyCandidateArchive({ read: operation => operation(active), instanceId: () => instance } as AppDatabase, key, source.mainPayment);
    for (const row of source.tables.Merchant) {
      if (readMerchantSecret(active, cipher, Number(row.id)) !== row.apiKey) throw new Error("merchant API secret differs from source");
    }
    for (const row of source.tables.MerchantInvoiceConfig) {
      const encrypted = active.prepare("SELECT nonce,ciphertext,authentication_tag FROM epay_legacy_invoice_config_source WHERE merchant_id=?").get(Number(row.merchantId));
      if (!encrypted) throw new Error("legacy invoice configuration missing");
      const plain = cipher.decrypt(`epay:config:legacy-invoice:${Number(row.merchantId)}`, 1, { cipherVersion: 1, nonce: Buffer.from(encrypted.nonce as Uint8Array), ciphertext: Buffer.from(encrypted.ciphertext as Uint8Array), authenticationTag: Buffer.from(encrypted.authentication_tag as Uint8Array) });
      try { if (digest(JSON.parse(plain.toString("utf8"))) !== digest(row)) throw new Error("legacy invoice configuration differs"); }
      finally { plain.fill(0); }
    }
    const ledger = auditMainLedger(source.mainPayment);
    assert.equal(ledger.summaryMismatches, 0);
    const liabilities = projectLegacyLiabilities(source.tables, source.mainPayment, EPAY_MYSQL_OFFSET_MINUTES);
    const merchants = ledger.balances.map(balance => {
      const liability = liabilities.find(item => item.mainMerchantId === balance.merchantId);
      const binding = active.prepare("SELECT epay_merchant_id FROM epay_merchant_bindings WHERE main_merchant_id=?").get(balance.merchantId);
      if (!liability || !binding) throw new Error("main merchant binding unresolved");
      const merchantId = Number(binding.epay_merchant_id), live = readLiveBalance(active, merchantId);
      const expectedAvailable = BigInt(balance.availableCents) + BigInt(liability.project(merchantId));
      if (BigInt(live.availableCents) !== expectedAvailable || live.frozenCents !== balance.frozenCents) throw new Error("candidate balance differs from original merchant liability");
      const count = (table: string) => Number(active.prepare(`SELECT count(*) n FROM ${table} WHERE merchant_id=?`).get(merchantId)?.n);
      return { merchantId, mainMerchantId: balance.merchantId, availableCents: live.availableCents, frozenCents: live.frozenCents, matches: true, orders: count("epay_orders"), mainOrders: count("epay_main_order_sources"), ledger: count("epay_balance_ledger"), invoices: count("epay_invoices"), invoiceApplications: count("epay_invoice_applications") };
    });
    const unbound = active.prepare(`SELECT m.merchant_id,m.enabled,
      (SELECT count(*) FROM epay_orders o WHERE o.merchant_id=m.merchant_id) orders,
      (SELECT count(*) FROM epay_site_bindings s WHERE s.merchant_id=m.merchant_id) sites,
      (SELECT count(*) FROM epay_balance_openings b WHERE b.merchant_id=m.merchant_id) balances
      FROM epay_merchant_accounts m WHERE NOT EXISTS(SELECT 1 FROM epay_merchant_bindings b WHERE b.epay_merchant_id=m.merchant_id)`).all();
    if (unbound.some(row => Number(row.enabled) !== 0 || Number(row.sites) !== 0 || Number(row.balances) !== 0)) throw new Error("unbound merchant is not isolated");
    const confirmations = auditConfirmedPayments(active);
    if (confirmations.confirmed || confirmations.inconsistent || confirmations.unconfirmedLedger || confirmations.unconfirmedCallbacks || confirmations.intentPaidWithoutConfirmation) throw new Error("unexpected native financial records before cutover");
    assert.equal(Number(active.prepare("SELECT count(*) n FROM epay_callback_jobs").get()?.n), 0);
    const report = {
      version: 1, verifiedAt: new Date().toISOString(), snapshotId: importMarker.snapshotId,
      sharedCutoff: true, cutoff: source.cutoff, sourceSha256: source.sourceSha256,
      sourceReadOnly: true, candidateReadOnly: true, reopenedImport: true,
      exactTableComparisons: select(actualContents), mainRecords: archive.recordCounts,
      migrationRecordsReconciled: true, openingLiabilitiesReconciled: true, merchants,
      merchantSecretsVerified: source.tables.Merchant.length, invoiceConfigurationsVerified: source.tables.MerchantInvoiceConfig.length,
      quarantinedMerchants: unbound.length, quarantinedOrders: unbound.reduce((n, row) => n + Number(row.orders), 0),
      quarantineMatchesImport: unbound.length === imported.candidate.quarantinedMerchants,
      preservedOwnership: true, unboundCollectionDisabled: true, historicalCallbacksReplayed: 0,
      historicalProviderSettlementVerified: false, providerRequests: 0, productionCutover: false,
    };
    assert.equal(report.quarantineMatchesImport, true);
    active.exec("COMMIT");
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600, flush: true });
    console.log(JSON.stringify({ ...report, merchants: report.merchants.map(({ matches, orders, mainOrders, ledger, invoices, invoiceApplications }) => ({ matches, orders, mainOrders, ledger, invoices, invoiceApplications })), exactTableComparisons: Object.fromEntries(TABLES.map(table => [table, actualContents[table]!.rows])) }));
  } finally {
    await mysql?.end(); active.close(); expected?.close(); snapshot?.close();
    key.fill(0); isolatedKey.fill(0); snapshotSecret.fill(0);
    rmSync(scratch, { recursive: true });
  }
}

reconcile().catch(error => {
  const reason = error instanceof Error && /^(reconciled tables differ:|candidate source cursors differ|candidate balance differs|unbound merchant is not isolated|legacy invoice configuration|merchant API secret differs|unexpected native financial records)/.test(error.message) ? error.message : "maintenance_reconciliation_failed";
  console.error(JSON.stringify({ ok: false, phase, reason })); process.exitCode = 1;
});
