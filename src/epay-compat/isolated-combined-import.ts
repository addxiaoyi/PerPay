import type { AppDatabase } from "../database/database.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { importEPaySnapshotInTransaction, importMainLedgerInTransaction } from "./isolated-import.ts";
import { preserveMainOrdersAndRefundsInTransaction } from "./main-order-import.ts";
import { auditMainRefunds } from "./main-refund-audit.ts";
import { auditMainSettlements } from "./main-settlement-audit.ts";
import { auditMainSourceCoverage } from "./main-source-coverage.ts";
import { preserveMainActivityInTransaction } from "./main-activity-source.ts";
import { preserveMainPaymentArchive } from "./main-payment-archive.ts";
import { auditImportedMerchantFees } from "./merchant-fee-audit.ts";

type SnapshotOptions = Parameters<typeof importEPaySnapshotInTransaction>[0];

// This candidate does not establish a shared source cutoff or authorize cutover.
export function importCombinedIsolatedSnapshot(target: Pick<AppDatabase, "write" | "instanceId">, options: SnapshotOptions, snapshotId: string, mainPayment: unknown) {
  const mainCoverage = auditMainSourceCoverage(mainPayment);
  const instanceId = target.instanceId();
  const cipher = new RuntimeSecretCipher(options.masterKey, instanceId);
  return target.write(db => {
    preserveMainPaymentArchive(db, cipher, mainPayment);
    const epay = importEPaySnapshotInTransaction(options, snapshotId, { database: db, instanceId });
    const merchantFees = auditImportedMerchantFees(db, mainPayment);
    const preserved = preserveMainOrdersAndRefundsInTransaction(db, cipher, mainPayment);
    const mainLedger = importMainLedgerInTransaction(db, cipher, mainPayment);
    const mainActivity = preserveMainActivityInTransaction(db, cipher, mainPayment);
    const mainRefundAudit = auditMainRefunds(mainPayment);
    const settlementIssues = auditMainSettlements(mainPayment);
    const issueCounts: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const issue of settlementIssues) issueCounts[issue.code] = (issueCounts[issue.code] ?? 0) + 1;
    const mainSettlementAudit = { issueCount: settlementIssues.length, issueCounts, payoutVerified: false as const };
    return { epay, merchantFees, mainOrders: preserved.orders, mainLedger, mainRefunds: preserved.refunds, mainActivity, mainRefundAudit, mainSettlementAudit, mainCoverage, financiallyReconciled: false as const, productionReady: false as const };
  });
}
