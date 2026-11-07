import type { DatabaseSync } from "node:sqlite";

// These rows model already-confirmed payments; signature verification is tested separately.
export function recordSyntheticAlipayConfirmation(db: DatabaseSync, tradeNo: string, merchantId: number, amount = 100, fee = 5): void {
  db.prepare("UPDATE epay_orders SET type_code='alipay',get_money_cents=?,api_trade_no=? WHERE trade_no=? AND merchant_id=?").run(amount, `provider-${tradeNo}`, tradeNo, merchantId);
  db.prepare("INSERT INTO epay_alipay_intents VALUES (?,?,'app','seller','fixture-key',?,?,0)").run(tradeNo, merchantId, amount, fee);
  db.prepare("INSERT INTO epay_alipay_confirmations VALUES (?,?,?,?,?,0)").run(tradeNo, `provider-${tradeNo}`, merchantId, amount, fee);
  db.prepare("INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,frozen_delta_cents,reason,occurred_at,source) VALUES (?,?,'payment_paid',?,0,'fixture',0,'perpay_epay')").run(`epay_payment:${tradeNo}`, merchantId, amount - fee);
}
