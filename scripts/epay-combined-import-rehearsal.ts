import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { AppDatabase } from "../src/database/database.ts";
import { importCombinedIsolatedSnapshot } from "../src/epay-compat/isolated-combined-import.ts";
import { readEncryptedMainLedgerSource } from "../src/epay-compat/main-ledger-source.ts";
import { readEncryptedMainOrder } from "../src/epay-compat/main-order-source.ts";
import { readEncryptedMainRefund } from "../src/epay-compat/main-refund-source.ts";
import { readMainActivity } from "../src/epay-compat/main-activity-source.ts";
import { readMainPaymentArchive } from "../src/epay-compat/main-payment-archive.ts";
import { verifyWechatMasterKeyGuard } from "../src/epay-compat/wechat-master-key.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { deriveMerchantFeeCandidates } from "../src/epay-compat/merchant-fee-candidates.ts";

type Options = Parameters<typeof importCombinedIsolatedSnapshot>[1];

export async function rehearseCombinedImport(options: Options, snapshotId: string, payment: unknown, useBoundFeeCandidates = false) {
  if (process.env.EPAY_ISOLATED_TEST !== "1" || statfsSync("/dev/shm").type !== 0x01021994) throw new Error("tmpfs isolation is required");
  const feeCandidates = deriveMerchantFeeCandidates(options, snapshotId, payment);
  const importOptions = useBoundFeeCandidates ? { ...options, merchantFeeBps: { ...options.merchantFeeBps, ...feeCandidates.rates } } : options;
  const directory = mkdtempSync("/dev/shm/perpay-combined-rehearsal-");
  const path = join(directory, "target.sqlite");
  const wrongKey = randomBytes(32);
  let db: AppDatabase | undefined;
  try {
    db = await AppDatabase.open(path, { masterKey: options.masterKey });
    const instanceId = db.instanceId();
    const cipher = new RuntimeSecretCipher(options.masterKey, instanceId);
    const guard = cipher.createGuard();
    db.write(sql => sql.prepare("INSERT INTO runtime_master_key_guard(singleton_key,cipher_version,nonce,ciphertext,authentication_tag,created_at) VALUES(1,1,?,?,?,0)").run(guard.nonce, guard.ciphertext, guard.authenticationTag));
    const report = importCombinedIsolatedSnapshot(db, importOptions, snapshotId, payment);
    db.close();
    db = undefined;
    db = await AppDatabase.open(path, { masterKey: options.masterKey });
    if (db.instanceId() !== instanceId) throw new Error("reopened database instance identity changed");
    return db.read(sql => {
      verifyWechatMasterKeyGuard(sql, cipher);
      let wrongKeyRejected = false;
      try { verifyWechatMasterKeyGuard(sql, new RuntimeSecretCipher(wrongKey, instanceId)); } catch { wrongKeyRejected = true; }
      if (!wrongKeyRejected) throw new Error("wrong master key was accepted");
      if (readMainPaymentArchive(sql, cipher) !== JSON.stringify(payment)) throw new Error("reopened main payment archive mismatch");
      const source = payment as Record<"orders" | "ledger" | "refunds" | "settlements" | "callbacks" | "syncJobs", Array<Record<string, unknown>>>;
      for (const order of source.orders) {
        if (typeof order.id !== "string" || readEncryptedMainOrder(sql, cipher, order.id) !== JSON.stringify(order)) throw new Error("reopened main order mismatch");
      }
      for (const entry of source.ledger) {
        if (typeof entry.id !== "string" || readEncryptedMainLedgerSource(sql, cipher, entry.id) !== JSON.stringify(entry)) throw new Error("reopened main ledger mismatch");
      }
      for (const refund of source.refunds) {
        if (typeof refund.id !== "string" || readEncryptedMainRefund(sql, cipher, refund.id) !== JSON.stringify(refund)) throw new Error("reopened main refund mismatch");
      }
      for (const kind of ["settlements", "callbacks", "syncJobs"] as const) for (const activity of source[kind]) {
        if (typeof activity.id !== "string" || readMainActivity(sql, cipher, kind, activity.id) !== JSON.stringify(activity)) throw new Error("reopened main activity mismatch");
      }
      const activityRun = sql.prepare("SELECT settlement_count,callback_count,sync_job_count FROM epay_main_activity_import_runs WHERE singleton_key=1").get();
      if (!activityRun || Number(activityRun.settlement_count) !== source.settlements.length || Number(activityRun.callback_count) !== source.callbacks.length || Number(activityRun.sync_job_count) !== source.syncJobs.length) throw new Error("main activity import marker mismatch");
      const activityCount = sql.prepare("SELECT count(*) AS count FROM epay_main_activity_sources").get();
      if (Number(activityCount?.count) !== source.settlements.length + source.callbacks.length + source.syncJobs.length) throw new Error("main activity count mismatch");
      const runs = sql.prepare("SELECT count(*) AS count FROM epay_compat_import_runs WHERE import_id=?").get(snapshotId);
      if (Number(runs?.count) !== 1) throw new Error("EPay import marker missing");
      if (sql.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" || sql.prepare("PRAGMA foreign_key_check").get()) throw new Error("reopened database integrity check failed");
      return { merchantFees: report.merchantFees, feeCandidates: { applied: useBoundFeeCandidates, derived: Object.keys(feeCandidates.rates).length, unresolved: feeCandidates.unresolved.length, sharedCutoffVerified: false, historicalFeesVerified: false }, mainOrders: report.mainOrders, mainLedger: report.mainLedger.count, mainRefunds: report.mainRefunds, mainActivity: report.mainActivity, mainRefundAudit: report.mainRefundAudit, mainSettlementAudit: report.mainSettlementAudit, mainCoverage: report.mainCoverage, mainBalanceSummaryVerified: report.mainLedger.summaryVerified, reopenedVerified: true as const, wrongKeyRejected, financiallyReconciled: false as const, productionReady: false as const };
    });
  } finally {
    db?.close();
    wrongKey.fill(0);
    rmSync(directory, { recursive: true, force: true });
  }
}
