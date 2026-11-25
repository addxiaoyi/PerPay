import type { DatabaseSync } from "node:sqlite";
export function auditInvoiceSubscriptionCharges(sql: DatabaseSync) {
  if(!sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='epay_invoice_subscription_receipts'").get())return {inconsistent:0,orphanCharges:0};
  const inconsistent=Number(sql.prepare(`SELECT count(*) count FROM epay_invoice_subscriptions s LEFT JOIN epay_invoice_subscription_receipts r ON r.receipt_id=s.last_receipt_id
    WHERE r.receipt_id IS NULL OR r.merchant_id<>s.merchant_id OR r.valid_until<>s.valid_until OR s.version<>(SELECT count(*) FROM epay_invoice_subscription_receipts p WHERE p.merchant_id=s.merchant_id)`).get()!.count);
  const receipts=Number(sql.prepare(`SELECT count(*) count FROM epay_invoice_subscription_receipts r WHERE NOT EXISTS(
    SELECT 1 FROM epay_balance_ledger l WHERE l.entry_id=r.ledger_entry_id AND l.merchant_id=r.merchant_id AND l.available_delta_cents=-10000
      AND l.frozen_delta_cents=0 AND l.entry_type='invoice_subscription' AND l.source='perpay_epay')
    OR NOT EXISTS(SELECT 1 FROM epay_invoice_subscriptions s WHERE s.merchant_id=r.merchant_id)`).get()!.count);
  const orphanCharges=Number(sql.prepare(`SELECT count(*) count FROM epay_balance_ledger l WHERE l.entry_type='invoice_subscription' AND l.source='perpay_epay'
    AND NOT EXISTS(SELECT 1 FROM epay_invoice_subscription_receipts r WHERE r.ledger_entry_id=l.entry_id)`).get()!.count);
  return {inconsistent:inconsistent+receipts,orphanCharges};
}
