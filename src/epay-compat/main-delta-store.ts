import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { RuntimeSecretCipher } from "../settings/crypto.ts";
import { planMainPaymentDelta } from "./main-delta.ts";
import { auditMainLedger } from "./main-ledger-audit.ts";
import { auditMainPayments } from "./main-payment-audit.ts";
import { auditMainRefunds } from "./main-refund-audit.ts";
import { auditMainSettlements } from "./main-settlement-audit.ts";
import { auditMainInvoiceFees } from "./main-invoice-audit.ts";
import { readMainPaymentArchive } from "./main-payment-archive.ts";
import { readLiveBalance } from "./live-balance.ts";
import { canonicalSource } from "./source-drift.ts";
import { verifyWechatMasterKeyGuard } from "./wechat-master-key.ts";

type Row = Record<string, unknown>;
type Payment = Record<string, unknown> & { merchants: Row[]; orders: Row[]; ledger: Row[] };
type Capture = { payment: unknown; expectedSha256: string; capturedAt: string; responseSha256: string; appliedAt: number };
type StoredRun = { sequence: number; source_sha256: string; previous_sha256: string; captured_at: number; response_sha256: string; nonce: Uint8Array; ciphertext: Uint8Array; authentication_tag: Uint8Array };
const MAX_APPLY_DELAY_MS = 30_000;
const POSTING_TYPES = new Set(["payment_paid", "manual_adjustment", "manual_refund", "manual_payout", "settlement_freeze", "settlement_unfreeze", "invoice_fee"]);
const hash = (value: unknown) => createHash("sha256").update(canonicalSource(value)).digest("hex");
const runName = (sequence: number, digest: string) => `epay:config:main-delta:${sequence}:${digest}` as const;

function parsePayment(raw: string): Payment {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("main synchronization source is invalid");
  const source = value as Payment;
  if (![source.merchants, source.orders, source.ledger].every(Array.isArray)) throw new Error("main synchronization source is incomplete");
  return source;
}

export function readCurrentMainPayment(db: DatabaseSync, cipher: RuntimeSecretCipher) {
  const tip = db.prepare("SELECT * FROM epay_main_sync_runs ORDER BY sequence DESC LIMIT 1").get() as StoredRun | undefined;
  if (!tip) {
    const raw = readMainPaymentArchive(db, cipher);
    if (!raw) throw new Error("main synchronization archive is unavailable");
    const payment = parsePayment(raw);
    return { sequence: 0, sourceSha256: hash(payment), capturedAt: 0, payment };
  }
  const plain = cipher.decrypt(runName(Number(tip.sequence), tip.source_sha256), 1, {
    cipherVersion: 1, nonce: Buffer.from(tip.nonce), ciphertext: Buffer.from(tip.ciphertext), authenticationTag: Buffer.from(tip.authentication_tag),
  });
  try {
    const payment = parsePayment(plain.toString("utf8"));
    if (hash(payment) !== tip.source_sha256) throw new Error("main synchronization source hash differs");
    return { sequence: Number(tip.sequence), sourceSha256: tip.source_sha256, capturedAt: Number(tip.captured_at), payment };
  } finally { plain.fill(0); }
}

function assertFinancialSnapshot(payment: unknown): void {
  const ledger = auditMainLedger(payment);
  if (ledger.missingMerchantReferences || ledger.unsupportedFeePrecision || ledger.summaryMismatches !== 0) throw new Error("main synchronization ledger summaries differ");
  const paid = auditMainPayments(payment);
  if (paid.missingOrderMerchantReferences !== 0 || paid.unknownOrderStatuses || paid.unpaidWithPaidAt || paid.paidWithInvalidPaidAt || paid.invalidOrderAmounts || paid.orderAmountMismatches || paid.missingOrderReference || paid.orphanOrderReference || paid.paidWithoutLedger || paid.duplicateLedger || paid.merchantMismatch || paid.invalidAmounts || paid.amountMismatch || paid.ledgerForNonPaid) throw new Error("main synchronization order postings differ");
  const refunds = auditMainRefunds(payment);
  if (refunds.missingRefundReferences || refunds.orphanRefundReferences || refunds.missingManualPostings || refunds.duplicateManualPostings || refunds.unexpectedManualPostings || refunds.mismatchedManualPostings || refunds.missingOrderReferences !== 0 || refunds.orderMerchantMismatches !== 0 || refunds.oversizedRecordedRefundOrders !== 0 || auditMainSettlements(payment).length) throw new Error("main synchronization refund or settlement postings differ");
  if (auditMainInvoiceFees(payment).length) throw new Error("main synchronization invoice fee postings differ");
}

