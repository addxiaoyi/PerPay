import { randomUUID } from "node:crypto";
import { appendAuditEvent } from "../database/identity-store.ts";
import { readConfirmedOrder } from "../epay-compat/confirmed-order.ts";
import { InvoiceError, invoiceHttpsUrl, invoiceProfileInput, invoiceRequestInput, invoiceTime, parseInvoiceObservation, verifiedAuthorization,
  type InvoiceAccess, type InvoiceDatabase, type InvoiceObservation, type InvoiceProfile, type InvoiceProvider, type StoredInvoiceProfile } from "./model.ts";
import { invoiceIssue, invoiceRow, latestInvoice, publicInvoice, requireInvoiceAccess, requireInvoiceWriter, storedProfile, type InvoiceRow } from "./store.ts";
import { recordInvoiceObservation } from "./observations.ts";
import { isBalanceTopup } from "../epay-compat/topup-kind.ts";

type Options = { database: InvoiceDatabase; provider: InvoiceProvider; clock?: () => number; canIssue?: () => boolean };
const profileSnapshot = ({ enabled: _enabled, authorized: _authorized, authorizationCheckedAt: _checked, version: _version, ...profile }: StoredInvoiceProfile): InvoiceProfile => profile;
const MAX_INVOICE_ATTEMPTS = 5;
const UNSUBMITTED_ERRORS = new Set(["invoice_not_submitted", "wechat_param_error", "wechat_no_auth", "wechat_rule_limit"]);

