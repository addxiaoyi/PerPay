import type { DatabaseSync } from "node:sqlite";
import type { RuntimeSecretCipher } from "../settings/crypto.ts";

export function hasBalanceOrder(sql: DatabaseSync, tradeNo: string): boolean {
  if (!sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='epay_balance_orders'").get()) return false;
  return Boolean(sql.prepare("SELECT 1 FROM epay_balance_orders WHERE trade_no=?").get(tradeNo));
}
export function readBalanceContract(sql: DatabaseSync, cipher: RuntimeSecretCipher, tradeNo: string, merchantId: number) {
  if (!hasBalanceOrder(sql, tradeNo)) return null;
  const row = sql.prepare("SELECT * FROM epay_balance_orders WHERE trade_no=? AND merchant_id=?").get(tradeNo, merchantId);
  if (!row) throw new Error("balance callback merchant differs");
  const name = `epay:config:balance-callback:${merchantId}:${row.main_api_id}:${tradeNo}` as const;
  const plain = cipher.decrypt(name, 1, { cipherVersion: 1, nonce: Buffer.from(row.nonce as Uint8Array), ciphertext: Buffer.from(row.ciphertext as Uint8Array), authenticationTag: Buffer.from(row.authentication_tag as Uint8Array) });
  try { return { orderId: String(row.order_id), merchantId: String(row.main_merchant_id), apiId: String(row.main_api_id), channel: "balance" as const,
    callbackId: String(row.callback_id), secret: plain.toString("utf8") }; }
  finally { plain.fill(0); }
}
