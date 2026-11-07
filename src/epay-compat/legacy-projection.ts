import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { auditLegacyDashboardBalance } from "./legacy-balance-audit.ts";
import type { LegacyRow, LegacyTables } from "./legacy-delta-plan.ts";
import { parseSourceTimestamp } from "./source-timestamp.ts";
import { parseLegacyCents } from "./money.ts";

type Mapping = Record<string, SQLInputValue>;
const orderColumns = { status: "status", apiTradeNo: "api_trade_no", realMoney: "real_money_cents", getMoney: "get_money_cents", paidAt: "paid_at", updatedAt: "updated_at", notifyStatus: "notify_status", notifyCount: "notify_count", notifyLastAt: "notify_last_at", buyer: "buyer", buyerEmail: "buyer_email", providerResult: "provider_result_json" };
const invoiceColumns = { id: "invoice_id", tradeNo: "trade_no", kind: "kind", merchantId: "merchant_id", title: "title", taxId: "tax_id", email: "email", amount: "amount_cents", status: "status", provider: "provider", externalId: "external_id", receiptPdfPath: "receipt_pdf_path", providerMessage: "provider_message", createdAt: "created_at", updatedAt: "updated_at", issuedAt: "issued_at", serviceFee: "service_fee_cents", chargedAt: "charged_at" };
const applicationColumns = { id: "application_id", merchantId: "merchant_id", tradeNo: "trade_no", outTradeNo: "out_trade_no", title: "title", taxId: "tax_id", email: "email", feeCents: "fee_cents", status: "status", createdAt: "created_at", updatedAt: "updated_at", invoiceNo: "invoice_no", invoiceUrl: "invoice_url", issuedAt: "issued_at", errorCode: "error_code", errorMessage: "error_message", emailSent: "email_sent", emailError: "email_error" };
const logColumns = { id: "notify_id", tradeNo: "trade_no", url: "url", params: "params_json", responseCode: "response_code", responseBody: "response_body", status: "status", error: "error", createdAt: "created_at" };
export const legacyMappings = {
  Order: { table: "epay_orders", key: "trade_no", columns: orderColumns },
  Invoice: { table: "epay_invoices", key: "invoice_id", columns: invoiceColumns },
  InvoiceApplication: { table: "epay_invoice_applications", key: "application_id", columns: applicationColumns },
  NotifyLog: { table: "epay_notify_logs", key: "notify_id", columns: logColumns },
};
const timeFields = new Set(["createdAt", "updatedAt", "paidAt", "notifyLastAt", "issuedAt", "chargedAt"]);
const moneyFields = new Set(["money", "realMoney", "getMoney", "amount", "serviceFee"]);
const integerFields = new Set(["merchantId", "feeCents", "notifyCount", "responseCode"]);

function columnValue(field: string, value: unknown, offset: number): SQLInputValue {
  if (value == null) return null;
  if (timeFields.has(field)) return parseSourceTimestamp(value, offset);
  if (moneyFields.has(field)) {
    if (typeof value !== "string") throw new Error("legacy synchronization amount is not decimal text");
    return parseLegacyCents(value);
  }
  if (field === "emailSent") {
    if (value !== true && value !== false && value !== 0 && value !== 1) throw new Error("legacy synchronization boolean is invalid");
    return Number(value);
  }
  if (field === "providerResult" || field === "params") return typeof value === "string" ? JSON.stringify(JSON.parse(value)) : JSON.stringify(value);
  if (integerFields.has(field) || (field === "id" && typeof value === "number")) {
    if (!Number.isSafeInteger(value)) throw new Error("legacy synchronization integer is invalid");
    return Number(value);
  }
  if (typeof value !== "string" || value.length > 1024 * 1024) throw new Error("legacy synchronization field is invalid");
  return value;
}

export function mappedLegacyRow(kind: keyof typeof legacyMappings, row: LegacyRow, offset: number): Mapping {
  return Object.fromEntries(Object.entries(legacyMappings[kind].columns).filter(([field]) => Object.hasOwn(row, field))
    .map(([field, column]) => [column, columnValue(field, row[field], offset)]));
}

export function verifyLegacyOrder(db: DatabaseSync, row: LegacyRow): void {
  const stored = db.prepare(`SELECT o.merchant_id,o.out_trade_no,o.money_cents,
    EXISTS(SELECT 1 FROM epay_alipay_intents i WHERE i.trade_no=o.trade_no) +
    EXISTS(SELECT 1 FROM epay_wechat_intents i WHERE i.trade_no=o.trade_no) AS native
    FROM epay_orders o WHERE o.trade_no=?`).get(String(row.tradeNo));
  if (!stored || Number(stored.native) || Number(stored.merchant_id) !== row.merchantId || stored.out_trade_no !== row.outTradeNo || typeof row.money !== "string" || Number(stored.money_cents) !== parseLegacyCents(row.money)) throw new Error("legacy synchronization target order ownership or amount differs");
}

export function projectLegacyLiabilities(tables: LegacyTables, payment: unknown, offset: number) {
  const main = payment as { merchants: LegacyRow[]; orders: LegacyRow[] };
  if (!Array.isArray(main.merchants) || !Array.isArray(main.orders)) throw new Error("legacy synchronization main source is incomplete");
  const time = (value: unknown) => value == null ? null : parseSourceTimestamp(value, offset);
  return main.merchants.map(merchant => {
    const bps = Number(merchant.feeRate) * 10000;
    if (!Number.isFinite(bps) || Math.abs(bps - Math.round(bps)) > 1e-8) throw new Error("legacy synchronization fee precision differs");
    return { mainMerchantId: String(merchant.id), mainApiId: String(merchant.apiId), feeBps: Math.round(bps), project(merchantId: number) {
      const audit = auditLegacyDashboardBalance({ mainAvailableCents: 0, mainFrozenCents: 0, feeBps: Math.round(bps),
        mainOrders: main.orders.filter(row => row.merchantId === merchant.id).map(row => ({ id: String(row.id), merchantOrderId: String(row.merchantOrderId), amountCents: Number(row.amountCents), status: String(row.status), createdAt: Date.parse(String(row.createdAt)) })),
        gatewayOrders: tables.Order.filter(row => row.merchantId === merchantId).map(row => ({ tradeNo: String(row.tradeNo), merchantOrderId: String(row.outTradeNo), amountCents: parseLegacyCents(String(row.money)), receivedCents: row.getMoney == null ? null : parseLegacyCents(String(row.getMoney)), paidAt: time(row.paidAt), createdAt: time(row.createdAt)!, status: String(row.status) })),
        invoiceApplications: tables.InvoiceApplication.filter(row => row.merchantId === merchantId).map(row => ({ id: String(row.id), feeCents: Number(row.feeCents), status: String(row.status) })),
      });
      if (audit.issues.matchedOrderDifferences || audit.issues.duplicateMainOrderNumbers || audit.issues.roundingDifferences) throw new Error("legacy synchronization liability requires reconciliation");
      return audit.fullAvailableCents;
    } };
  });
}
