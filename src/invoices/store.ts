import type { DatabaseSync } from "node:sqlite";
import { InvoiceError, invoiceProfileInput, invoiceTime, type InvoiceAccess, type InvoiceDatabase, type InvoiceIssue, type InvoiceStatus, type PublicInvoice, type StoredInvoiceProfile } from "./model.ts";

export type InvoiceRow = {
  kind?: "platform-fee";
  invoice_id: string; request_no: string; application_no: string; attempt: number; request_id: string; merchant_id: number; trade_no: string;
  amount_cents: number; profile_json: string; title: string; tax_id: string; email: string;
  payment_type: "wxpay" | "alipay" | "balance"; provider_trade_no: string; buyer_type: "INDIVIDUAL" | "ORGANIZATION";
  requested_by: string; status: InvoiceStatus; invoice_no: string | null;
  error_code: string | null; created_at: number; updated_at: number;
};

export function requireInvoiceAccess(sql: DatabaseSync, access: InvoiceAccess, admin = false): void {
  if (!access.userId || !["admin", "owner", "member"].includes(access.role) || !sql.prepare(`
    SELECT 1 FROM epay_merchant_bindings b JOIN epay_merchant_accounts m ON m.merchant_id=b.epay_merchant_id
    WHERE b.main_merchant_id=? AND b.main_api_id=? AND b.epay_merchant_id=? AND m.enabled=1`)
    .get(access.merchantId, access.mainApiId, access.epayMerchantId)) throw new InvoiceError("invoice_forbidden", 403, "invoice merchant binding is unavailable");
  if (admin && access.role !== "admin") throw new InvoiceError("invoice_forbidden", 403, "invoice profile requires an administrator");
}

export function requireInvoiceWriter(sql: DatabaseSync, access: InvoiceAccess): void {
  requireInvoiceAccess(sql, access);
  if (access.role === "member") throw new InvoiceError("invoice_forbidden", 403, "invoice operation requires a merchant owner");
}

export function storedProfile(sql: DatabaseSync, merchantId: number): StoredInvoiceProfile | null {
  const row = sql.prepare("SELECT * FROM epay_tax_invoice_profiles WHERE merchant_id=?").get(merchantId);
  if (!row) return null;
  const { expectedVersion, ...profile } = invoiceProfileInput.parse({ expectedVersion: Number(row.version),
    ...(row.provider === "fa-piao" ? { provider: "fa-piao" } : {}),
    subMchId: row.sub_mch_id, sellerName: row.seller_name, sellerTaxId: row.seller_tax_id,
    billingPersonId: row.billing_person_id,
    itemName: row.item_name, taxCode: row.tax_code, taxRateBps: Number(row.tax_rate_bps), enabled: Number(row.enabled) === 1 });
  return { ...profile, version: expectedVersion, authorized: Number(row.authorized) === 1, authorizationCheckedAt: safeInteger(row.authorization_checked_at) };
}

export function invoiceRow(sql: DatabaseSync, id: string, merchantId: number): InvoiceRow {
  const customer = sql.prepare("SELECT * FROM epay_tax_invoice_requests WHERE invoice_id=? AND merchant_id=?").get(id, merchantId);
  const row = customer ?? sql.prepare("SELECT * FROM epay_fee_invoice_requests WHERE invoice_id=? AND merchant_id=?").get(id, merchantId);
  if (!row) throw new InvoiceError("invoice_not_found", 404, "invoice not found");
  for (const key of ["merchant_id", "amount_cents", "attempt", "created_at", "updated_at"]) row[key] = safeInteger(row[key]);
  return { ...row, ...(!customer ? { kind: "platform-fee" as const } : {}) } as InvoiceRow;
}

export function latestInvoice(sql: DatabaseSync, merchantId: number, tradeNo: string): InvoiceRow | null {
  const row = sql.prepare("SELECT invoice_id FROM epay_tax_invoice_requests WHERE merchant_id=? AND trade_no=? ORDER BY attempt DESC LIMIT 1").get(merchantId, tradeNo);
  return row ? invoiceRow(sql, String(row.invoice_id), merchantId) : null;
}

export function claimInvoiceQuery(database: InvoiceDatabase, now: number, minimumAge: number): InvoiceRow | null {
  invoiceTime(now);
  if (!Number.isSafeInteger(minimumAge) || minimumAge < 30_000) throw new Error("invalid invoice query minimum age");
  return database.write(sql => {
    const oldest = sql.prepare(`SELECT invoice_id,merchant_id,updated_at,'customer' kind FROM epay_tax_invoice_requests
      WHERE status IN ('UNKNOWN','PROCESSING','REVERSING') AND updated_at<=?
      UNION ALL SELECT invoice_id,merchant_id,updated_at,'platform-fee' kind FROM epay_fee_invoice_requests
      WHERE status IN ('UNKNOWN','PROCESSING','REVERSING') AND updated_at<=?
      ORDER BY updated_at,invoice_id LIMIT 1`).get(now - minimumAge, now - minimumAge);
    if (!oldest) return null;
    const table = oldest.kind === "platform-fee" ? "epay_fee_invoice_requests" : "epay_tax_invoice_requests";
    sql.prepare(`UPDATE ${table} SET updated_at=? WHERE invoice_id=?`).run(now, String(oldest.invoice_id));
    return invoiceRow(sql, String(oldest.invoice_id), safeInteger(oldest.merchant_id));
  });
}

export function publicInvoice(row: InvoiceRow): PublicInvoice {
  return { id: row.invoice_id, requestNo: row.request_no, applicationNo: row.application_no, attempt: row.attempt, requestId: row.request_id, tradeNo: row.trade_no,
    ...(row.kind ? { kind: row.kind } : {}),
    amountCents: row.amount_cents, title: row.title, status: row.status, invoiceNo: row.invoice_no,
    errorCode: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function invoiceIssue(row: InvoiceRow): InvoiceIssue {
  const snapshot: unknown = JSON.parse(row.profile_json);
  const { expectedVersion: _version, enabled: _enabled, ...profile } = invoiceProfileInput.parse({ ...(snapshot as Record<string, unknown>), expectedVersion: 0, enabled: true });
  return { requestNo: row.request_no, applicationNo: row.application_no, merchantId: row.merchant_id, tradeNo: row.trade_no, amountCents: row.amount_cents,
    ...(row.kind ? { kind: row.kind } : {}),
    paymentType: row.payment_type, providerTradeNo: row.provider_trade_no, ...(row.invoice_no ? { invoiceNo: row.invoice_no } : {}),
    profile, buyer: { type: row.buyer_type, title: row.title, taxId: row.tax_id, email: row.email } };
}

function safeInteger(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("unsafe invoice integer");
  return number;
}
