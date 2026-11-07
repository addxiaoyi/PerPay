import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppDatabase } from "../database/database.ts";
import { appendAuditEvent } from "../database/identity-store.ts";
import { verifyMainOrderAccess } from "./main-order-access.ts";
import { readConfirmedOrder } from "./confirmed-order.ts";
import { readLiveBalance } from "./live-balance.ts";

export class MainInvoiceError extends Error {}
const text = (limit: number) => z.string().trim().min(1).max(limit).regex(/^[^\x00-\x1f\x7f]+$/);
const invoiceInput = z.object({ title: text(160), taxId: text(64), email: z.string().trim().max(254).email() }).strict();

export function requestMainInvoice(database: Pick<AppDatabase, "write">, request: { orderId: string; token: unknown; input: unknown; feeCents: number | undefined; now: number }) {
  const parsed = invoiceInput.safeParse(request.input);
  if (!parsed.success) throw new MainInvoiceError("invoice_validation_error");
  const { title, taxId, email } = parsed.data, { feeCents, now } = request;
  if (feeCents === undefined || !Number.isSafeInteger(feeCents) || feeCents < 0) throw new MainInvoiceError("invoice_fee_unconfigured");
  return database.write(sql => {
    const access = verifyMainOrderAccess(sql, request.token, "invoice:create", request.orderId, now);
    if (!access) throw new MainInvoiceError("invoice_access_denied");
    if (!readConfirmedOrder(sql, access.tradeNo, access.merchantId)) throw new MainInvoiceError("invoice_not_ready");
    const order = sql.prepare("SELECT out_trade_no FROM epay_orders WHERE trade_no=? AND merchant_id=?").get(access.tradeNo, access.merchantId)!;
    const issued = sql.prepare("SELECT 1 FROM epay_invoices WHERE merchant_id=? AND trade_no=? LIMIT 1").get(access.merchantId, access.tradeNo);
    if (issued) throw new MainInvoiceError("invoice_already_requested");
    const previous = sql.prepare("SELECT * FROM epay_invoice_applications WHERE merchant_id=? AND trade_no=?").get(access.merchantId, access.tradeNo);
    const before = readLiveBalance(sql, access.merchantId);
    if (previous) {
      if (previous.title !== title || previous.tax_id !== taxId || previous.email !== email || previous.status === "rejected") throw new MainInvoiceError("invoice_already_requested");
      return { duplicate: true, application: { id: String(previous.application_id), orderId: access.orderId, merchantId: access.mainMerchantId, title, taxId, email,
        feeCents: Number(previous.fee_cents), status: String(previous.status), createdAt: new Date(Number(previous.created_at)).toISOString() }, balance: before };
    }
    if (before.availableCents < feeCents) throw new MainInvoiceError("invoice_fee_insufficient_balance");
    const id = randomUUID();
    sql.prepare(`INSERT INTO epay_invoice_applications(application_id,merchant_id,trade_no,out_trade_no,title,tax_id,email,fee_cents,status,created_at,updated_at,email_sent)
      VALUES(?,?,?,?,?,?,?,?,'pending',?,?,0)`).run(id, access.merchantId, access.tradeNo, order.out_trade_no!, title, taxId, email, feeCents, now, now);
    if (feeCents > 0) sql.prepare(`INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,frozen_delta_cents,reason,actor_id,occurred_at,source)
      VALUES(?,?,'invoice_fee',?,0,?,NULL,?,'perpay_epay')`).run(`epay_invoice:${id}`, access.merchantId, -feeCents, `发票申请 ${id}`, now);
    const after = readLiveBalance(sql, access.merchantId);
    if (after.availableCents !== before.availableCents - feeCents || after.version !== before.version + (feeCents > 0 ? 1 : 0)) throw new Error("invoice fee did not post exactly once");
    appendAuditEvent(sql, { occurredAt: now, actorType: "SYSTEM", actorId: "order-access", action: "epay.invoice.requested", outcome: "SUCCESS", subjectType: "epay_merchant", subjectId: String(access.merchantId), details: { applicationId: id, orderId: access.orderId, feeCents } });
    return { duplicate: false, application: { id, orderId: access.orderId, merchantId: access.mainMerchantId, title, taxId, email, feeCents, status: "pending", createdAt: new Date(now).toISOString() }, balance: after };
  });
}