function merchantBindings(db: DatabaseSync, payment: Payment): Map<string, number> {
  const bindings = new Map<string, number>();
  for (const row of payment.merchants) {
    if (typeof row.id !== "string" || typeof row.apiId !== "string") throw new Error("main synchronization merchant identity is invalid");
    const binding = db.prepare("SELECT epay_merchant_id FROM epay_merchant_bindings WHERE main_merchant_id=? AND main_api_id=?").get(row.id, row.apiId);
    const merchantId = Number(binding?.epay_merchant_id);
    if (!Number.isSafeInteger(merchantId) || merchantId < 1) throw new Error("main synchronization merchant binding is unresolved");
    readLiveBalance(db, merchantId);
    bindings.set(row.id, merchantId);
  }
  return bindings;
}

// Only a local, authenticated snapshot reader may call this. The caller owns the outer transaction.
export function applyMainPaymentDelta(db: DatabaseSync, cipher: RuntimeSecretCipher, capture: Capture) {
  if (!db.isTransaction) throw new Error("main synchronization requires a transaction");
  verifyWechatMasterKeyGuard(db, cipher);
  const capturedAt = Date.parse(capture.capturedAt);
  if (!/^[a-f0-9]{64}$/.test(capture.expectedSha256) || !/^[a-f0-9]{64}$/.test(capture.responseSha256) || !Number.isSafeInteger(capturedAt) || capturedAt < 0 || !Number.isSafeInteger(capture.appliedAt) || capture.appliedAt < capturedAt || capture.appliedAt - capturedAt > MAX_APPLY_DELAY_MS) throw new Error("main synchronization capture proof is invalid");
  const prior = readCurrentMainPayment(db, cipher);
  if (prior.sourceSha256 !== capture.expectedSha256) throw new Error("main synchronization cursor changed");
  const opening = db.prepare("SELECT count(*) n,max(opened_at) cutoff FROM epay_balance_openings").get();
  if (!Number(opening?.n) || capturedAt < Number(opening?.cutoff) || capturedAt < prior.capturedAt) throw new Error("main synchronization capture predates cutoff");
  const delta = planMainPaymentDelta(prior.payment, capture.payment);
  if (!delta.safe) throw new Error("main synchronization delta has unresolved differences");
  if (delta.collections.orders.added.length) throw new Error("main synchronization cannot admit legacy merchants or new orders after cutoff");
  for (const merchant of delta.collections.merchants.added) {
    const enrolled = db.prepare("SELECT 1 FROM epay_merchant_enrollments WHERE main_merchant_id=? AND main_api_id=? AND user_id=?").get(String(merchant.id), String(merchant.apiId), String(merchant.userId));
    if (!enrolled) throw new Error("main synchronization cannot admit legacy merchants or new orders after cutoff");
  }
  const mutableMerchantFields = new Set(["members", "enabled", "displayName", "username", "callbackUrl", "callbackConfigured", "apiSecret", "updatedAt"]);
  if (delta.collections.merchants.changed.some(change => change.columns.some(column => !mutableMerchantFields.has(column)))) throw new Error("main synchronization merchant financial identity changed");
  assertFinancialSnapshot(capture.payment);
  const current = parsePayment(JSON.stringify(capture.payment));
  const bindings = merchantBindings(db, current);
  if (prior.sequence && delta.currentSha256 === prior.sourceSha256) return { sequence: prior.sequence, sourceSha256: prior.sourceSha256, postedEntries: 0, duplicate: true };
  const sequence = prior.sequence + 1;
  db.exec("SAVEPOINT epay_main_delta");
  try {
    // Main-site identity remains authoritative; freezing a merchant must not stop legacy settlement.
    for (const change of delta.collections.merchants.changed) {
      const merchant = current.merchants.find(row => row.id === change.id)!;
      if (change.columns.includes("enabled")) {
        if (typeof merchant.enabled !== "boolean") throw new Error("main synchronization merchant status is invalid");
        db.prepare("UPDATE epay_merchant_accounts SET enabled=? WHERE merchant_id=?").run(merchant.enabled ? 1 : 0, bindings.get(change.id)!);
      }
      if (change.columns.includes("displayName")) {
        if (typeof merchant.displayName !== "string" || !merchant.displayName.trim() || merchant.displayName.length > 128) throw new Error("main synchronization merchant display name is invalid");
        db.prepare("UPDATE epay_merchant_accounts SET name=? WHERE merchant_id=?").run(merchant.displayName, bindings.get(change.id)!);
      }
    }
    const raw = JSON.stringify(current), sealed = cipher.encrypt(runName(sequence, delta.currentSha256), 1, raw);
    db.prepare("INSERT INTO epay_main_sync_runs VALUES(?,?,?,?,?,?,?,?,?,?)").run(sequence, prior.sourceSha256, delta.currentSha256, capture.responseSha256, capturedAt, capture.appliedAt, delta.collections.ledger.added.length, sealed.nonce, sealed.ciphertext, sealed.authenticationTag);
    for (const entry of delta.collections.ledger.added) {
      const merchantId = typeof entry.merchantId === "string" ? bindings.get(entry.merchantId) : undefined;
      const occurredAt = typeof entry.at === "string" ? Date.parse(entry.at) : NaN;
      if (!merchantId || typeof entry.id !== "string" || entry.id.length > 128 || typeof entry.type !== "string" || !POSTING_TYPES.has(entry.type) || !Number.isSafeInteger(entry.availableDelta) || !Number.isSafeInteger(entry.frozenDelta) || !Number.isSafeInteger(occurredAt) || occurredAt < 0 || occurredAt > capturedAt) throw new Error("main synchronization posting is invalid");
      if (entry.type === "manual_adjustment" && (typeof entry.actorId !== "string" || !entry.actorId || typeof entry.reason !== "string" || !entry.reason)) throw new Error("main synchronization adjustment has no audit identity");
      const reason = entry.reason == null ? null : typeof entry.reason === "string" ? entry.reason : undefined;
      const actor = entry.actorId == null ? null : typeof entry.actorId === "string" ? entry.actorId : undefined;
      if (reason === undefined || actor === undefined) throw new Error("main synchronization posting audit fields are invalid");
      // Append at the capture time; retain the provider's original timestamp in encrypted evidence.
      db.prepare(`INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,frozen_delta_cents,reason,actor_id,occurred_at,source)
        VALUES(?,?,?,?,?,?,?,?,'main_site_delta')`).run(entry.id, merchantId, entry.type, Number(entry.availableDelta), Number(entry.frozenDelta), reason, actor, capturedAt);
      const source = cipher.encrypt(`epay:config:main-delta-posting:${sequence}:${entry.id}`, 1, JSON.stringify(entry));
      db.prepare("INSERT INTO epay_main_delta_postings VALUES(?,?,?,?,?,?)").run(entry.id, sequence, occurredAt, source.nonce, source.ciphertext, source.authenticationTag);
      readLiveBalance(db, merchantId);
    }
    const restored = readCurrentMainPayment(db, cipher);
    if (restored.sourceSha256 !== delta.currentSha256 || canonicalSource(restored.payment) !== canonicalSource(current)) throw new Error("main synchronization persisted snapshot differs");
    db.exec("RELEASE SAVEPOINT epay_main_delta");
    return { sequence, sourceSha256: delta.currentSha256, postedEntries: delta.collections.ledger.added.length, duplicate: false };
  } catch (error) {
    db.exec("ROLLBACK TO SAVEPOINT epay_main_delta; RELEASE SAVEPOINT epay_main_delta");
    throw error;
  }
}
