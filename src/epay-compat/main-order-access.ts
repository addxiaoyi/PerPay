import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const MAIN_ORDER_ACCESS_SCHEMA = `
  CREATE TABLE epay_main_order_access (
    token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64),
    order_id TEXT NOT NULL REFERENCES epay_main_native_orders(order_id),
    merchant_id INTEGER NOT NULL REFERENCES epay_merchant_accounts(merchant_id),
    scope TEXT NOT NULL CHECK(scope IN ('order:read','receipt:read','invoice:create')),
    created_at INTEGER NOT NULL CHECK(created_at>=0),
    expires_at INTEGER NOT NULL CHECK(expires_at>created_at),
    revoked_at INTEGER CHECK(revoked_at IS NULL OR revoked_at>=created_at)
  ) STRICT;
  CREATE INDEX epay_main_access_order ON epay_main_order_access(order_id,scope);
  CREATE TRIGGER epay_main_access_identity BEFORE INSERT ON epay_main_order_access
    WHEN NOT EXISTS(SELECT 1 FROM epay_main_native_orders n WHERE n.order_id=NEW.order_id AND n.merchant_id=NEW.merchant_id)
    BEGIN SELECT RAISE(ABORT,'order access identity mismatch'); END;
  CREATE TRIGGER epay_main_access_immutable BEFORE UPDATE ON epay_main_order_access
    WHEN NEW.token_hash IS NOT OLD.token_hash OR NEW.order_id IS NOT OLD.order_id
      OR NEW.merchant_id IS NOT OLD.merchant_id OR NEW.scope IS NOT OLD.scope
      OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
      OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at)
    BEGIN SELECT RAISE(ABORT,'order access grant is immutable'); END;
`;

const ACCESS_TTL = 30 * 86_400_000;
const scopes = { order: "order:read", receipt: "receipt:read", invoice: "invoice:create" } as const;

export function issueMainOrderAccess(sql: DatabaseSync, orderId: string, merchantId: number, now: number) {
  if (!sql.isTransaction || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + ACCESS_TTL)) throw new Error("order access requires a transaction and valid time");
  const grant = (scope: string) => {
    const token = `pp1_${randomBytes(32).toString("base64url")}`;
    sql.prepare("INSERT INTO epay_main_order_access VALUES(?,?,?,?,?,?,NULL)")
      .run(createHash("sha256").update(token).digest("hex"), orderId, merchantId, scope, now, now + ACCESS_TTL);
    return token;
  };
  return { order: grant(scopes.order), receipt: grant(scopes.receipt), invoice: grant(scopes.invoice) };
}

export function verifyMainOrderAccess(sql: DatabaseSync, token: unknown, scope: string, orderId: string, now: number) {
  if (typeof token !== "string" || !/^pp1_[A-Za-z0-9_-]{43}$/.test(token) || !Number.isSafeInteger(now) || now < 0) return null;
  const row = sql.prepare(`SELECT n.trade_no,n.merchant_id,n.main_merchant_id,n.order_id FROM epay_main_order_access a
    JOIN epay_main_native_orders n ON n.order_id=a.order_id AND n.merchant_id=a.merchant_id
    WHERE a.token_hash=? AND a.scope=? AND a.order_id=? AND a.revoked_at IS NULL AND a.created_at<=? AND a.expires_at>?`)
    .get(createHash("sha256").update(token).digest("hex"), scope, orderId, now, now);
  return row ? { orderId: String(row.order_id), tradeNo: String(row.trade_no), merchantId: Number(row.merchant_id), mainMerchantId: String(row.main_merchant_id) } : null;
}
