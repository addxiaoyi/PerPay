import type { DatabaseSync } from "node:sqlite";
import type { AppDatabase } from "../database/database.ts";
import type { authorizeMerchant } from "./merchant-access.ts";
import type { RefundIdentity } from "./refund-evidence.ts";

export type RefundDatabase = Pick<AppDatabase, "read" | "write">;
export type RefundAccess = Awaited<ReturnType<typeof authorizeMerchant>>;
export type RefundRow = {
  refund_no: string; request_id: string; trade_no: string; merchant_id: number;
  provider: "alipay" | "wxpay"; provider_account: string; provider_trade_no: string;
  total_cents: number; amount_cents: number; debit_cents: number; reason: string; requested_by: string;
  approved_by: string | null; status: "REQUESTED" | "READY" | "PROCESSING" | "UNKNOWN" | "SUCCEEDED" | "REJECTED" | "CLOSED";
  provider_refund_no: string | null; submitted_at: number | null; next_attempt_at: number; attempts: number;
  lease_token: string | null; lease_until: number | null; response_sha256: string | null; last_error: string | null;
  created_at: number; updated_at: number;
};
export class RefundConflict extends Error {}
export class RefundPermission extends Error {}
export function refundTime(now: number) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid refund clock");
}
export function requireRefundAccess(sql: DatabaseSync, access: RefundAccess, admin = false) {
  if (!access.userId || !["admin", "owner", "member"].includes(access.role) ||
      !sql.prepare(`SELECT 1 FROM epay_merchant_bindings b JOIN epay_merchant_accounts m ON m.merchant_id=b.epay_merchant_id
      WHERE b.main_merchant_id=? AND b.main_api_id=? AND b.epay_merchant_id=? AND m.enabled=1`)
        .get(access.merchantId, access.mainApiId, access.epayMerchantId)) throw new RefundPermission("refund binding is unavailable");
  if (admin && access.role !== "admin") throw new RefundPermission("refund approval requires an administrator");
}
export function refundRow(sql: DatabaseSync, refundNo: string): RefundRow {
  const row = sql.prepare("SELECT * FROM epay_native_refunds WHERE refund_no=?").get(refundNo);
  if (!row) throw new RefundConflict("refund not found");
  for (const key of ["merchant_id", "total_cents", "amount_cents", "debit_cents", "submitted_at", "next_attempt_at", "attempts", "lease_until", "created_at", "updated_at"]) {
    if (row[key] === null) continue;
    const number = Number(row[key]);
    if (!Number.isSafeInteger(number) || number < 0) throw new Error("unsafe refund integer");
    row[key] = number;
  }
  return row as RefundRow;
}
export function refundIdentity(row: RefundRow): RefundIdentity {
  return { refundNo: row.refund_no, tradeNo: row.trade_no, merchantId: row.merchant_id, provider: row.provider,
    providerAccount: row.provider_account, providerTradeNo: row.provider_trade_no, totalCents: row.total_cents, amountCents: row.amount_cents };
}
export function publicRefund(row: RefundRow) {
  return { refundNo: row.refund_no, requestId: row.request_id, tradeNo: row.trade_no, amountCents: row.amount_cents,
    debitCents: row.debit_cents, reason: row.reason, status: row.status, requestedBy: row.requested_by,
    approvedBy: row.approved_by, createdAt: row.created_at, updatedAt: row.updated_at, lastError: row.last_error };
}
export function readRefund(database: Pick<RefundDatabase, "read">, access: RefundAccess, refundNo: string) {
  return database.read(sql => {
    requireRefundAccess(sql, access);
    const row = refundRow(sql, refundNo);
    if (row.merchant_id !== access.epayMerchantId) throw new RefundPermission("refund merchant differs");
    return publicRefund(row);
  });
}
