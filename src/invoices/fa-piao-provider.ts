import { createFaPiaoClient, FaPiaoError, faPiaoFields, providerError, type FaPiaoCredentials } from "./fa-piao-client.ts";
import type { InvoiceIssue, InvoiceObservation, InvoiceProfile, InvoiceProvider } from "./model.ts";

export interface FaPiaoReceipts {
  load(requestNo: string): string | undefined;
  save(requestNo: string, invoiceNo: string): void;
}
const invoiceNumber = (value: unknown): value is string => typeof value === "string" && /^\d{20}$/.test(value);

export function invoiceAmounts(amountCents: number, taxRateBps: number) {
  if (!Number.isSafeInteger(amountCents) || amountCents < 1 || !Number.isInteger(taxRateBps) || taxRateBps < 0 || taxRateBps > 2500)
    throw new FaPiaoError("invalid_amount", "NOT_SUBMITTED");
  const gross = BigInt(amountCents), rate = BigInt(taxRateBps), divisor = 10_000n + rate;
  const tax = (gross * rate + divisor / 2n) / divisor;
  return { net: money(gross - tax), tax: money(tax), gross: money(gross), rate: String(taxRateBps / 10_000) };
}

export function createFaPiaoInvoiceProvider(options: {
  credentials: FaPiaoCredentials; allowIssue: boolean; receipts: FaPiaoReceipts; transport?: typeof fetch; clock?: () => number;
}): InvoiceProvider {
  const credentials = { ...options.credentials }, client = createFaPiaoClient(options);
  function matches(profile: InvoiceProfile): boolean {
    return profile.provider === "fa-piao" && profile.subMchId === credentials.accountId && profile.sellerTaxId === credentials.sellerTaxId
      && profile.sellerName === credentials.sellerName && profile.billingPersonId === credentials.username;
  }
  function requireBinding(request: InvoiceIssue): void {
    if (!matches(request.profile) || !/^[a-f0-9]{32}$/.test(request.requestNo) || !/^[a-f0-9]{32}$/.test(request.applicationNo))
      throw new FaPiaoError("invoice_provider_mismatch", "NOT_SUBMITTED");
  }
  async function verify(request: InvoiceIssue, number: string, signal?: AbortSignal): Promise<InvoiceObservation> {
    const reply = await client.invoiceDetails(number, signal);
    if (reply.code !== 200) return { status: "UNKNOWN", errorCode: providerError(reply.code, reply.fields) };
    const invoice = faPiaoFields(reply.fields.data);
    const amount = invoiceAmounts(request.amountCents, request.profile.taxRateBps);
    const items = Array.isArray(invoice.mxzb) ? invoice.mxzb.map(faPiaoFields) : [];
    if (invoice.fphm !== number || invoice.xhdwsbh !== request.profile.sellerTaxId || invoice.xhdwmc !== request.profile.sellerName
        || invoice.ghdwmc !== request.buyer.title || (invoice.ghdwsbh ?? "") !== request.buyer.taxId
        || decimalCents(invoice.hjje) + decimalCents(invoice.hjse) !== BigInt(request.amountCents)
        || String(invoice.fplxdm) !== "82" || items.length !== 1 || items[0]!.spbm !== request.profile.taxCode
        || Number(items[0]!.sl) !== request.profile.taxRateBps / 10_000
        || decimalCents(items[0]!.je) !== decimalCents(amount.net) || decimalCents(items[0]!.se) !== decimalCents(amount.tax))
      throw new FaPiaoError("invoice_identity_mismatch", "UNKNOWN");
    return { status: "ISSUED", invoiceNo: number };
  }
  return {
    kind: "fa-piao",
    issuanceEnabled: options.allowIssue,
    ...(credentials.platformFees ? { platformFees: { enabled: credentials.platformFees.enabled, validUntil: credentials.platformFees.validUntil,
      profile: { provider: "fa-piao" as const, subMchId: credentials.accountId, sellerName: credentials.sellerName, sellerTaxId: credentials.sellerTaxId,
        billingPersonId: credentials.username, itemName: credentials.platformFees.itemName, taxCode: credentials.platformFees.taxCode, taxRateBps: credentials.platformFees.taxRateBps } } } : {}),
    async reviewInvoice(request, number) {
      requireBinding(request);
      if (!invoiceNumber(number)) throw new FaPiaoError("invalid_invoice_number", "UNKNOWN");
      return verify(request, number);
    },
    async authorize(profile) {
      const identity = { subMchId: profile.subMchId, billingPersonIds: matches(profile) ? [credentials.username] : [] };
      if (!matches(profile) || !options.allowIssue) return { ...identity, authorized: false, reason: "issuance_disabled_or_unbound" };
      const login = await client.checkLogin();
      return { ...identity, authorized: login.code === 200, ...(login.code === 200 ? {} : { reason: providerError(login.code, login.fields) }) };
    },
    async checkStatus(profile) {
      const identity = { subMchId: profile.subMchId, billingPersonIds: matches(profile) ? [credentials.username] : [] };
      if (!matches(profile)) return { ...identity, authorized: false, reason: "invoice_provider_mismatch" };
      const login = await client.checkLogin(undefined, true);
      return { ...identity, authorized: login.code === 200, ...(login.code === 200 ? {} : { reason: providerError(login.code, login.fields) }) };
    },
    async issue(request) {
      if (!options.allowIssue) throw new FaPiaoError("issuance_disabled", "NOT_SUBMITTED");
      try {
        requireBinding(request);
        if (request.kind === "platform-fee" && (!credentials.platformFees?.enabled || credentials.platformFees.validUntil <= (options.clock ?? Date.now)()
            || request.profile.itemName !== credentials.platformFees.itemName || request.profile.taxCode !== credentials.platformFees.taxCode
            || request.profile.taxRateBps !== credentials.platformFees.taxRateBps)) throw new FaPiaoError("fee_invoicing_disabled", "NOT_SUBMITTED");
        if (!credentials.sellerAddressPhone || !credentials.sellerBankAccount || request.profile.taxRateBps === 0 || !["wxpay", "alipay", "balance"].includes(request.paymentType))
          throw new FaPiaoError("incomplete_seller", "NOT_SUBMITTED");
      } catch { return { status: "FAILED", errorCode: "invoice_not_submitted" }; }
      const prior = options.receipts.load(request.requestNo);
      if (prior) return verify(request, prior);
      const amount = invoiceAmounts(request.amountCents, request.profile.taxRateBps);
      const reply = await client.issueBlue({
        fpqqlsh: request.applicationNo, fplxdm: "82", kplx: "0", xhdwsbh: credentials.sellerTaxId,
        xhdwmc: credentials.sellerName, xhdwdzdh: credentials.sellerAddressPhone, xhdwyhzh: credentials.sellerBankAccount,
        ghdwmc: request.buyer.title, ghdwsbh: request.buyer.taxId, gfzrrbs: request.buyer.type === "INDIVIDUAL" ? "Y" : "N",
        zsfs: "0", hjje: amount.net, hjse: amount.tax, jshj: amount.gross,
        ...(request.kind === "platform-fee" && request.profile.taxRateBps === 300 ? { slsm: "2" } : {}),
        fyxm: [{ fphxz: "0", spmc: request.profile.itemName, spbm: request.profile.taxCode, je: amount.net, se: amount.tax, sl: amount.rate, hsbz: "0" }],
      });
      if (reply.code !== 200) return { status: "UNKNOWN", errorCode: providerError(reply.code, reply.fields) };
      const receipt = faPiaoFields(reply.fields.data).Fphm;
      if (!invoiceNumber(receipt)) return { status: "UNKNOWN", errorCode: "fapiao_reconcile_required" };
      // Keep the number before checking its identity; a failed check can be recovered after a restart.
      options.receipts.save(request.requestNo, receipt);
      return verify(request, receipt);
    },
    async query(request, signal) {
      requireBinding(request);
      const number = options.receipts.load(request.requestNo) ?? request.invoiceNo;
      if (!number) return { status: "UNKNOWN", errorCode: "fapiao_reconcile_required" };
      if (!invoiceNumber(number)) throw new FaPiaoError("invalid_invoice_number", "UNKNOWN");
      return verify(request, number, signal);
    },
    async download(request) {
      requireBinding(request);
      const number = options.receipts.load(request.requestNo) ?? request.invoiceNo;
      if (!number || (await verify(request, number)).status !== "ISSUED") throw new FaPiaoError("invoice_unverified", "UNKNOWN");
      const reply = await client.invoiceFiles(number);
      if (reply.code !== 200) throw new FaPiaoError(providerError(reply.code, reply.fields), "NOT_SUBMITTED");
      const files = faPiaoFields(reply.fields.data);
      if (typeof files.pdfUrl !== "string") throw new FaPiaoError("invalid_download", "UNKNOWN");
      const url = new URL(files.pdfUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port || url.hostname === "localhost"
          || /^\d+(?:\.\d+){3}$/.test(url.hostname) || url.hostname.includes(":")) throw new FaPiaoError("invalid_download", "UNKNOWN");
      return { downloadUrl: url.href };
    },
    async invite(profile) {
      if (!matches(profile)) throw new FaPiaoError("invoice_provider_mismatch", "NOT_SUBMITTED");
      return { url: "https://open.fa-piao.com/tax/merchant" };
    },
  };
}

function money(cents: bigint): string { return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`; }
function decimalCents(value: unknown): bigint {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^(0|[1-9]\d{0,14})(\.\d{1,2})?$/.test(text)) throw new FaPiaoError("invalid_invoice_amount", "UNKNOWN");
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
}
