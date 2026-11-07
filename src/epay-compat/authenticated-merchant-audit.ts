import { auditMerchantSnapshots } from "./merchant-audit.ts";
import { auditOrderLinks } from "./order-link-audit.ts";

type Row = Record<string, unknown>;
type Tables = Record<"Merchant" | "MerchantBinding" | "Order" | "Invoice" | "InvoiceApplication", Row[]>;

function text(row: Row, key: string): string {
  if (typeof row[key] !== "string" || !row[key]) throw new Error(`invalid snapshot ${key}`);
  return row[key];
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if ((typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new Error(`invalid snapshot ${key}`);
  return Number(value);
}

function optionalText(row: Row, key: string): string | null {
  if (!Object.hasOwn(row, key)) throw new Error(`missing snapshot ${key}`);
  if (row[key] === null) return null;
  if (typeof row[key] !== "string") throw new Error(`invalid snapshot ${key}`);
  return row[key];
}

// The result contains counts only. Matching candidates do not establish ownership.
export function auditAuthenticatedMerchantSnapshot(payment: unknown, tables: Tables) {
  for (const name of ["Merchant", "MerchantBinding", "Order", "Invoice", "InvoiceApplication"] as const) {
    if (!Array.isArray(tables[name])) throw new Error(`missing snapshot table: ${name}`);
  }
  const merchants = tables.Merchant.map(row => ({ id: integer(row, "id"), money: text(row, "money") }));
  const bindings = tables.MerchantBinding.map(row => ({ mainMerchantId: text(row, "mainMerchantId"), mainApiId: text(row, "mainApiId"), epayMerchantId: integer(row, "epayMerchantId") }));
  const orders = tables.Order.map(row => ({ tradeNo: text(row, "tradeNo"), outTradeNo: text(row, "outTradeNo"), apiTradeNo: optionalText(row, "apiTradeNo"), merchantId: integer(row, "merchantId"), money: text(row, "money"), status: text(row, "status") }));
  const invoice = (row: Row) => ({ id: text(row, "id"), tradeNo: text(row, "tradeNo"), merchantId: integer(row, "merchantId") });
  const applications = tables.InvoiceApplication.map(row => ({ ...invoice(row), outTradeNo: text(row, "outTradeNo"), feeCents: row.feeCents, status: row.status }));
  const report = auditMerchantSnapshots({ mainPayment: payment, merchants, bindings, orders, invoices: tables.Invoice.map(row => ({ ...invoice(row), amount: row.amount })), invoiceApplications: applications });
  if (!payment || typeof payment !== "object" || Array.isArray(payment) || !Array.isArray((payment as Row).orders)) throw new Error("missing main orders");
  const links = auditOrderLinks(bindings, (payment as { orders: Parameters<typeof auditOrderLinks>[1] }).orders, orders);
  const counts = (issues: readonly { code: string }[]) => {
    const result: Record<string, number> = Object.create(null);
    for (const issue of issues) result[issue.code] = (result[issue.code] ?? 0) + 1;
    return result;
  };
  return {
    merchants: report.summaries.map(row => ({ mainMerchantPresent: row.balance !== null, epayBalancePresent: row.epayRecordedBalanceCents !== null, orders: row.orderCount, paidOrders: row.paidOrderCount, invoices: row.invoiceCount, invoiceApplications: row.invoiceApplicationCount })),
    issues: counts(report.issues),
    orderLinks: { matched: links.matched, issues: counts(links.issues), projectionCandidates: links.projectionCandidates, providerCandidates: links.providerCandidates, providerCrossMerchantLeads: links.providerCrossMerchantLeads },
    snapshotsComparable: false as const,
    financiallyReconciled: false as const,
    productionReady: false as const,
  };
}
