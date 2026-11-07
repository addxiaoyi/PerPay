import type { AppDatabase } from "../database/database.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { importEPaySnapshotInTransaction } from "./isolated-import.ts";
import { auditMainLedger } from "./main-ledger-audit.ts";
import { preserveMainPaymentArchive } from "./main-payment-archive.ts";
import { auditMainSourceCoverage } from "./main-source-coverage.ts";
import { auditImportedMerchantFees } from "./merchant-fee-audit.ts";

type SnapshotOptions = Parameters<typeof importEPaySnapshotInTransaction>[0];

// Quarantine preserves the encrypted source but never posts or assigns main-site transactions.
export function stageUnresolvedIsolatedSnapshot(target: Pick<AppDatabase, "write" | "instanceId">, options: SnapshotOptions, snapshotId: string, mainPayment: unknown) {
  if (options.mainPayment !== undefined || options.preserveRefundsForRehearsal !== undefined) throw new Error("quarantine cannot import main-site accounting");
  auditMainLedger(mainPayment);
  const coverage = auditMainSourceCoverage(mainPayment);
  const source = mainPayment as { merchants: Array<{ id: string; apiId?: unknown }> };
  const apiCounts = new Map<string, number>();
  for (const merchant of source.merchants) {
    if (typeof merchant.apiId === "string" && merchant.apiId) apiCounts.set(merchant.apiId, (apiCounts.get(merchant.apiId) ?? 0) + 1);
  }
  const instanceId = target.instanceId();
  const cipher = new RuntimeSecretCipher(options.masterKey, instanceId);
  return target.write(db => {
    preserveMainPaymentArchive(db, cipher, mainPayment);
    const epay = importEPaySnapshotInTransaction(options, snapshotId, { database: db, instanceId });
    const merchantFees = auditImportedMerchantFees(db, mainPayment);
    let unresolvedMainMerchants = 0;
    const binding = db.prepare("SELECT 1 FROM epay_merchant_bindings WHERE main_merchant_id=? AND main_api_id=?");
    for (const merchant of source.merchants) {
      if (typeof merchant.apiId !== "string" || !merchant.apiId || apiCounts.get(merchant.apiId) !== 1 || !binding.get(merchant.id, merchant.apiId)) unresolvedMainMerchants++;
    }
    return { epay, merchantFees, unresolvedMainMerchants, mainArchivePreserved: true as const, mainAccountingImported: false as const, sourceSnapshotMustBeRetained: true as const, financiallyReconciled: false as const, productionReady: false as const, mainCoverage: coverage };
  });
}
