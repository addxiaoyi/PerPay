import type { DatabaseSync } from "node:sqlite";
import type { InvoiceRow } from "./store.ts";

export function invoiceTable(row: Pick<InvoiceRow, "kind">): "epay_tax_invoice_requests" | "epay_fee_invoice_requests" {
  return row.kind === "platform-fee" ? "epay_fee_invoice_requests" : "epay_tax_invoice_requests";
}
export function receiptTable(row: Pick<InvoiceRow, "kind">): "epay_tax_invoice_provider_receipts" | "epay_fee_invoice_provider_receipts" {
  return row.kind === "platform-fee" ? "epay_fee_invoice_provider_receipts" : "epay_tax_invoice_provider_receipts";
}
export function savedReceipt(sql: DatabaseSync, requestNo: string): string | undefined {
  const row = sql.prepare(`SELECT invoice_no FROM epay_tax_invoice_provider_receipts WHERE request_no=?
    UNION ALL SELECT invoice_no FROM epay_fee_invoice_provider_receipts WHERE request_no=?`).get(requestNo, requestNo);
  return row ? String(row.invoice_no) : undefined;
}
export function receiptNumberUsed(sql: DatabaseSync, requestNo: string, invoiceNo: string): boolean {
  return Boolean(sql.prepare(`SELECT 1 FROM epay_tax_invoice_provider_receipts WHERE invoice_no=? AND request_no<>?
    UNION ALL SELECT 1 FROM epay_fee_invoice_provider_receipts WHERE invoice_no=? AND request_no<>?
    UNION ALL SELECT 1 FROM epay_tax_invoice_requests WHERE invoice_no=? AND request_no<>?
    UNION ALL SELECT 1 FROM epay_fee_invoice_requests WHERE invoice_no=? AND request_no<>?`).get(invoiceNo, requestNo, invoiceNo, requestNo, invoiceNo, requestNo, invoiceNo, requestNo));
}
export function saveReceipt(sql: DatabaseSync, requestNo: string, invoiceNo: string, now: number): void {
  const previous = savedReceipt(sql, requestNo);
  if (previous) {
    if (previous !== invoiceNo) throw new Error("fa-piao invoice receipt conflicts with the saved invoice");
    return;
  }
  if (receiptNumberUsed(sql, requestNo, invoiceNo)) throw new Error("invoice number already used");
  const customer = sql.prepare("SELECT 1 FROM epay_tax_invoice_requests WHERE request_no=?").get(requestNo);
  const fee = sql.prepare("SELECT 1 FROM epay_fee_invoice_requests WHERE request_no=?").get(requestNo);
  if (Boolean(customer) === Boolean(fee)) throw new Error("invoice receipt request identity is unavailable or ambiguous");
  const table = customer ? "epay_tax_invoice_provider_receipts" : "epay_fee_invoice_provider_receipts";
  sql.prepare(`INSERT INTO ${table} VALUES(?,'fa-piao',?,?)`).run(requestNo, invoiceNo, now);
}
