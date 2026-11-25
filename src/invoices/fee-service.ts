import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { appendAuditEvent } from "../database/identity-store.ts";
import { readConfirmedOrder } from "../epay-compat/confirmed-order.ts";
import { InvoiceError, invoiceRequestInput, invoiceTime, parseInvoiceObservation, verifiedAuthorization,
  type InvoiceAccess, type InvoiceDatabase, type InvoiceProvider, type InvoiceObservation } from "./model.ts";
import { invoiceIssue, invoiceRow, publicInvoice, requireInvoiceAccess, requireInvoiceWriter } from "./store.ts";
import { recordInvoiceObservation, recordInvoiceObservationSql } from "./observations.ts";
import { FaPiaoError } from "./fa-piao-client.ts";
import { clearProviderState, deferFeeQueue, readProviderState, providerQueueFailure } from "./fee-queue.ts";
import { feeReadinessPreview } from "./fee-readiness.ts";
import { readInvoiceSubscription } from "./subscription.ts";

export const feeBuyerInput = z.object({
  buyerType: invoiceRequestInput.shape.buyerType, title: invoiceRequestInput.shape.title,
  taxId: invoiceRequestInput.shape.taxId, email: invoiceRequestInput.shape.email,
  expectedVersion: z.number().int().safe().nonnegative(), autoInvoice: z.boolean(),
}).strict().refine(buyer => buyer.buyerType === "ORGANIZATION" ? buyer.taxId !== "" : buyer.taxId === "", { message: "buyer tax ID differs from buyer type" });
export type FeeBuyer = Omit<z.infer<typeof feeBuyerInput>, "expectedVersion"> & { version: number };

export function storedFeeBuyer(sql: DatabaseSync, merchantId: number): FeeBuyer | null {
  const row = sql.prepare("SELECT * FROM epay_fee_invoice_buyers WHERE merchant_id=?").get(merchantId);
  if (!row) return null;
  const { expectedVersion, ...buyer } = feeBuyerInput.parse({ buyerType: row.buyer_type, title: row.title, taxId: row.tax_id,
    email: row.email, autoInvoice: Number(row.auto_invoice) === 1, expectedVersion: Number(row.version) });
  return { ...buyer, version: expectedVersion };
}

