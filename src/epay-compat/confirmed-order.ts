import type { DatabaseSync } from "node:sqlite";

export type ConfirmedOrder = { trade_no: string; out_trade_no: string; merchant_id: bigint | number; type_code: string | null; name: string; money_cents: bigint | number; real_money_cents: bigint | number; notify_url: string; return_url: string | null; param: string | null };

export function readConfirmedOrder(db: DatabaseSync, tradeNo: string, merchantId: number): ConfirmedOrder | undefined {
  return db.prepare(`SELECT trade_no, out_trade_no, merchant_id, type_code, name, money_cents, real_money_cents, notify_url, return_url, param
    FROM epay_orders o WHERE trade_no = ? AND merchant_id = ? AND status = 'PAID' AND money_cents > 0 AND real_money_cents = money_cents
    AND get_money_cents = money_cents AND api_trade_no IS NOT NULL
    AND ((o.type_code='alipay' AND NOT EXISTS (SELECT 1 FROM epay_wechat_confirmations WHERE trade_no=o.trade_no))
      OR (o.type_code='wxpay' AND NOT EXISTS (SELECT 1 FROM epay_alipay_confirmations WHERE trade_no=o.trade_no)))
    AND (o.type_code<>'wxpay' OR NOT EXISTS (SELECT 1 FROM epay_wechat_submissions s WHERE s.trade_no=o.trade_no AND s.state<>'SETTLED'))
    AND EXISTS (SELECT COUNT(*) FROM (
      SELECT c.trade_no, c.merchant_id, c.amount_cents, c.fee_cents, c.provider_trade_no, 'alipay' AS payment_type
      FROM epay_alipay_confirmations c JOIN epay_alipay_intents i ON i.trade_no=c.trade_no
      WHERE i.merchant_id=c.merchant_id AND i.amount_cents=c.amount_cents AND i.fee_cents=c.fee_cents
      UNION ALL
      SELECT c.trade_no, c.merchant_id, c.amount_cents, c.fee_cents, c.provider_trade_no, 'wxpay' AS payment_type
      FROM epay_wechat_confirmations c JOIN epay_wechat_intents i ON i.trade_no=c.trade_no
      WHERE i.merchant_id=c.merchant_id AND i.amount_cents=c.amount_cents AND i.fee_cents=c.fee_cents
    ) c JOIN epay_balance_ledger l ON l.entry_id='epay_payment:' || c.trade_no
      AND l.merchant_id=c.merchant_id AND l.entry_type='payment_paid' AND l.source='perpay_epay'
      AND l.available_delta_cents=c.amount_cents-c.fee_cents AND l.frozen_delta_cents=0
    WHERE c.trade_no=o.trade_no AND c.merchant_id=o.merchant_id AND c.amount_cents=o.money_cents AND c.provider_trade_no=o.api_trade_no
    HAVING COUNT(*)=1 AND MIN(c.payment_type)=o.type_code)`)
    .get(tradeNo, merchantId) as ConfirmedOrder | undefined;
}
