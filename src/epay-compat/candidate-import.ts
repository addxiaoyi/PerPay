import type { AppDatabase } from "../database/database.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { importCombinedIsolatedSnapshot } from "./isolated-combined-import.ts";
import { deriveMerchantFeeCandidates } from "./merchant-fee-candidates.ts";
import { verifyWechatMasterKeyGuard } from "./wechat-master-key.ts";
import { readMainPaymentArchive } from "./main-payment-archive.ts";
import { readEncryptedMainOrder } from "./main-order-source.ts";
import { readEncryptedMainLedgerSource } from "./main-ledger-source.ts";
import { readEncryptedMainRefund } from "./main-refund-source.ts";
import { readMainActivity } from "./main-activity-source.ts";

type SnapshotOptions = Omit<Parameters<typeof importCombinedIsolatedSnapshot>[1], "merchantFeeBps">;
const IMPORT_MARKER = "epay_candidate_import";

// The source snapshot remains immutable. Unbound records are retained, with collection disabled.
export function importCandidate(target: AppDatabase, options: SnapshotOptions, snapshotId: string, payment: unknown) {
  const fees = deriveMerchantFeeCandidates(options, snapshotId, payment);
  if (fees.unresolved.some(issue => issue.reason !== "unbound")) throw new Error("candidate import has conflicting merchant bindings");
  const rates = { ...fees.rates };
  for (const issue of fees.unresolved) rates[String(issue.merchantId)] = 0;
  const cipher = new RuntimeSecretCipher(options.masterKey, target.instanceId());
  return target.write(sql => {
    if (sql.prepare("SELECT 1 FROM system_metadata WHERE key=?").get(IMPORT_MARKER)) throw new Error("candidate was already imported");
    if (!sql.prepare("SELECT 1 FROM runtime_master_key_guard WHERE singleton_key=1").get()) {
      const guard = cipher.createGuard();
      sql.prepare("INSERT INTO runtime_master_key_guard VALUES(1,1,?,?,?,?)")
        .run(guard.nonce, guard.ciphertext, guard.authenticationTag, Date.now());
    }
    verifyWechatMasterKeyGuard(sql, cipher);
    const report = importCombinedIsolatedSnapshot({ instanceId: () => target.instanceId(), write: operation => operation(sql) }, { ...options, merchantFeeBps: rates }, snapshotId, payment);
    const audit = report.merchantFees;
    if (!report.mainLedger.summaryVerified || audit.mainUnmapped || audit.mainAmbiguousBindings || audit.mismatched || audit.missingMain || audit.identityMismatch || audit.ambiguousApi || audit.unsupportedPrecision) throw new Error("candidate merchant reconciliation failed");
    for (const issue of fees.unresolved) {
      const changed = sql.prepare("UPDATE epay_merchant_accounts SET enabled=0 WHERE merchant_id=? AND NOT EXISTS(SELECT 1 FROM epay_merchant_bindings WHERE epay_merchant_id=?)")
        .run(issue.merchantId, issue.merchantId);
      if (Number(changed.changes) !== 1) throw new Error("candidate quarantine failed");
    }
    const marker = { snapshotId, importedAt: new Date().toISOString(), sourceOffsetMinutes: options.sourceOffsetMinutes, quarantinedMerchants: fees.unresolved.length, sharedCutoff: false, acceptingOrders: false };
    sql.prepare("INSERT INTO system_metadata(key,value,updated_at) VALUES(?,?,?)").run(IMPORT_MARKER, JSON.stringify(marker), Date.now());
    return { ...report, candidate: marker };
  });
}

export function verifyCandidateArchive(target: AppDatabase, masterKey: Uint8Array, payment: unknown) {
  const cipher = new RuntimeSecretCipher(masterKey, target.instanceId());
  return target.read(sql => {
    verifyWechatMasterKeyGuard(sql, cipher);
    if (readMainPaymentArchive(sql, cipher) !== JSON.stringify(payment)) throw new Error("candidate payment archive differs");
    const source = payment as Record<"orders" | "ledger" | "refunds" | "settlements" | "callbacks" | "syncJobs", Array<Record<string, unknown>>>;
    const readers = { orders: readEncryptedMainOrder, ledger: readEncryptedMainLedgerSource, refunds: readEncryptedMainRefund };
    for (const kind of ["orders", "ledger", "refunds"] as const) for (const row of source[kind]) {
      if (typeof row.id !== "string" || readers[kind](sql, cipher, row.id) !== JSON.stringify(row)) throw new Error(`candidate ${kind} archive differs`);
    }
    for (const kind of ["settlements", "callbacks", "syncJobs"] as const) for (const row of source[kind]) {
      if (typeof row.id !== "string" || readMainActivity(sql, cipher, kind, row.id) !== JSON.stringify(row)) throw new Error(`candidate ${kind} archive differs`);
    }
    if (sql.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" || sql.prepare("PRAGMA foreign_key_check").get()) throw new Error("candidate database integrity failed");
    return { archiveVerified: true as const, recordCounts: Object.fromEntries(Object.keys(readers).concat(["settlements", "callbacks", "syncJobs"]).map(kind => [kind, source[kind as keyof typeof source].length])) };
  });
}
