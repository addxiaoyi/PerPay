import type { DatabaseSync } from "node:sqlite";
import type { RuntimeSecretCipher } from "../settings/crypto.ts";
import { auditConfirmedPayments } from "./confirmation-audit.ts";
import { auditMainLedger } from "./main-ledger-audit.ts";
import { auditMainRefunds } from "./main-refund-audit.ts";
import { auditMainSettlements } from "./main-settlement-audit.ts";
import { readEncryptedMainLedgerSource } from "./main-ledger-source.ts";
import { readMainPaymentArchive } from "./main-payment-archive.ts";

function amount(value: bigint): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error("ledger balance exceeds safe integer range");
  return result;
}

// This projection is not an authoritative balance until the imported baseline is reconciled.
export function projectMerchantLedgerBalance(db: DatabaseSync, cipher: RuntimeSecretCipher, merchantId: number) {
  if (!db.isTransaction) throw new Error("ledger balance projection requires a transaction");
  if (!Number.isSafeInteger(merchantId) || merchantId < 1) throw new Error("invalid merchant ID");
  const binding = db.prepare("SELECT main_merchant_id,main_api_id FROM epay_merchant_bindings WHERE epay_merchant_id=?").get(merchantId) as { main_merchant_id: string; main_api_id: string } | undefined;
  if (!binding) throw new Error("merchant binding is unavailable");
  const archive = readMainPaymentArchive(db, cipher);
  if (archive === null) throw new Error("main payment archive is unavailable");
  const payment: unknown = JSON.parse(archive);
  const sourceAudit = auditMainLedger(payment);
  if (sourceAudit.missingMerchantReferences || sourceAudit.unsupportedFeePrecision || sourceAudit.summaryMismatches) throw new Error("main ledger archive is inconsistent");
  const refunds = auditMainRefunds(payment);
  if (refunds.missingRefundReferences || refunds.orphanRefundReferences || refunds.missingManualPostings || refunds.duplicateManualPostings || refunds.unexpectedManualPostings || refunds.mismatchedManualPostings || refunds.missingOrderReferences || refunds.orderMerchantMismatches || refunds.oversizedRecordedRefundOrders || (refunds.refundCount > 0 && refunds.missingOrderReferences === null)) throw new Error("main refund archive is inconsistent");
  if (auditMainSettlements(payment).length !== 0) throw new Error("main settlement archive is inconsistent");
  const source = payment as { merchants: Array<{ id: string; apiId?: unknown }>; ledger: Array<{ id: string; merchantId: string; type: string; availableDelta: number; frozenDelta: number; at: string; reason?: string | null; actorId?: string | null }> };
  const merchant = source.merchants.find(row => row.id === binding.main_merchant_id);
  if (!merchant || merchant.apiId !== binding.main_api_id) throw new Error("merchant is absent from main ledger archive");
  const sourceEntries = new Map(source.ledger.filter(row => row.merchantId === binding.main_merchant_id).map(row => [row.id, row]));
  const baseline = db.prepare(`SELECT r.entry_count,
    (SELECT count(*) FROM epay_balance_ledger WHERE source='main_site') AS mapped,
    (SELECT count(*) FROM epay_main_ledger_sources) AS retained,
    (SELECT count(*) FROM epay_balance_ledger l LEFT JOIN epay_main_ledger_sources s ON s.entry_id=l.entry_id
      WHERE l.source='main_site' AND s.entry_id IS NULL) AS missing
    FROM epay_main_ledger_import_runs r WHERE r.singleton_key=1`).get();
  if (!baseline || Number(baseline.entry_count) !== source.ledger.length || baseline.entry_count !== baseline.mapped || baseline.entry_count !== baseline.retained || Number(baseline.missing) !== 0) throw new Error("main ledger baseline is incomplete");
  const audit = auditConfirmedPayments(db);
  if (audit.inconsistent || audit.unconfirmedLedger || audit.unconfirmedCallbacks) throw new Error("payment confirmation audit failed");
  const query = db.prepare("SELECT entry_id,entry_type,source,available_delta_cents,frozen_delta_cents,occurred_at,reason,actor_id FROM epay_balance_ledger WHERE merchant_id=? ORDER BY entry_id");
  query.setReadBigInts(true);
  const rows = query.all(merchantId) as Array<{ entry_id: string; entry_type: string; source: string; available_delta_cents: bigint; frozen_delta_cents: bigint; occurred_at: bigint; reason: string | null; actor_id: string | null }>;
  let available = 0n, frozen = 0n;
  for (const row of rows) {
    if (row.source === "main_site") {
      const expected = sourceEntries.get(row.entry_id);
      if (expected === undefined || readEncryptedMainLedgerSource(db, cipher, row.entry_id) !== JSON.stringify(expected)) throw new Error("main ledger source does not match archive");
      const occurredAt = Date.parse(expected.at);
      if (!Number.isSafeInteger(expected.availableDelta) || !Number.isSafeInteger(expected.frozenDelta) || !Number.isSafeInteger(occurredAt) ||
        row.entry_type !== expected.type || row.available_delta_cents !== BigInt(expected.availableDelta) ||
        row.frozen_delta_cents !== BigInt(expected.frozenDelta) || row.occurred_at !== BigInt(occurredAt) ||
        row.reason !== (expected.reason ?? null) || row.actor_id !== (expected.actorId ?? null)) {
        throw new Error("main ledger source values mismatch");
      }
      sourceEntries.delete(row.entry_id);
    } else if (row.source !== "perpay_epay" || row.entry_type !== "payment_paid") {
      throw new Error("unrecognized ledger source");
    }
    available += row.available_delta_cents;
    frozen += row.frozen_delta_cents;
  }
  if (sourceEntries.size !== 0) throw new Error("main ledger source does not match archive");
  return { availableCents: amount(available), frozenCents: amount(frozen), scope: "shadow_ledger_projection" as const, financiallyReconciled: false as const };
}
