import type { DatabaseSync } from "node:sqlite";

export function countWechatSubmissionViolations(db: DatabaseSync): number {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='epay_wechat_submissions'").get()) return 0;
  const row = db.prepare(`SELECT count(*) AS total FROM epay_wechat_submissions s
    JOIN epay_exact_order_requests r ON r.trade_no=s.trade_no
    LEFT JOIN epay_wechat_intents i ON i.trade_no=s.trade_no
    JOIN epay_orders o ON o.trade_no=s.trade_no
    LEFT JOIN epay_wechat_credentials c ON c.credential_id=r.credential_id
    WHERE i.trade_no IS NULL OR c.credential_id IS NULL OR o.type_code IS NOT 'wxpay'
       OR EXISTS (SELECT 1 FROM epay_alipay_confirmations a WHERE a.trade_no=s.trade_no)
       OR s.started_at<r.created_at OR s.started_at<i.created_at OR s.started_at<o.created_at
       OR o.merchant_id<>i.merchant_id OR o.money_cents<>i.amount_cents
       OR c.app_id<>i.app_id OR c.provider_merchant_id<>i.provider_merchant_id
       OR (s.state IN ('IN_FLIGHT','UNCERTAIN') AND (
         (o.status<>'PENDING' AND NOT (o.status='CLOSED' AND EXISTS (
           SELECT 1 FROM audit_events a WHERE a.action='epay.order.closed' AND a.outcome='SUCCESS'
             AND a.actor_type='SYSTEM' AND a.actor_id='payment-query' AND a.subject_type='epay_order' AND a.subject_id=o.trade_no
             AND a.occurred_at>=o.created_at AND json_extract(a.details_json,'$.provider')='wxpay'
             AND json_extract(a.details_json,'$.observedState')='CLOSED' AND json_extract(a.details_json,'$.signatureVerified')=1)))
         OR EXISTS (SELECT 1 FROM epay_wechat_confirmations WHERE trade_no=s.trade_no)
         OR (o.status='CLOSED' AND (o.paid_at IS NOT NULL OR o.api_trade_no IS NOT NULL
           OR EXISTS(SELECT 1 FROM epay_balance_ledger l WHERE l.entry_id='epay_payment:' || s.trade_no)
           OR EXISTS(SELECT 1 FROM epay_callback_jobs j WHERE j.trade_no=s.trade_no)))
       ))
       OR (s.state='SETTLED' AND NOT EXISTS (
         SELECT 1 FROM epay_wechat_confirmations p
         JOIN epay_balance_ledger l ON l.entry_id='epay_payment:' || p.trade_no
           AND l.merchant_id=p.merchant_id AND l.entry_type='payment_paid' AND l.source='perpay_epay'
           AND l.available_delta_cents=p.amount_cents-p.fee_cents AND l.frozen_delta_cents=0
         JOIN epay_callback_jobs j ON j.trade_no=p.trade_no AND j.merchant_id=p.merchant_id
         WHERE p.trade_no=s.trade_no AND p.merchant_id=i.merchant_id AND p.amount_cents=i.amount_cents AND p.fee_cents=i.fee_cents
           AND o.status='PAID' AND o.api_trade_no=p.provider_trade_no AND o.real_money_cents=i.amount_cents AND o.get_money_cents=i.amount_cents
       ))`).get() as { total: number | bigint };
  const count = Number(row.total);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("invalid WeChat submission integrity count");
  return count;
}
