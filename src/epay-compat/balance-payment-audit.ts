import type { DatabaseSync } from "node:sqlite";
import type { ConfirmedOrder } from "./confirmed-order.ts";

export function hasBalanceConfirmationTable(sql: DatabaseSync): boolean {
  return Boolean(sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='epay_balance_confirmations'").get());
}
export function readConfirmedBalanceOrder(sql: DatabaseSync, tradeNo: string, merchantId: number): ConfirmedOrder | undefined {
  return sql.prepare(`SELECT o.trade_no,o.out_trade_no,o.merchant_id,o.type_code,o.name,o.money_cents,o.real_money_cents,o.notify_url,o.return_url,o.param
    FROM epay_orders o JOIN epay_balance_orders b ON b.trade_no=o.trade_no JOIN epay_balance_confirmations c ON c.trade_no=o.trade_no
    JOIN epay_balance_ledger debit ON debit.entry_id=c.payer_entry_id JOIN epay_balance_ledger credit ON credit.entry_id=c.receiver_entry_id
    WHERE o.trade_no=? AND o.merchant_id=? AND o.type_code='balance' AND o.status='PAID'
      AND o.money_cents=c.amount_cents AND o.real_money_cents=c.amount_cents AND o.get_money_cents=c.amount_cents AND o.api_trade_no=c.provider_trade_no
      AND c.merchant_id=o.merchant_id AND b.merchant_id=o.merchant_id AND b.fee_cents=c.fee_cents
      AND debit.merchant_id=c.payer_merchant_id AND debit.entry_type='balance_payment_out' AND debit.source='perpay_balance'
      AND debit.available_delta_cents=-c.amount_cents AND debit.frozen_delta_cents=0
      AND credit.merchant_id=c.merchant_id AND credit.entry_type='payment_paid' AND credit.source='perpay_epay'
      AND credit.available_delta_cents=c.amount_cents-c.fee_cents AND credit.frozen_delta_cents=0
      AND NOT EXISTS(SELECT 1 FROM epay_alipay_confirmations WHERE trade_no=o.trade_no)
      AND NOT EXISTS(SELECT 1 FROM epay_wechat_confirmations WHERE trade_no=o.trade_no)`)
    .get(tradeNo, merchantId) as ConfirmedOrder | undefined;
}
export function auditBalanceTransfers(sql: DatabaseSync) {
  if (!hasBalanceConfirmationTable(sql)) return { inconsistent: 0, orphanDebits: 0 };
  let inconsistent = 0;
  for (const row of sql.prepare("SELECT trade_no,merchant_id FROM epay_balance_confirmations").all())
    if (!readConfirmedBalanceOrder(sql, String(row.trade_no), Number(row.merchant_id))) inconsistent++;
  const refunds = Number(sql.prepare(`SELECT count(*) count FROM epay_balance_refunds r JOIN epay_balance_confirmations c ON c.trade_no=r.trade_no
    WHERE r.amount_cents<>c.amount_cents OR NOT EXISTS(SELECT 1 FROM epay_balance_ledger l WHERE l.entry_id=r.payer_entry_id
      AND l.merchant_id=c.payer_merchant_id AND l.entry_type='balance_refund_in' AND l.source='perpay_balance' AND l.available_delta_cents=c.amount_cents AND l.frozen_delta_cents=0)
    OR NOT EXISTS(SELECT 1 FROM epay_balance_ledger l WHERE l.entry_id=r.receiver_entry_id AND l.merchant_id=c.merchant_id
      AND l.entry_type='balance_refund_out' AND l.source='perpay_balance' AND l.available_delta_cents=-(c.amount_cents-c.fee_cents) AND l.frozen_delta_cents=0)`).get()!.count);
  const orphanDebits = Number(sql.prepare(`SELECT count(*) count FROM epay_balance_ledger l WHERE l.source='perpay_balance' AND (
    (l.entry_type='balance_payment_out' AND NOT EXISTS(SELECT 1 FROM epay_balance_confirmations c WHERE c.payer_entry_id=l.entry_id)) OR
    (l.entry_type IN ('balance_refund_in','balance_refund_out') AND NOT EXISTS(SELECT 1 FROM epay_balance_refunds r WHERE r.payer_entry_id=l.entry_id OR r.receiver_entry_id=l.entry_id)))`).get()!.count);
  return { inconsistent: inconsistent + refunds, orphanDebits };
}
