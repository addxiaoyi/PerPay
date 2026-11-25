import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { appendAuditEvent } from "../database/identity-store.ts";
import { InsufficientBalance, BalanceConflict, readLiveBalance } from "../epay-compat/live-balance.ts";
import { invoiceTime, type InvoiceAccess, type InvoiceDatabase } from "./model.ts";
import { requireInvoiceWriter, requireInvoiceAccess } from "./store.ts";

export const INVOICE_YEAR_PRICE_CENTS = 10_000;
export const INVOICE_YEAR_DAYS = 365;
const YEAR_MS = INVOICE_YEAR_DAYS * 86_400_000;
export const invoiceSubscriptionInput = z.object({ requestId: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/),
  expectedBalanceVersion: z.number().int().safe().nonnegative(), expectedValidUntil: z.number().int().safe().nonnegative(),
  acknowledgePendingIssuance: z.boolean().default(false) }).strict();

export function readInvoiceSubscription(sql: DatabaseSync, merchantId: number, now: number) {
  const row = sql.prepare("SELECT valid_until,version FROM epay_invoice_subscriptions WHERE merchant_id=?").get(merchantId);
  const validUntil = Number(row?.valid_until ?? 0), version = Number(row?.version ?? 0);
  if (!Number.isSafeInteger(validUntil) || !Number.isSafeInteger(version)) throw new Error("invoice subscription state is invalid");
  return { active: validUntil > now, validUntil, version, priceCents: INVOICE_YEAR_PRICE_CENTS, durationDays: INVOICE_YEAR_DAYS };
}
export function purchaseInvoiceSubscription(database: InvoiceDatabase, access: InvoiceAccess, input: unknown, now: number) {
  const command = invoiceSubscriptionInput.parse(input); invoiceTime(now);
  return database.write(sql => {
    requireInvoiceWriter(sql, access);
    const previous = sql.prepare("SELECT * FROM epay_invoice_subscription_receipts WHERE merchant_id=? AND request_id=?").get(access.epayMerchantId, command.requestId);
    if (previous) {
      if (previous.actor_id !== access.userId || Number(previous.expected_balance_version) !== command.expectedBalanceVersion || Number(previous.expected_valid_until) !== command.expectedValidUntil)
        throw new BalanceConflict("invoice subscription request ID conflicts");
      return { receiptId: String(previous.receipt_id), duplicate: true, subscription: readInvoiceSubscription(sql, access.epayMerchantId, now), balance: readLiveBalance(sql, access.epayMerchantId) };
    }
    const balance = readLiveBalance(sql, access.epayMerchantId), current = readInvoiceSubscription(sql, access.epayMerchantId, now);
    if (balance.version !== command.expectedBalanceVersion || current.validUntil !== command.expectedValidUntil) throw new BalanceConflict("subscription or balance changed");
    if (balance.availableCents < INVOICE_YEAR_PRICE_CENTS) throw new InsufficientBalance("invoice subscription requires 100 yuan available balance");
    const startsAt = Math.max(now, current.validUntil), validUntil = startsAt + YEAR_MS;
    invoiceTime(validUntil);
    const receiptId = randomUUID(), entryId = `invoice_subscription:${receiptId}`;
    sql.prepare(`INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,frozen_delta_cents,reason,actor_id,occurred_at,source)
      VALUES(?,?,'invoice_subscription',?,0,'开票服务年费',?,?,'perpay_epay')`).run(entryId, access.epayMerchantId, -INVOICE_YEAR_PRICE_CENTS, access.userId!, now);
    sql.prepare("INSERT INTO epay_invoice_subscription_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(receiptId, access.epayMerchantId, command.requestId, access.userId!, INVOICE_YEAR_PRICE_CENTS, startsAt, validUntil, entryId, command.expectedBalanceVersion, command.expectedValidUntil, now, YEAR_MS);
    sql.prepare(`INSERT INTO epay_invoice_subscriptions VALUES(?,?,?,?) ON CONFLICT(merchant_id) DO UPDATE SET valid_until=excluded.valid_until,version=excluded.version,last_receipt_id=excluded.last_receipt_id`)
      .run(access.epayMerchantId, validUntil, current.version + 1, receiptId);
    const after = readLiveBalance(sql, access.epayMerchantId);
    if (after.availableCents !== balance.availableCents - INVOICE_YEAR_PRICE_CENTS || after.version !== balance.version + 1) throw new Error("invoice annual fee did not post exactly once");
    appendAuditEvent(sql, { occurredAt: now, actorType: access.role === "admin" ? "ADMIN" : "SYSTEM", actorId: access.userId!, action: "invoice.subscription.purchased", outcome: "SUCCESS",
      subjectType: "epay_merchant", subjectId: String(access.epayMerchantId), details: { receiptId, priceCents: INVOICE_YEAR_PRICE_CENTS, validUntil, preopenAcknowledged: command.acknowledgePendingIssuance } });
    return { receiptId, duplicate: false, subscription: readInvoiceSubscription(sql, access.epayMerchantId, now), balance: after };
  });
}
export function subscriptionSession(database: InvoiceDatabase, access: InvoiceAccess, now: number) {
  return database.read(sql => { requireInvoiceAccess(sql, access); return { subscription: readInvoiceSubscription(sql, access.epayMerchantId, now), balance: readLiveBalance(sql, access.epayMerchantId) }; });
}
