import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { appendAuditEvent } from "../database/identity-store.ts";
import { InvoiceError, invoiceTime, parseInvoiceObservation, type InvoiceAccess, type InvoiceDatabase, type InvoiceProvider } from "./model.ts";
import { invoiceIssue, invoiceRow, latestInvoice, publicInvoice, requireInvoiceAccess, type InvoiceRow } from "./store.ts";
import { recordInvoiceObservationSql } from "./observations.ts";
import { receiptNumberUsed, savedReceipt, saveReceipt } from "./receipts.ts";

const REVIEW_TTL_MS = 5 * 60_000;
const reviewInput = z.object({
  applicationNo: z.string().regex(/^[a-f0-9]{32}$/),
  invoiceNo: z.string().regex(/^\d{20}$/),
  evidenceRef: z.string().trim().min(6).max(240).regex(/^[^\x00-\x1f\x7f]+$/),
}).strict();
const confirmInput = reviewInput.extend({
  reviewToken: z.string().max(120).regex(/^\d{13}\.[A-Za-z0-9_-]{43}$/),
  originalApplicationConfirmed: z.literal(true),
  blueInvoiceConfirmed: z.literal(true),
}).strict();
type Review = z.infer<typeof reviewInput>;
const conflict = (): never => { throw new InvoiceError("invoice_reconcile_conflict", 409, "invoice reconciliation state changed or conflicts"); };

export function createInvoiceReconciliation(options: {
  database: InvoiceDatabase & { instanceId(): string }; masterKey: Uint8Array; provider: InvoiceProvider; clock?: (() => number) | undefined;
}) {
  const { database, provider } = options;
  const key = Buffer.from(hkdfSync("sha256", options.masterKey, database.instanceId(), "perpay:invoice-review:v1", 32));
  const now = () => invoiceTime((options.clock ?? Date.now)());
  function requireCandidate(sql: DatabaseSync, access: InvoiceAccess, id: string, review: Review): InvoiceRow {
    requireInvoiceAccess(sql, access, true);
    const row = invoiceRow(sql, id, access.epayMerchantId);
    if (provider.kind !== "fa-piao" || !provider.reviewInvoice || invoiceIssue(row).profile.provider !== "fa-piao")
      throw new InvoiceError("invoice_reconcile_unavailable", 503, "invoice provider does not support reconciliation");
    if (!["UNKNOWN", "PROCESSING"].includes(row.status) || row.application_no !== review.applicationNo
        || (!row.kind && latestInvoice(sql, row.merchant_id, row.trade_no)?.invoice_id !== row.invoice_id)) conflict();
    const receipt = savedReceipt(sql, row.request_no);
    if (receipt && receipt !== review.invoiceNo) conflict();
    if (receiptNumberUsed(sql, row.request_no, review.invoiceNo)) conflict();
    return row;
  }
  function signature(access: InvoiceAccess, row: InvoiceRow, review: Review, expiry: number): string {
    const snapshot = createHash("sha256").update(JSON.stringify(row)).digest("hex");
    return createHmac("sha256", key).update(JSON.stringify([access.userId, access.merchantId, access.mainApiId,
      access.epayMerchantId, row.invoice_id, snapshot, review.applicationNo, review.invoiceNo, review.evidenceRef, expiry])).digest("base64url");
  }
  async function verify(row: InvoiceRow, review: Review) {
    try {
      const observation = parseInvoiceObservation(await provider.reviewInvoice!(invoiceIssue(row), review.invoiceNo));
      if (observation.status !== "ISSUED" || observation.invoiceNo !== review.invoiceNo)
        throw new InvoiceError("invoice_reconcile_unverified", 409, "original invoice could not be verified");
      return observation;
    } catch (error) {
      if (error instanceof InvoiceError) throw error;
      throw new InvoiceError("invoice_reconcile_unverified", 409, "provider verification failed; no invoice receipt was saved");
    }
  }
  return {
    async preview(access: InvoiceAccess, id: string, input: unknown) {
      const review = reviewInput.parse(input);
      const row = database.read(sql => requireCandidate(sql, access, id, review));
      await verify(row, review);
      return database.read(sql => {
        const current = requireCandidate(sql, access, id, review);
        if (JSON.stringify(current) !== JSON.stringify(row)) conflict();
        const expiresAt = now() + REVIEW_TTL_MS;
        return { ...review, invoice: publicInvoice(row), itemName: invoiceIssue(row).profile.itemName,
          taxCode: invoiceIssue(row).profile.taxCode, taxRateBps: invoiceIssue(row).profile.taxRateBps,
          expiresAt, reviewToken: `${expiresAt}.${signature(access, row, review, expiresAt)}` };
      });
    },
    async confirm(access: InvoiceAccess, id: string, input: unknown) {
      const command = confirmInput.parse(input);
      const review = reviewInput.parse({ applicationNo: command.applicationNo, invoiceNo: command.invoiceNo, evidenceRef: command.evidenceRef });
      const row = database.read(sql => requireCandidate(sql, access, id, review));
      const [expiryText, signed] = command.reviewToken.split(".");
      const expiry = Number(expiryText), checkedAt = now();
      if (!Number.isSafeInteger(expiry) || expiry <= checkedAt || expiry - checkedAt > REVIEW_TTL_MS
          || !timingSafeEqual(Buffer.from(signed!), Buffer.from(signature(access, row, review, expiry)))) conflict();
      const observation = await verify(row, review);
      return database.write(sql => {
        const current = requireCandidate(sql, access, id, review), confirmedAt = now();
        if (confirmedAt >= expiry || JSON.stringify(current) !== JSON.stringify(row)) conflict();
        saveReceipt(sql, row.request_no, review.invoiceNo, confirmedAt);
        const invoice = recordInvoiceObservationSql(sql, current, observation, confirmedAt);
        appendAuditEvent(sql, { occurredAt: confirmedAt, actorType: "ADMIN", actorId: access.userId!,
          action: "invoice.reconciled", outcome: "SUCCESS", subjectType: "tax_invoice", subjectId: id,
          details: { merchantId: access.epayMerchantId, applicationNo: review.applicationNo, invoiceNo: review.invoiceNo,
            evidenceRef: review.evidenceRef, originalApplicationConfirmed: true, blueInvoiceConfirmed: true } });
        return invoice;
      });
    },
  };
}
