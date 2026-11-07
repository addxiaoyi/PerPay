import type { DatabaseSync } from "node:sqlite";

// Imported PAID states remain source records. They must not be confused with a
// native intent marked paid without proof, nor replayed into the new outbox.
export function auditConfirmedPayments(db: DatabaseSync): { confirmed: number; inconsistent: number; unconfirmedLedger: number; unconfirmedCallbacks: number; paidWithoutConfirmation: number; intentPaidWithoutConfirmation: number; paidWithoutIntent: number } {
  const row = db.prepare(`WITH proofs AS (
    SELECT trade_no, merchant_id, amount_cents, fee_cents, provider_trade_no, 'alipay' AS channel
      FROM epay_alipay_confirmations
    UNION ALL
    SELECT trade_no, merchant_id, amount_cents, fee_cents, provider_trade_no, 'wxpay' AS channel
      FROM epay_wechat_confirmations
  ), checked AS (
    SELECT p.trade_no,
      CASE WHEN p.amount_cents <= 0 OR p.fee_cents < 0 OR p.fee_cents > p.amount_cents
        OR (p.channel='alipay' AND NOT EXISTS (SELECT 1 FROM epay_alipay_intents i WHERE i.trade_no=p.trade_no AND i.merchant_id=p.merchant_id AND i.amount_cents=p.amount_cents AND i.fee_cents=p.fee_cents))
        OR (p.channel='wxpay' AND NOT EXISTS (SELECT 1 FROM epay_wechat_intents i WHERE i.trade_no=p.trade_no AND i.merchant_id=p.merchant_id AND i.amount_cents=p.amount_cents AND i.fee_cents=p.fee_cents))
        OR o.trade_no IS NULL OR o.merchant_id <> p.merchant_id OR o.type_code IS NOT p.channel
        OR o.status <> 'PAID' OR o.money_cents <> p.amount_cents OR o.real_money_cents IS NOT p.amount_cents
        OR o.get_money_cents IS NOT p.amount_cents OR o.api_trade_no IS NOT p.provider_trade_no
        OR NOT EXISTS (SELECT 1 FROM epay_balance_ledger l WHERE l.entry_id='epay_payment:' || p.trade_no
          AND l.merchant_id=p.merchant_id AND l.entry_type='payment_paid' AND l.source='perpay_epay'
          AND l.available_delta_cents=p.amount_cents-p.fee_cents AND l.frozen_delta_cents=0)
        OR NOT EXISTS (SELECT 1 FROM epay_callback_jobs j WHERE j.trade_no=p.trade_no AND j.merchant_id=p.merchant_id
          AND ((j.status IN ('PENDING','LEASED') AND o.notify_status='PENDING')
            OR (j.status='SUCCEEDED' AND o.notify_status='SUCCESS')
            OR (j.status='FAILED' AND o.notify_status='FAILED')))
        OR (p.channel='wxpay' AND EXISTS (SELECT 1 FROM epay_wechat_submissions s WHERE s.trade_no=p.trade_no AND s.state<>'SETTLED'))
        OR (SELECT count(*) FROM proofs q WHERE q.trade_no=p.trade_no) <> 1
      THEN 1 ELSE 0 END AS invalid
    FROM proofs p LEFT JOIN epay_orders o ON o.trade_no=p.trade_no
  ), unconfirmed AS (
    SELECT o.trade_no,
      EXISTS(SELECT 1 FROM epay_alipay_intents i WHERE i.trade_no=o.trade_no)
        OR EXISTS(SELECT 1 FROM epay_wechat_intents i WHERE i.trade_no=o.trade_no) AS has_intent
    FROM epay_orders o WHERE o.status='PAID'
      AND NOT EXISTS(SELECT 1 FROM proofs p WHERE p.trade_no=o.trade_no)
  ) SELECT (SELECT count(*) FROM checked) AS confirmed,
    (SELECT coalesce(sum(invalid),0) FROM checked) AS inconsistent,
    (SELECT count(*) FROM epay_balance_ledger l WHERE l.source='perpay_epay' AND l.entry_type='payment_paid'
      AND NOT EXISTS (SELECT 1 FROM proofs p WHERE l.entry_id='epay_payment:' || p.trade_no)) AS unconfirmedLedger,
    (SELECT count(*) FROM epay_callback_jobs j WHERE NOT EXISTS (SELECT 1 FROM proofs p WHERE p.trade_no=j.trade_no)) AS unconfirmedCallbacks,
    (SELECT count(*) FROM unconfirmed) AS paidWithoutConfirmation,
    (SELECT count(*) FROM unconfirmed WHERE has_intent=1) AS intentPaidWithoutConfirmation,
    (SELECT count(*) FROM unconfirmed WHERE has_intent=0) AS paidWithoutIntent`).get() as Record<string, bigint | number>;
  const confirmed = Number(row.confirmed), inconsistent = Number(row.inconsistent), unconfirmedLedger = Number(row.unconfirmedLedger), unconfirmedCallbacks = Number(row.unconfirmedCallbacks), paidWithoutConfirmation = Number(row.paidWithoutConfirmation);
  const intentPaidWithoutConfirmation = Number(row.intentPaidWithoutConfirmation), paidWithoutIntent = Number(row.paidWithoutIntent);
  if (![confirmed, inconsistent, unconfirmedLedger, unconfirmedCallbacks, paidWithoutConfirmation, intentPaidWithoutConfirmation, paidWithoutIntent].every(Number.isSafeInteger)) throw new Error("payment confirmation audit count exceeds safe integer range");
  return { confirmed, inconsistent, unconfirmedLedger, unconfirmedCallbacks, paidWithoutConfirmation, intentPaidWithoutConfirmation, paidWithoutIntent };
}