export function createInvoiceService({ database, provider, clock = Date.now, canIssue = () => true }: Options) {
  const now = () => invoiceTime(clock());
  const getProfile = (access: InvoiceAccess) => database.read(sql => { requireInvoiceAccess(sql, access); return storedProfile(sql, access.epayMerchantId); });
  const readRow = (access: InvoiceAccess, id: string) => database.read(sql => { requireInvoiceAccess(sql, access); return invoiceRow(sql, id, access.epayMerchantId); });
  const writeAccess = (access: InvoiceAccess) => database.read(sql => requireInvoiceWriter(sql, access));

  async function authorize(profile: InvoiceProfile): Promise<void> {
    let authorized: boolean;
    try { authorized = verifiedAuthorization(profile, await provider.authorize(profile)); }
    catch { throw new InvoiceError("invoice_provider_unavailable", 503, "invoice authorization service is unavailable"); }
    if (!authorized) throw new InvoiceError("invoice_not_authorized", 409, "invoice seller is not authorized or its identity differs");
  }

  async function saveProfile(access: InvoiceAccess, input: unknown) {
    const parsed = invoiceProfileInput.parse(input), { expectedVersion, enabled, ...profile } = parsed;
    if (provider.kind && provider.kind !== (profile.provider ?? "wechat")) throw new InvoiceError("invoice_provider_mismatch", 409, "invoice profile belongs to a different provider");
    database.read(sql => { requireInvoiceAccess(sql, access, true); });
    if (enabled) await authorize(profile);
    const checkedAt = now();
    return database.write(sql => {
      requireInvoiceAccess(sql, access, true);
      const current = storedProfile(sql, access.epayMerchantId);
      if ((current?.version ?? 0) !== expectedVersion) throw new InvoiceError("invoice_profile_conflict", 409, "invoice profile version changed");
      if (sql.prepare("SELECT 1 FROM epay_tax_invoice_profiles WHERE sub_mch_id=? AND merchant_id<>?").get(profile.subMchId, access.epayMerchantId))
        throw new InvoiceError("invoice_seller_conflict", 409, "invoice seller is already bound to another merchant");
      sql.prepare(`INSERT INTO epay_tax_invoice_profiles(merchant_id,sub_mch_id,seller_name,seller_tax_id,billing_person_id,item_name,tax_code,tax_rate_bps,
        enabled,authorized,authorization_checked_at,version,updated_by,updated_at,provider) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(merchant_id) DO UPDATE SET sub_mch_id=excluded.sub_mch_id,seller_name=excluded.seller_name,seller_tax_id=excluded.seller_tax_id,
          billing_person_id=excluded.billing_person_id,item_name=excluded.item_name,tax_code=excluded.tax_code,tax_rate_bps=excluded.tax_rate_bps,enabled=excluded.enabled,
          authorized=excluded.authorized,authorization_checked_at=excluded.authorization_checked_at,version=excluded.version,
          updated_by=excluded.updated_by,updated_at=excluded.updated_at,provider=excluded.provider`).run(access.epayMerchantId, profile.subMchId, profile.sellerName,
        profile.sellerTaxId, profile.billingPersonId, profile.itemName, profile.taxCode, profile.taxRateBps, Number(enabled), Number(enabled), checkedAt,
        expectedVersion + 1, access.userId!, checkedAt, profile.provider ?? "wechat");
      appendAuditEvent(sql, { occurredAt: checkedAt, actorType: "ADMIN", actorId: access.userId!, action: "invoice.profile.saved", outcome: "SUCCESS",
        subjectType: "epay_merchant", subjectId: String(access.epayMerchantId), details: { version: expectedVersion + 1, enabled } });
      return storedProfile(sql, access.epayMerchantId)!;
    });
  }

  async function observe(row: InvoiceRow, action: "issue" | "query") {
    let observation: InvoiceObservation;
    try { observation = parseInvoiceObservation(await provider[action](invoiceIssue(row))); }
    catch { observation = { status: "UNKNOWN", errorCode: "invoice_provider_unavailable" }; }
    return recordInvoiceObservation(database, row, observation, now());
  }

  async function createAndIssue(access: InvoiceAccess, input: unknown) {
    const command = invoiceRequestInput.parse(input);
    writeAccess(access);
    if(database.read(sql=>isBalanceTopup(sql,command.tradeNo)))throw new InvoiceError('invoice_topup_not_sale',409,'balance topup principal is not a sales invoice amount');
    const existing = database.read(sql => {
      requireInvoiceAccess(sql, access);
      const same = sql.prepare("SELECT invoice_id FROM epay_tax_invoice_requests WHERE merchant_id=? AND request_id=?").get(access.epayMerchantId, command.requestId);
      return { same, latest: latestInvoice(sql, access.epayMerchantId, command.tradeNo) };
    });
    const duplicate = (row: InvoiceRow) => {
      if (row.request_id !== command.requestId || row.trade_no !== command.tradeNo || row.buyer_type !== command.buyerType || row.title !== command.title || row.tax_id !== command.taxId || row.email !== command.email)
        throw new InvoiceError("invoice_request_conflict", 409, "invoice request conflict");
      return publicInvoice(row);
    };
    if (existing.same) return duplicate(readRow(access, String(existing.same.invoice_id)));
    if (provider.platformFees) throw new InvoiceError("invoice_fee_scope_required", 409, "platform fee mode cannot create a full-payment customer invoice");
    const prior = existing.latest;
    if (prior) {
      if (prior.status !== "FAILED") throw new InvoiceError("invoice_request_conflict", 409, "invoice request conflict; the previous attempt is not a confirmed failure");
      if (prior.buyer_type !== command.buyerType || prior.title !== command.title || prior.tax_id !== command.taxId || prior.email !== command.email)
        throw new InvoiceError("invoice_buyer_conflict", 409, "invoice application buyer details are immutable across retries");
      if (prior.attempt >= MAX_INVOICE_ATTEMPTS) throw new InvoiceError("invoice_retry_limit", 409, "invoice retry limit reached");
      if (!UNSUBMITTED_ERRORS.has(prior.error_code ?? "")) {
        let observation: InvoiceObservation;
        try { observation = parseInvoiceObservation(await provider.query(invoiceIssue(prior))); }
        catch { throw new InvoiceError("invoice_provider_unavailable", 503, "previous invoice failure could not be verified"); }
        if (observation.status !== "FAILED") throw new InvoiceError("invoice_retry_unconfirmed", 409, "previous invoice failure could not be verified");
      }
    }
    const profile = getProfile(access);
    if (!profile?.enabled || !profile.authorized) throw new InvoiceError("invoice_profile_unavailable", 409, "invoice profile is not enabled");
    if (!canIssue()) throw new InvoiceError("invoice_disabled", 503, "invoice issuance is disabled");
    await authorize(profileSnapshot(profile));
    if (!canIssue()) throw new InvoiceError("invoice_disabled", 503, "invoice issuance was disabled during authorization");
    const requestedAt = now();
    const reserved = database.write(sql => {
      requireInvoiceWriter(sql, access);
      const previous = sql.prepare("SELECT invoice_id FROM epay_tax_invoice_requests WHERE merchant_id=? AND request_id=?")
        .get(access.epayMerchantId, command.requestId);
      if (previous) return { duplicate: true, row: invoiceRow(sql, String(previous.invoice_id), access.epayMerchantId) };
      const latest = latestInvoice(sql, access.epayMerchantId, command.tradeNo);
      if ((latest?.invoice_id ?? null) !== (prior?.invoice_id ?? null) || (latest && latest.status !== "FAILED"))
        throw new InvoiceError("invoice_request_conflict", 409, "invoice request conflict; a newer attempt exists");
      const current = storedProfile(sql, access.epayMerchantId);
      if (!current?.enabled || !current.authorized || current.version !== profile.version) throw new InvoiceError("invoice_profile_conflict", 409, "invoice profile version changed");
      const order = readConfirmedOrder(sql, command.tradeNo, access.epayMerchantId);
      if (!order) throw new InvoiceError("invoice_order_unconfirmed", 409, "invoice requires a confirmed payment");
      const isFaPiao = current.provider === "fa-piao";
      if (order.type_code !== "wxpay" && !(isFaPiao && order.type_code === "alipay")) throw new InvoiceError("invoice_payment_unsupported", 409, "invoice payment type is unsupported");
      const payment = isFaPiao ? sql.prepare("SELECT api_trade_no AS provider_trade_no FROM epay_orders WHERE trade_no=? AND merchant_id=?").get(command.tradeNo, access.epayMerchantId)
        : sql.prepare(`SELECT i.provider_merchant_id,c.provider_trade_no FROM epay_wechat_intents i
        JOIN epay_wechat_confirmations c ON c.trade_no=i.trade_no AND c.merchant_id=i.merchant_id
        WHERE i.trade_no=? AND i.merchant_id=?`).get(command.tradeNo, access.epayMerchantId);
      if (!payment?.provider_trade_no || (!isFaPiao && payment.provider_merchant_id !== current.subMchId)) throw new InvoiceError("invoice_payment_merchant_mismatch", 409, "invoice seller differs from the original payment merchant");
      if (sql.prepare("SELECT 1 FROM epay_native_refunds WHERE trade_no=? AND status NOT IN ('REJECTED','CLOSED')").get(command.tradeNo))
        throw new InvoiceError("invoice_refund_conflict", 409, "invoice conflicts with refund");
      if (sql.prepare("SELECT 1 FROM epay_invoices WHERE trade_no=? UNION ALL SELECT 1 FROM epay_invoice_applications WHERE trade_no=? LIMIT 1").get(command.tradeNo, command.tradeNo))
        throw new InvoiceError("invoice_legacy_conflict", 409, "invoice has a legacy invoice or application");
      const id = randomUUID(), requestNo = randomUUID().replaceAll("-", ""), amount = Number(order.money_cents);
      const applicationNo = prior?.application_no ?? requestNo, attempt = (prior?.attempt ?? 0) + 1;
      if (!Number.isSafeInteger(amount) || amount < 1) throw new Error("invalid confirmed invoice amount");
      // Persist uncertainty before the remote call; a timeout or crash must never issue a second tax invoice.
      sql.prepare(`INSERT INTO epay_tax_invoice_requests(invoice_id,request_no,application_no,attempt,request_id,merchant_id,trade_no,amount_cents,payment_type,provider_trade_no,profile_json,
        buyer_type,title,tax_id,email,requested_by,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'UNKNOWN',?,?)`)
        .run(id, requestNo, applicationNo, attempt, command.requestId, access.epayMerchantId, command.tradeNo, amount, order.type_code, String(payment.provider_trade_no),
          JSON.stringify(profileSnapshot(current)), command.buyerType, command.title, command.taxId, command.email, access.userId!, requestedAt, requestedAt);
      sql.prepare("UPDATE epay_tax_invoice_profiles SET authorization_checked_at=? WHERE merchant_id=? AND version=?").run(requestedAt, access.epayMerchantId, current.version);
      appendAuditEvent(sql, { occurredAt: requestedAt, actorType: access.role === "admin" ? "ADMIN" : "SYSTEM", actorId: access.userId!,
        action: "invoice.requested", outcome: "SUCCESS", subjectType: "tax_invoice", subjectId: id, details: { merchantId: access.epayMerchantId, amountCents: amount, attempt } });
      return { duplicate: false, row: invoiceRow(sql, id, access.epayMerchantId) };
    });
    return reserved.duplicate ? duplicate(reserved.row) : observe(reserved.row, "issue");
  }

  async function refresh(access: InvoiceAccess, id: string) {
    writeAccess(access);
    const row = readRow(access, id);
    if (row.status === "FAILED" || row.status === "REVERSED") return publicInvoice(row);
    return observe(row, "query");
  }

  async function checkAuthorization(access: InvoiceAccess) {
    writeAccess(access);
    const profile = getProfile(access);
    if (!profile) throw new InvoiceError("invoice_profile_unavailable", 409, "invoice profile has not been configured");
    let authorized = false, unavailable = false, billingPersonIds: string[] = [];
    try {
      const authorization = await provider.authorize(profileSnapshot(profile));
      if (authorization.subMchId !== profile.subMchId || !Array.isArray(authorization.billingPersonIds)
          || !authorization.billingPersonIds.every(id => typeof id === "string" && id.length > 0 && id.length <= 64 && !/[\x00-\x1f\x7f]/.test(id)))
        throw new Error("invalid invoice authorization identity");
      billingPersonIds = authorization.billingPersonIds;
      authorized = verifiedAuthorization(profileSnapshot(profile), authorization);
    }
    catch { unavailable = true; }
    const checkedAt = now();
    const saved = database.write(sql => {
      requireInvoiceWriter(sql, access);
      const current = storedProfile(sql, access.epayMerchantId);
      if (current?.version !== profile.version) throw new InvoiceError("invoice_profile_conflict", 409, "invoice profile version changed");
      sql.prepare("UPDATE epay_tax_invoice_profiles SET authorized=?,enabled=CASE WHEN ?=0 THEN 0 ELSE enabled END,authorization_checked_at=?,updated_at=?,version=version+1 WHERE merchant_id=?")
        .run(Number(authorized), Number(authorized), checkedAt, checkedAt, access.epayMerchantId);
      appendAuditEvent(sql, { occurredAt: checkedAt, actorType: "SYSTEM", actorId: access.userId!, action: "invoice.authorization.checked", outcome: authorized ? "SUCCESS" : "FAILURE",
        subjectType: "epay_merchant", subjectId: String(access.epayMerchantId), details: { authorized, unavailable } });
      return storedProfile(sql, access.epayMerchantId)!;
    });
    if (unavailable) throw new InvoiceError("invoice_provider_unavailable", 503, "invoice authorization service is unavailable");
    return { profile: saved, billingPersonIds };
  }

  async function invite(access: InvoiceAccess) {
    writeAccess(access);
    const profile = getProfile(access);
    if (!profile) throw new InvoiceError("invoice_profile_unavailable", 409, "invoice profile has not been configured");
    try { return invoiceHttpsUrl((await provider.invite(profileSnapshot(profile))).url); }
    catch { throw new InvoiceError("invoice_provider_unavailable", 503, "invoice authorization invitation is unavailable"); }
  }

  async function download(access: InvoiceAccess, id: string) {
    writeAccess(access);
    const row = readRow(access, id);
    if (row.status !== "ISSUED") throw new InvoiceError("invoice_not_issued", 409, "invoice has not been issued");
    let observation: InvoiceObservation;
    try { observation = parseInvoiceObservation(await provider.query(invoiceIssue(row))); }
    catch { throw new InvoiceError("invoice_provider_unavailable", 503, "invoice status could not be confirmed"); }
    const current = recordInvoiceObservation(database, row, observation, now());
    if (observation.status !== "ISSUED" || current.status !== "ISSUED") throw new InvoiceError("invoice_not_issued", 409, "invoice is not currently available for download");
    try {
      const file = await provider.download(invoiceIssue(row));
      if (file.expiresAt !== undefined && (!Number.isSafeInteger(file.expiresAt) || file.expiresAt <= now())) throw new Error("invoice download URL expired");
      return invoiceHttpsUrl(file.downloadUrl);
    } catch { throw new InvoiceError("invoice_provider_unavailable", 503, "invoice download is unavailable"); }
  }

  function list(access: InvoiceAccess, page = 1) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw new InvoiceError("invoice_invalid_page", 400, "invalid invoice page");
    return database.read(sql => {
      requireInvoiceAccess(sql, access);
      const ids = sql.prepare("SELECT invoice_id FROM epay_tax_invoice_requests WHERE merchant_id=? ORDER BY created_at DESC,invoice_id DESC LIMIT 21 OFFSET ?")
        .all(access.epayMerchantId, (page - 1) * 20);
      return { invoices: ids.slice(0, 20).map(row => publicInvoice(invoiceRow(sql, String(row.invoice_id), access.epayMerchantId))), hasNext: ids.length > 20 };
    });
  }

  return { saveProfile, getProfile, checkAuthorization, invite, createAndIssue, refresh, download, list, read: (access: InvoiceAccess, id: string) => publicInvoice(readRow(access, id)) };
}
export type InvoiceService = ReturnType<typeof createInvoiceService>;
