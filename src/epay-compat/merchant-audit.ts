import { auditMainLedger } from "./main-ledger-audit.ts";
import { auditMainSettlements } from "./main-settlement-audit.ts";
import { parseLegacyCents } from "./money.ts";

interface Merchant { readonly id: number; readonly money?: unknown }
interface Binding { readonly mainMerchantId: string; readonly epayMerchantId: number; readonly mainApiId?: string }
interface Order { readonly tradeNo: string; readonly outTradeNo?: string; readonly merchantId: number; readonly money: string; readonly status: string }
interface Invoice { readonly id: string; readonly tradeNo: string; readonly merchantId: number; readonly outTradeNo?: string; readonly amount?: unknown; readonly feeCents?: unknown; readonly status?: unknown }
const ORDER_STATUSES = new Set(["PENDING", "PAID", "REFUNDED", "FROZEN", "CLOSED"]);

export interface MerchantAuditInput {
  readonly mainPayment: unknown;
  readonly merchants: readonly Merchant[];
  readonly bindings: readonly Binding[];
  readonly orders: readonly Order[];
  readonly invoices: readonly Invoice[];
  readonly invoiceApplications?: readonly Invoice[];
}

export function auditMerchantSnapshots(input: MerchantAuditInput) {
  const main = auditMainLedger(input.mainPayment);
  const mainById = new Map(main.balances.map((balance) => [balance.merchantId, balance]));
  const payment = input.mainPayment as { merchants: Array<{ id: string; apiId?: unknown }> };
  const apiByMerchant = new Map(payment.merchants.map((merchant) => [merchant.id, merchant.apiId]));
  const apiOwners = new Map<string, string[]>();
  for (const merchant of payment.merchants) {
    if (typeof merchant.apiId !== "string" || !merchant.apiId) continue;
    const owners = apiOwners.get(merchant.apiId) ?? [];
    owners.push(merchant.id);
    apiOwners.set(merchant.apiId, owners);
  }
  const merchants = new Set<number>();
  const merchantBalances = new Map<number, number | null>();
  const issues: Array<{ code: string; id: string }> = [];
  if (input.invoiceApplications === undefined) issues.push({ code: "invoice_applications_unavailable", id: "snapshot" });
  else if (!Array.isArray(input.invoiceApplications)) throw new Error("invalid EPay invoice applications");
  for (const merchant of input.merchants) {
    if (!Number.isSafeInteger(merchant.id) || merchant.id < 1 || merchants.has(merchant.id)) throw new Error("invalid or duplicate EPay merchant ID");
    merchants.add(merchant.id);
    if (typeof merchant.money !== "string") {
      merchantBalances.set(merchant.id, null);
      issues.push({ code: "epay_balance_unavailable", id: String(merchant.id) });
      continue;
    }
    try { merchantBalances.set(merchant.id, parseLegacyCents(merchant.money)); }
    catch {
      merchantBalances.set(merchant.id, null);
      issues.push({ code: "epay_balance_invalid", id: String(merchant.id) });
    }
  }
  const boundMain = new Set<string>();
  const boundEPay = new Set<number>();
  const summaries = input.bindings.map((binding) => {
    if (!binding.mainMerchantId || !Number.isSafeInteger(binding.epayMerchantId) || binding.epayMerchantId < 1 || boundMain.has(binding.mainMerchantId) || boundEPay.has(binding.epayMerchantId)) throw new Error("invalid or duplicate merchant binding");
    boundMain.add(binding.mainMerchantId);
    boundEPay.add(binding.epayMerchantId);
    const balance = mainById.get(binding.mainMerchantId);
    if (!balance) issues.push({ code: "missing_main_merchant", id: binding.mainMerchantId });
    if (!merchants.has(binding.epayMerchantId)) issues.push({ code: "missing_epay_merchant", id: String(binding.epayMerchantId) });
    if (binding.mainApiId === undefined || binding.mainApiId === null) {
      issues.push({ code: "binding_api_id_unavailable", id: binding.mainMerchantId });
    } else {
      if (typeof binding.mainApiId !== "string" || !binding.mainApiId) throw new Error("invalid merchant binding API ID");
      const owners = apiOwners.get(binding.mainApiId) ?? [];
      if (owners.length > 1) issues.push({ code: "duplicate_main_api_id", id: binding.mainMerchantId });
      if (balance && apiByMerchant.get(binding.mainMerchantId) !== binding.mainApiId) issues.push({ code: "binding_api_id_mismatch", id: binding.mainMerchantId });
      if (!balance && owners.length === 1) issues.push({ code: "missing_binding_api_id_matches_other_merchant", id: binding.mainMerchantId });
      if (!balance && owners.length === 0) issues.push({ code: "missing_binding_api_id_not_found", id: binding.mainMerchantId });
    }
    return { mainMerchantId: binding.mainMerchantId, epayMerchantId: binding.epayMerchantId, balance: balance ?? null, epayRecordedBalanceCents: merchantBalances.get(binding.epayMerchantId) ?? null, orderCount: 0, paidOrderCount: 0, paidOrderCents: 0, invoiceCount: 0, invoiceApplicationCount: 0 };
  });
  const byEPay = new Map(summaries.map((summary) => [summary.epayMerchantId, summary]));
  const orders = new Map<string, Order>();
  const merchantOrderNumbers = new Map<number, Map<string, string[]>>();
  for (const order of input.orders) {
    if (!order.tradeNo || orders.has(order.tradeNo) || !Number.isSafeInteger(order.merchantId) || order.merchantId < 1 || typeof order.money !== "string" || typeof order.status !== "string" || !order.status) throw new Error("invalid or duplicate EPay order");
    const cents = parseLegacyCents(order.money);
    if (cents < 0) throw new Error("negative EPay order amount");
    orders.set(order.tradeNo, order);
    if (typeof order.outTradeNo !== "string" || !order.outTradeNo) {
      issues.push({ code: "merchant_order_number_unavailable", id: order.tradeNo });
    } else {
      let numbers = merchantOrderNumbers.get(order.merchantId);
      if (!numbers) { numbers = new Map(); merchantOrderNumbers.set(order.merchantId, numbers); }
      const trades = numbers.get(order.outTradeNo) ?? [];
      trades.push(order.tradeNo);
      numbers.set(order.outTradeNo, trades);
    }
    if (!ORDER_STATUSES.has(order.status)) issues.push({ code: "unknown_order_status", id: order.tradeNo });
    if (order.status === "PAID" && cents === 0) issues.push({ code: "zero_amount_paid_order", id: order.tradeNo });
    if (!merchants.has(order.merchantId)) issues.push({ code: "order_missing_merchant", id: order.tradeNo });
    const summary = byEPay.get(order.merchantId);
    if (!summary) { issues.push({ code: "unbound_order", id: order.tradeNo }); continue; }
    summary.orderCount++;
    if (order.status === "PAID") {
      summary.paidOrderCount++;
      summary.paidOrderCents += cents;
      if (!Number.isSafeInteger(summary.paidOrderCents)) throw new Error("paid order total exceeds safe integer range");
    }
  }
  for (const numbers of merchantOrderNumbers.values()) {
    for (const trades of numbers.values()) {
      if (trades.length > 1) for (const tradeNo of trades) issues.push({ code: "duplicate_merchant_order_number", id: tradeNo });
    }
  }
  for (const [kind, records] of [["invoice", input.invoices], ["invoice_application", input.invoiceApplications ?? []]] as const) {
    const ids = new Set<string>();
    for (const invoice of records) {
      if (!invoice.id || ids.has(invoice.id) || !invoice.tradeNo || !Number.isSafeInteger(invoice.merchantId) || invoice.merchantId < 1) throw new Error(`invalid or duplicate EPay ${kind}`);
      ids.add(invoice.id);
      const order = orders.get(invoice.tradeNo);
      if (!order) issues.push({ code: `${kind}_missing_order`, id: invoice.id });
      else if (order.merchantId !== invoice.merchantId) issues.push({ code: `${kind}_merchant_mismatch`, id: invoice.id });
      if (kind === "invoice") {
        if (typeof invoice.amount !== "string") {
          issues.push({ code: "invoice_amount_unavailable", id: invoice.id });
        } else {
          try {
            const invoiceCents = parseLegacyCents(invoice.amount);
            if (invoiceCents < 0) issues.push({ code: "invoice_amount_invalid", id: invoice.id });
            else if (order && invoiceCents !== parseLegacyCents(order.money)) issues.push({ code: "invoice_order_amount_difference", id: invoice.id });
          } catch {
            issues.push({ code: "invoice_amount_invalid", id: invoice.id });
          }
        }
      }
      if (kind === "invoice_application" && order) {
        if (typeof invoice.outTradeNo !== "string" || !invoice.outTradeNo || typeof order.outTradeNo !== "string" || !order.outTradeNo) {
          issues.push({ code: "invoice_application_order_reference_unavailable", id: invoice.id });
        } else if (invoice.outTradeNo !== order.outTradeNo) {
          issues.push({ code: "invoice_application_order_reference_mismatch", id: invoice.id });
        }
      }
      if (kind === "invoice_application") {
        if (invoice.feeCents === undefined || invoice.feeCents === null) issues.push({ code: "invoice_application_fee_unavailable", id: invoice.id });
        else if ((typeof invoice.feeCents !== "number" && (typeof invoice.feeCents !== "string" || !/^\d+$/.test(invoice.feeCents))) || !Number.isSafeInteger(Number(invoice.feeCents)) || Number(invoice.feeCents) < 0) issues.push({ code: "invoice_application_fee_invalid", id: invoice.id });
        if (typeof invoice.status !== "string" || !invoice.status) issues.push({ code: "invoice_application_status_unavailable", id: invoice.id });
        else if (!["PENDING", "ISSUING", "ISSUED", "UNKNOWN", "FAILED"].includes(invoice.status)) issues.push({ code: "invoice_application_status_unrecognized", id: invoice.id });
      }
      const summary = byEPay.get(invoice.merchantId);
      if (!summary) issues.push({ code: `unbound_${kind}`, id: invoice.id });
      else if (kind === "invoice") summary.invoiceCount++;
      else summary.invoiceApplicationCount++;
    }
  }
  for (const id of merchants) if (!boundEPay.has(id)) issues.push({ code: "unbound_epay_merchant", id: String(id) });
  for (const id of mainById.keys()) if (!boundMain.has(id)) issues.push({ code: "unbound_main_merchant", id });
  if (main.missingMerchantReferences) issues.push({ code: "orphan_main_ledger_entries", id: String(main.missingMerchantReferences) });
  if (main.unsupportedFeePrecision) issues.push({ code: "unsupported_main_fee_precision", id: String(main.unsupportedFeePrecision) });
  if (main.summaryMismatches === null) issues.push({ code: "main_balance_summary_unverified", id: "snapshot" });
  if (main.summaryMismatches) issues.push({ code: "main_balance_summary_mismatch", id: String(main.summaryMismatches) });
  issues.push(...auditMainSettlements(input.mainPayment));
  return { summaries, issues, snapshotsComparable: false as const };
}
