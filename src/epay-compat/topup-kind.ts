import type { DatabaseSync } from "node:sqlite";
export function isBalanceTopup(sql:DatabaseSync,tradeNo:string):boolean {
  if(!sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='epay_balance_topups'").get())return false;
  return Boolean(sql.prepare('SELECT 1 FROM epay_balance_topups WHERE trade_no=?').get(tradeNo));
}
