import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { AppDatabase } from "../src/database/database.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { installBalanceOpenings, planBalanceOpenings } from "../src/epay-compat/balance-opening.ts";
import { adjustMerchantBalance, readLiveBalance } from "../src/epay-compat/live-balance.ts";

function protectedRecords(db: DatabaseSync) {
  return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'epay_*' ORDER BY name").all().map(row => {
    const table = String(row.name);
    if (!/^epay_[a-z0-9_]+$/.test(table)) throw new Error("invalid protected table");
    const query = db.prepare(`SELECT * FROM ${table}`); query.setReadBigInts(true);
    const rows = query.all().map(record => JSON.stringify(record, (_, value: unknown) => typeof value === "bigint" ? value.toString() : value)).sort();
    return [table, { count: rows.length, sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex") }];
  }));
}

function assertSourceReport(raw: string, snapshotId: string) {
  const report = JSON.parse(raw);
  assert.equal(report.sourceReadOnly, true);
  assert.equal(report.mainStableRead, true);
  assert.equal(report.snapshotId, snapshotId);
  for (const side of [report.epay, report.main]) {
    assert.ok(side && typeof side === "object" && Object.keys(side).length > 0);
    for (const entry of Object.values(side) as Array<Record<string, unknown>>) {
      if ("same" in entry) { assert.equal(entry.same, true); continue; }
      assert.deepEqual(entry.added, []); assert.deepEqual(entry.removed, []); assert.deepEqual(entry.changed, []);
      assert.equal(entry.baselineCount, entry.currentCount);
      assert.equal(entry.baselineSha256, entry.currentSha256);
    }
  }
  return createHash("sha256").update(raw).digest("hex");
}

let phase = "arguments";

async function rehearse() {
  process.umask(0o077);
  const [sourceRoot, sourceReport, reportPath] = process.argv.slice(2);
  if (process.env.EPAY_ISOLATED_TEST !== "1" || statfsSync("/dev/shm").type !== 0x01021994 || !sourceRoot || !/^\/var\/lib\/perpay-candidate-[0-9a-z-]+$/.test(sourceRoot) || resolve(sourceRoot) !== sourceRoot || !sourceReport?.startsWith("/root/perpay-recovery-") || !reportPath?.startsWith("/root/perpay-recovery-")) throw new Error("explicit isolated rehearsal paths are required");
  const directory = mkdtempSync("/dev/shm/perpay-balance-rehearsal-");
  const copy = join(directory, "candidate.sqlite3");
  const source = new DatabaseSync(join(sourceRoot, "data/perpay.sqlite3"), { readOnly: true });
  const key = Buffer.from(readFileSync(join(sourceRoot, "secrets/master-key"), "utf8").trim(), "hex");
  let candidate: AppDatabase | undefined;
  try {
    assert.equal(key.length, 32);
    const before = protectedRecords(source);
    const sourceSchema = Number(source.prepare("SELECT max(version) version FROM schema_migrations").get()?.version);
    phase = "consistent_backup";
    await backup(source, copy);
    assert.deepEqual(protectedRecords(source), before);
    assert.ok(realpathSync(copy).startsWith(realpathSync(directory) + "/"));
    const isolated = new DatabaseSync(copy);
    assert.deepEqual(protectedRecords(isolated), before);
    const snapshotId = JSON.parse(String(isolated.prepare("SELECT value FROM system_metadata WHERE key='epay_candidate_import'").get()?.value)).snapshotId;
    const sourceReportSha256 = assertSourceReport(readFileSync(sourceReport, "utf8"), snapshotId);
    // A copied process lease belongs to the source instance, never to this tmpfs clone.
    isolated.exec("DELETE FROM app_lease"); isolated.close();
    phase = "migrate_copy";
    candidate = await AppDatabase.open(copy, { masterKey: key });
    const cipher = new RuntimeSecretCipher(key, candidate.instanceId());
    const after = candidate.read(protectedRecords);
    for (const [table, rows] of Object.entries(before)) assert.deepEqual(after[table], rows);
    const targetSchema = candidate.read(db => Number(db.prepare("SELECT max(version) version FROM schema_migrations").get()?.version));
    assert.equal(targetSchema, 56);
    phase = "open_balances";
    const plan = candidate.write(db => planBalanceOpenings(db, cipher, sourceReportSha256));
    const installed = candidate.write(db => installBalanceOpenings(db, cipher, plan, Date.now()));
    const opened = candidate.read(db => plan.merchants.map(merchant => {
      const balance = readLiveBalance(db, merchant.merchantId);
      assert.equal(balance.availableCents, merchant.availableCents); assert.equal(balance.frozenCents, merchant.frozenCents);
      assert.equal(balance.version, 0);
      return balance;
    }));
    const merchant = opened.find(balance => balance.availableCents >= 2);
    assert.ok(merchant, "a positive isolated balance is required for adjustment rehearsal");
    phase = "adjust_and_rollback";
    const input = { merchantId: merchant.merchantId, requestId: "isolated-adjustment-rehearsal", expectedVersion: 0, deltaCents: -1, actor: "isolated-rehearsal", reason: "仅隔离副本的回滚验证" };
    const now = Date.now();
    const changed = adjustMerchantBalance(candidate, input, now);
    assert.equal(changed.availableCents, merchant.availableCents - 1);
    assert.equal(adjustMerchantBalance(candidate, input, now).duplicate, true);
    candidate.write(db => db.exec("CREATE TEMP TRIGGER reject_rehearsal_audit BEFORE INSERT ON main.audit_events BEGIN SELECT RAISE(ABORT,'isolated audit failure'); END"));
    assert.throws(() => adjustMerchantBalance(candidate!, { ...input, requestId: "isolated-adjustment-failure", expectedVersion: 1 }, now), /isolated audit failure/);
    candidate.write(db => db.exec("DROP TRIGGER reject_rehearsal_audit"));
    assert.deepEqual(candidate.read(db => readLiveBalance(db, merchant.merchantId)), { ...merchant, availableCents: merchant.availableCents - 1, version: 1 });
    candidate.close(); candidate = undefined;
    phase = "reopen";
    candidate = await AppDatabase.open(copy, { masterKey: key });
    assert.equal(candidate.read(db => readLiveBalance(db, merchant.merchantId)).availableCents, changed.availableCents);
    assert.equal(candidate.integrityCheck().ok, true);
    candidate.read(db => assert.equal(Number(db.prepare("SELECT count(*) n FROM epay_balance_adjustments").get()?.n), 1));
    assert.deepEqual(protectedRecords(source), before);
    const report = { createdAt: new Date().toISOString(), isolated: true, sourceSchema, targetSchema, protectedTablesUnchanged: Object.keys(before).length, merchantsOpened: installed.merchantsOpened, openingBalancesMatch: true, sourceReportSha256, planSha256: plan.planSha256, duplicateAdjustmentRejected: true, transactionFailureRolledBack: true, reopenedVerified: true, sourceUnchanged: true, sharedCutoff: false, productionCutover: false };
    writeFileSync(reportPath, JSON.stringify(report), { mode: 0o600, flag: "wx", flush: true });
    console.log(JSON.stringify(report));
  } finally {
    candidate?.close(); source.close(); key.fill(0);
    assert.ok(realpathSync(directory).startsWith("/dev/shm/perpay-balance-rehearsal-"));
    rmSync(directory, { recursive: true, force: true });
  }
}

rehearse().catch(error => { console.error(JSON.stringify({ error: "isolated balance rehearsal failed", phase, category: error instanceof Error ? error.name : "unknown" })); process.exitCode = 1; });
