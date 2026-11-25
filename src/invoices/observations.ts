import { appendAuditEvent } from "../database/identity-store.ts";
import type { DatabaseSync } from "node:sqlite";
import { invoiceTime, type InvoiceDatabase, type InvoiceObservation } from "./model.ts";
import { invoiceRow, publicInvoice, type InvoiceRow } from "./store.ts";
import { invoiceTable } from "./receipts.ts";

export function recordInvoiceObservation(database: InvoiceDatabase, row: InvoiceRow, observation: InvoiceObservation, observedAt: number, expectedUpdatedAt?: number) {
  return database.write(sql => recordInvoiceObservationSql(sql, row, observation, observedAt, expectedUpdatedAt));
}

export function recordInvoiceObservationSql(sql: DatabaseSync, row: InvoiceRow, observation: InvoiceObservation, observedAt: number, expectedUpdatedAt?: number) {
  invoiceTime(observedAt);
  const current = invoiceRow(sql, row.invoice_id, row.merchant_id);
  if (expectedUpdatedAt !== undefined && current.updated_at !== expectedUpdatedAt) return publicInvoice(current);
  if (current.status === "FAILED" || current.status === "REVERSED") return publicInvoice(current);
  if (observedAt < current.updated_at) throw new Error("invoice observation predates the request");
  if (current.status === "ISSUED" && !["ISSUED", "REVERSING", "REVERSED"].includes(observation.status)) return publicInvoice(current);
  if (current.status === "REVERSING" && !["ISSUED", "REVERSING", "REVERSED"].includes(observation.status)) return publicInvoice(current);
  if (current.status === "REVERSING" && observation.status === "ISSUED" && !observation.reversalFailed) return publicInvoice(current);
  if (current.invoice_no && observation.invoiceNo && current.invoice_no !== observation.invoiceNo) throw new Error("invoice provider number changed");
  const status = observation.status === "UNKNOWN" && current.status === "PROCESSING" ? "PROCESSING" : observation.status;
  sql.prepare(`UPDATE ${invoiceTable(current)} SET status=?,invoice_no=?,error_code=?,updated_at=? WHERE invoice_id=? AND merchant_id=?`)
    .run(status, observation.invoiceNo ?? current.invoice_no, observation.errorCode ?? null, observedAt, row.invoice_id, row.merchant_id);
  appendAuditEvent(sql, { occurredAt: observedAt, actorType: "SYSTEM", actorId: "invoice-provider", action: "invoice.observed", outcome: "SUCCESS",
    subjectType: "tax_invoice", subjectId: row.invoice_id, details: { merchantId: row.merchant_id, status } });
  return publicInvoice(invoiceRow(sql, row.invoice_id, row.merchant_id));
}