export function createFeeInvoiceService(options: { database: InvoiceDatabase; provider: InvoiceProvider; clock?: (() => number) | undefined; canIssue?: (() => boolean) | undefined }) {
  const { database, provider } = options;
  const now = () => invoiceTime((options.clock ?? Date.now)());
  function enabled() {
    return provider.kind === "fa-piao" && provider.issuanceEnabled !== false && provider.platformFees?.enabled === true
      && provider.platformFees.validUntil > now() && (options.canIssue?.() ?? true);
  }
  const readBuyer = (access: InvoiceAccess) => database.read(sql => { requireInvoiceAccess(sql, access); return storedFeeBuyer(sql, access.epayMerchantId); });
  function saveBuyer(access: InvoiceAccess, input: unknown): FeeBuyer {
    const buyer = feeBuyerInput.parse(input), updatedAt = now();
    return database.write(sql => {
      requireInvoiceWriter(sql, access);
      const current = storedFeeBuyer(sql, access.epayMerchantId);
      if ((current?.version ?? 0) !== buyer.expectedVersion) throw new InvoiceError("invoice_profile_conflict", 409, "fee invoice buyer changed");
      sql.prepare(`INSERT INTO epay_fee_invoice_buyers VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(merchant_id) DO UPDATE SET buyer_type=excluded.buyer_type,title=excluded.title,tax_id=excluded.tax_id,email=excluded.email,
          auto_invoice=excluded.auto_invoice,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
        .run(access.epayMerchantId, buyer.buyerType, buyer.title, buyer.taxId, buyer.email, Number(buyer.autoInvoice), buyer.expectedVersion + 1, access.userId!, updatedAt);
      appendAuditEvent(sql, { occurredAt: updatedAt, actorType: access.role === "admin" ? "ADMIN" : "SYSTEM", actorId: access.userId!,
        action: "fee_invoice.buyer.saved", outcome: "SUCCESS", subjectType: "epay_merchant", subjectId: String(access.epayMerchantId),
        details: { version: buyer.expectedVersion + 1, autoInvoice: buyer.autoInvoice } });
      return storedFeeBuyer(sql, access.epayMerchantId)!;
    });
  }
  function validateOrder(sql: DatabaseSync, access: InvoiceAccess, tradeNo: string, automatic: boolean) {
    requireInvoiceWriter(sql, access);
    if (!readInvoiceSubscription(sql, access.epayMerchantId, now()).active) throw new InvoiceError("invoice_subscription_required", 409, "annual invoice service subscription is required");
    const buyer = storedFeeBuyer(sql, access.epayMerchantId), order = readConfirmedOrder(sql, tradeNo, access.epayMerchantId);
    if (!buyer) throw new InvoiceError("invoice_profile_unavailable", 409, "merchant invoice buyer has not been configured");
    if (automatic && !buyer.autoInvoice) throw new InvoiceError("invoice_auto_opt_out", 409, "merchant automatic invoicing is disabled");
    if (!order) throw new InvoiceError("invoice_order_unconfirmed", 409, "fee invoice requires a verified native payment");
    const proof = sql.prepare(`SELECT fee_cents,provider_trade_no FROM epay_alipay_confirmations WHERE trade_no=? AND merchant_id=?
      UNION ALL SELECT fee_cents,provider_trade_no FROM epay_wechat_confirmations WHERE trade_no=? AND merchant_id=?
      UNION ALL SELECT fee_cents,provider_trade_no FROM epay_balance_confirmations WHERE trade_no=? AND merchant_id=?`).get(tradeNo, access.epayMerchantId, tradeNo, access.epayMerchantId, tradeNo, access.epayMerchantId);
    const fee = Number(proof?.fee_cents);
    if (!Number.isSafeInteger(fee) || fee <= 0) throw new InvoiceError("invoice_fee_unavailable", 409, "payment has no positive recorded platform fee");
    if (sql.prepare("SELECT 1 FROM epay_native_refunds WHERE trade_no=? AND status NOT IN ('REJECTED','CLOSED')").get(tradeNo))
      throw new InvoiceError("invoice_refund_conflict", 409, "fee invoice conflicts with a refund");
    if (sql.prepare("SELECT 1 FROM epay_balance_refunds WHERE trade_no=?").get(tradeNo)) throw new InvoiceError("invoice_refund_conflict", 409, "balance payment was refunded");
    const profile = provider.platformFees!.profile;
    if (buyer.title === profile.sellerName && buyer.taxId === profile.sellerTaxId)
      throw new InvoiceError("invoice_buyer_conflict", 409, "platform cannot invoice its own merchant entity");
    return { buyer, order, fee, providerTradeNo: String(proof!.provider_trade_no) };
  }
  async function create(access: InvoiceAccess, tradeNo: string, automatic = false) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tradeNo)) throw new InvoiceError("invoice_invalid", 400, "invalid fee invoice payment");
    database.read(sql => requireInvoiceWriter(sql, access));
    if (!enabled()) throw new InvoiceError("invoice_disabled", 503, "platform fee invoicing is disabled");
    const previous = database.read(sql => sql.prepare("SELECT invoice_id FROM epay_fee_invoice_requests WHERE trade_no=? AND merchant_id=?").get(tradeNo, access.epayMerchantId));
    if (previous) return database.read(sql => publicInvoice(invoiceRow(sql, String(previous.invoice_id), access.epayMerchantId)));
    const profile = provider.platformFees!.profile;
    database.read(sql => validateOrder(sql, access, tradeNo, automatic));
    // Probe before reservation; the durable request is created only once the registered biller is available.
    let authorization: Awaited<ReturnType<InvoiceProvider["authorize"]>>;
    try { authorization = await provider.authorize(profile); }
    catch (error) { throw new InvoiceError(error instanceof FaPiaoError ? error.code : "invoice_provider_unavailable", 503, "fee invoice authorization is unavailable"); }
    if (!verifiedAuthorization(profile, authorization)) throw new InvoiceError(authorization.reason && /^fapiao_[a-z0-9_-]{1,70}$/.test(authorization.reason) ? authorization.reason : "invoice_not_authorized", 409, "platform invoice biller is not authorized");
    const reservation = database.write(sql => {
      requireInvoiceWriter(sql, access);
      if (!enabled()) throw new InvoiceError("invoice_disabled", 503, "platform fee invoicing was disabled");
      const prior = sql.prepare("SELECT invoice_id FROM epay_fee_invoice_requests WHERE trade_no=? AND merchant_id=?").get(tradeNo, access.epayMerchantId);
      if (prior) return { fresh: false, row: invoiceRow(sql, String(prior.invoice_id), access.epayMerchantId) };
      const { buyer, order, fee, providerTradeNo } = validateOrder(sql, access, tradeNo, automatic);
      const id = randomUUID(), requestNo = randomUUID().replaceAll("-", ""), requestedAt = now();
      sql.prepare(`INSERT INTO epay_fee_invoice_requests(invoice_id,request_no,application_no,attempt,request_id,merchant_id,trade_no,amount_cents,
        payment_type,provider_trade_no,profile_json,buyer_type,title,tax_id,email,requested_by,status,created_at,updated_at)
        VALUES(?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,'UNKNOWN',?,?)`)
        .run(id, requestNo, requestNo, `fee:${requestNo}`, access.epayMerchantId, tradeNo, fee, order.type_code!, providerTradeNo,
          JSON.stringify(profile), buyer.buyerType, buyer.title, buyer.taxId, buyer.email, access.userId!, requestedAt, requestedAt);
      appendAuditEvent(sql, { occurredAt: requestedAt, actorType: access.role === "admin" ? "ADMIN" : "SYSTEM", actorId: access.userId!,
        action: "fee_invoice.requested", outcome: "SUCCESS", subjectType: "tax_invoice", subjectId: id,
        details: { merchantId: access.epayMerchantId, tradeNo, amountCents: fee } });
      return { fresh: true, row: invoiceRow(sql, id, access.epayMerchantId) };
    });
    if (!reservation.fresh) return publicInvoice(reservation.row);
    if (!enabled()) return recordInvoiceObservation(database, reservation.row, { status: "FAILED", errorCode: "invoice_not_submitted" }, now());
    let observation: InvoiceObservation;
    try { observation = parseInvoiceObservation(await provider.issue(invoiceIssue(reservation.row))); }
    catch (error) { observation = { status: "UNKNOWN", errorCode: error instanceof FaPiaoError ? error.code : "invoice_provider_unavailable" }; }
    return database.write(sql => {
      const observedAt = now(), invoice = recordInvoiceObservationSql(sql, reservation.row, observation, observedAt);
      if (!observation.errorCode || !providerQueueFailure(observation.errorCode)) clearProviderState(sql, observedAt);
      return invoice;
    });
  }
  function candidates(limit = 20) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error("invalid fee invoice batch size");
    return database.read(sql => sql.prepare(`SELECT o.trade_no,o.merchant_id,b.main_merchant_id,b.main_api_id
      FROM epay_orders o JOIN epay_fee_invoice_buyers p ON p.merchant_id=o.merchant_id AND p.auto_invoice=1
      JOIN epay_merchant_bindings b ON b.epay_merchant_id=o.merchant_id JOIN epay_merchant_accounts m ON m.merchant_id=o.merchant_id AND m.enabled=1
      JOIN epay_invoice_subscriptions subscription ON subscription.merchant_id=o.merchant_id AND subscription.valid_until>?
      LEFT JOIN system_metadata q ON q.key='epay_fee_invoice_queue:'||o.trade_no
      WHERE o.status='PAID' AND NOT EXISTS(SELECT 1 FROM epay_fee_invoice_requests r WHERE r.trade_no=o.trade_no)
        AND (q.key IS NULL OR json_extract(q.value,'$.nextAt')<=?)
        AND NOT EXISTS(SELECT 1 FROM epay_native_refunds r WHERE r.trade_no=o.trade_no AND r.status NOT IN ('REJECTED','CLOSED'))
        AND NOT EXISTS(SELECT 1 FROM epay_balance_refunds r WHERE r.trade_no=o.trade_no)
        AND EXISTS(SELECT 1 FROM epay_alipay_confirmations c WHERE c.trade_no=o.trade_no AND c.fee_cents>0
          UNION ALL SELECT 1 FROM epay_wechat_confirmations c WHERE c.trade_no=o.trade_no AND c.fee_cents>0
          UNION ALL SELECT 1 FROM epay_balance_confirmations c WHERE c.trade_no=o.trade_no AND c.fee_cents>0)
      ORDER BY o.paid_at,o.trade_no LIMIT ?`).all(now(), now(), limit).map(row => ({
        tradeNo: String(row.trade_no), access: { merchantId: String(row.main_merchant_id), mainApiId: String(row.main_api_id), epayMerchantId: Number(row.merchant_id),
          role: "owner" as const, userId: "fee-invoice-scheduler" },
      })));
  }
  function list(access: InvoiceAccess) {
    return database.read(sql => { requireInvoiceAccess(sql, access);
      return sql.prepare("SELECT invoice_id FROM epay_fee_invoice_requests WHERE merchant_id=? ORDER BY created_at DESC,invoice_id DESC LIMIT 20")
        .all(access.epayMerchantId).map(row => publicInvoice(invoiceRow(sql, String(row.invoice_id), access.epayMerchantId))); });
  }
  function readiness(access: InvoiceAccess) {
    return database.read(sql => {
      requireInvoiceAccess(sql, access);
      const buyer = storedFeeBuyer(sql, access.epayMerchantId), configured = provider.platformFees, checkedAt = now();
      return { configured: Boolean(configured), issuanceEnabled: provider.issuanceEnabled === true, feeEnabled: configured?.enabled === true,
        policyValid: Boolean(configured && configured.validUntil > checkedAt), validUntil: configured?.validUntil ?? null,
        buyerReady: Boolean(buyer), buyerAutoInvoice: buyer?.autoInvoice ?? false,
        selfInvoice: Boolean(buyer && configured && buyer.title === configured.profile.sellerName && buyer.taxId === configured.profile.sellerTaxId),
        subscription: readInvoiceSubscription(sql, access.epayMerchantId, checkedAt),
        provider: readProviderState(sql), ...feeReadinessPreview(sql, access.epayMerchantId, checkedAt) };
    });
  }
  async function checkProvider(access: InvoiceAccess) {
    database.read(sql => requireInvoiceAccess(sql, access, true));
    if (!provider.platformFees || !provider.checkStatus) throw new InvoiceError("invoice_provider_unavailable", 503, "provider readiness probing is unavailable");
    let code: string | null = null;
    try {
      const status = await provider.checkStatus(provider.platformFees.profile);
      if (!verifiedAuthorization(provider.platformFees.profile, status)) code = status.reason && /^[a-z0-9_-]{1,80}$/.test(status.reason) ? status.reason : "invoice_not_authorized";
    } catch (error) { code = error instanceof FaPiaoError ? error.code : "invoice_provider_unavailable"; }
    return database.write(sql => {
      requireInvoiceAccess(sql, access, true);
      return code ? deferFeeQueue(sql, null, code, now()) : clearProviderState(sql, now());
    });
  }
  const defer = (tradeNo: string, code: string) => database.write(sql => deferFeeQueue(sql, providerQueueFailure(code) ? null : tradeNo, code, now()));
  const automationReady = () => enabled() && database.read(sql => (readProviderState(sql)?.nextAt ?? 0) <= now());
  return { enabled, automationReady, readBuyer, saveBuyer, create, candidates, list, readiness, checkProvider, defer };
}
export type FeeInvoiceService = ReturnType<typeof createFeeInvoiceService>;
