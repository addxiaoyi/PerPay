import { createHash } from "node:crypto";
import { createWechatInvoiceClient, invoiceFields, type WechatInvoiceOptions } from "./wechat-client.ts";
import type { InvoiceIssue, InvoiceObservation, InvoiceProfile, InvoiceProvider } from "./model.ts";

const ROOT = "/v3/new-tax-control-fapiao";
const providerId = (value: string) => /^[A-Za-z0-9_|*-]{1,32}$/.test(value);
const rows = (value: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(value)) throw new Error("invalid WeChat invoice response list");
  return value.map(invoiceFields);
};

function applicationPath(request: InvoiceIssue, suffix = ""): string {
  if (request.profile.provider === "fa-piao") throw new Error("invoice belongs to a different provider");
  if (!providerId(request.requestNo) || !providerId(request.applicationNo) || !/^\d{6,32}$/.test(request.profile.subMchId)) throw new Error("invalid invoice request identity");
  const query = new URLSearchParams({ sub_mchid: request.profile.subMchId, fapiao_id: request.requestNo });
  return `${ROOT}/fapiao-applications/${encodeURIComponent(request.applicationNo)}${suffix}?${query}`;
}

function verifyInvoiceIdentity(invoice: Record<string, unknown>, request: InvoiceIssue): void {
  if (invoice.fapiao_id !== request.requestNo) throw new Error("WeChat invoice identity mismatch");
  if (invoice.total_amount !== request.amountCents) throw new Error("WeChat invoice amount mismatch");
  const seller = invoiceFields(invoice.seller_information), buyer = invoiceFields(invoice.buyer_information);
  if (seller.name !== request.profile.sellerName || seller.taxpayer_id !== request.profile.sellerTaxId || buyer.type !== request.buyer.type
      || buyer.name !== request.buyer.title || (buyer.taxpayer_id ?? "") !== request.buyer.taxId)
    throw new Error("WeChat invoice seller or buyer identity mismatch");
}

function downloadAddress(value: unknown): URL {
  if (typeof value !== "string" || value.length > 2048) throw new Error("invalid WeChat invoice download URL");
  const url = new URL(value);
  if (url.protocol !== "https:" || !["pay.wechatpay.cn", "pay.weixin.qq.com"].includes(url.hostname) || url.port || url.username || url.password
      || url.hash || url.pathname !== "/invoicing/fapiao/fapiao-file" || url.searchParams.getAll("token").length !== 1 || !url.searchParams.get("token"))
    throw new Error("invalid WeChat invoice download URL");
  return url;
}

export function createWechatInvoiceProvider(options: WechatInvoiceOptions): InvoiceProvider {
  const client = createWechatInvoiceClient(options), clock = options.clock ?? Date.now;
  async function queryInvoice(request: InvoiceIssue, signal?: AbortSignal) {
    const reply = await client.request("GET", applicationPath(request), undefined, signal);
    if (reply.status !== 200) throw new Error("WeChat invoice query unavailable");
    const invoices = rows(reply.fields.fapiao_information ?? []);
    if (invoices.length === 0 && reply.fields.total_count === 0) return undefined;
    if (invoices.length !== 1 || reply.fields.total_count !== 1 || invoices[0]!.fapiao_id !== request.requestNo)
      throw new Error("WeChat invoice identity mismatch");
    return invoices[0]!;
  }
  return {
    kind: "wechat",
    async authorize(profile: InvoiceProfile) {
      if (profile.provider === "fa-piao") throw new Error("invoice belongs to a different provider");
      if (!/^\d{6,32}$/.test(profile.subMchId)) throw new Error("invalid invoice merchant identity");
      const reply = await client.request("GET", `${ROOT}/merchant/${profile.subMchId}/check-status`);
      if (reply.status !== 200) throw new Error("WeChat invoice authorization unavailable");
      if (reply.fields.sub_mchid !== profile.subMchId) throw new Error("WeChat invoice merchant identity mismatch");
      const mode = reply.fields.digital_tax_mode ? invoiceFields(reply.fields.digital_tax_mode) : {};
      const people = rows(mode.billing_person_info ?? []), abilities = rows(mode.ability_info ?? []);
      const billingPersonIds = people.map(person => person.id).filter((id): id is string => typeof id === "string");
      const expires = mode.expired_time === undefined ? Number.POSITIVE_INFINITY : Date.parse(String(mode.expired_time));
      const authorized = mode.status === "ENABLED" && billingPersonIds.includes(profile.billingPersonId) && expires > clock()
        && abilities.some(ability => ability.type === "BASE_ABILITY" && ability.status === "AUTHORIZED");
      return { authorized, subMchId: profile.subMchId, billingPersonIds };
    },
    async issue(request: InvoiceIssue): Promise<InvoiceObservation> {
      let buyerEmail: string;
      try {
        if (request.paymentType !== "wxpay" || !/^\d{1,64}$/.test(request.providerTradeNo)) throw new Error("invalid WeChat transaction identity");
        applicationPath(request);
        if (!Number.isSafeInteger(request.amountCents) || request.amountCents <= 0) throw new Error("invalid invoice amount");
        if (!(await this.authorize(request.profile)).authorized) throw new Error("invoice merchant authorization unavailable");
        buyerEmail = client.encrypt(request.buyer.email);
      } catch {
        // No issuance request has left the process, so correcting the configuration is safe.
        return { status: "FAILED", errorCode: "invoice_not_submitted" };
      }
      const reply = await client.request("POST", `${ROOT}/fapiao-applications/issue-general`, {
        sub_mchid: request.profile.subMchId, fapiao_apply_id: request.applicationNo,
        buyer_information: { type: request.buyer.type, name: request.buyer.title,
          ...(request.buyer.taxId ? { taxpayer_id: request.buyer.taxId } : {}), email: buyerEmail },
        fapiao_information: { fapiao_id: request.requestNo, total_amount: request.amountCents, billing_person_id: request.profile.billingPersonId,
          fapiao_bill_type: "COMM_FAPIAO", items: [{ tax_code: request.profile.taxCode, goods_name: request.profile.itemName,
            total_amount: request.amountCents, tax_rate: request.profile.taxRateBps, discount: false }],
          // The provider verifies this real transaction belongs to the authorized seller and has sufficient un-invoiced value.
          transaction_information: [{ pay_channel: "WECHAT_PAY", transaction_id: request.providerTradeNo, amount: request.amountCents }] },
      });
      if (reply.status === 202 || reply.fields.code === "RESOURCE_ALREADY_EXISTS") return { status: "PROCESSING" };
      if ([400, 403].includes(reply.status) && ["PARAM_ERROR", "NO_AUTH", "RULE_LIMIT"].includes(String(reply.fields.code)))
        return { status: "FAILED", errorCode: `wechat_${String(reply.fields.code).toLowerCase()}` };
      throw new Error("WeChat invoice response requires query");
    },
    async query(request: InvoiceIssue, signal?: AbortSignal): Promise<InvoiceObservation> {
      const invoice = await queryInvoice(request, signal);
      if (!invoice) return { status: "UNKNOWN" };
      verifyInvoiceIdentity(invoice, request);
      if (invoice.status === "ISSUE_ACCEPTED") return { status: "PROCESSING" };
      if (invoice.status === "ISSUE_FAILED") return { status: "FAILED", errorCode: "wechat_issue_failed" };
      if (invoice.status === "REVERSED" || invoice.status === "REVERSE_ACCEPTED") {
        return { status: invoice.status === "REVERSED" ? "REVERSED" : "REVERSING" };
      }
      if (invoice.status !== "ISSUED" && invoice.status !== "REVERSE_FAILED") throw new Error("unknown WeChat invoice status");
      const blue = invoiceFields(invoice.blue_fapiao);
      if (typeof blue.fapiao_number !== "string" || !/^\d{8,20}$/.test(blue.fapiao_number)) throw new Error("invalid WeChat invoice number");
      const card = invoice.card_information ? invoiceFields(invoice.card_information) : {};
      return { status: "ISSUED", invoiceNo: blue.fapiao_number, ...(invoice.status === "REVERSE_FAILED" ? { reversalFailed: true as const } : {}), ...(typeof card.card_openid === "string" ? { cardOpenid: card.card_openid } : {}) };
    },
    async download(request: InvoiceIssue) {
      const invoice = await queryInvoice(request);
      if (!invoice || !["ISSUED", "REVERSE_FAILED"].includes(String(invoice.status))) throw new Error("WeChat invoice is not issued");
      verifyInvoiceIdentity(invoice, request);
      const blue = invoiceFields(invoice.blue_fapiao), card = invoiceFields(invoice.card_information);
      if (typeof blue.fapiao_number !== "string" || !/^\d{8,20}$/.test(blue.fapiao_number)
          || typeof card.card_openid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(card.card_openid)) throw new Error("invoice download identity unavailable");
      const reply = await client.request("GET", applicationPath(request, "/fapiao-files"));
      if (reply.status !== 200) throw new Error("invoice download unavailable");
      const files = rows(reply.fields.fapiao_download_info_list);
      if (files.length !== 1 || files[0]!.fapiao_id !== request.requestNo || files[0]!.status !== "ISSUED") throw new Error("invoice download identity mismatch");
      const url = downloadAddress(files[0]!.download_url);
      for (const [name, value] of Object.entries({ mchid: options.merchantId, sub_mchid: request.profile.subMchId,
        openid: card.card_openid, invoice_no: blue.fapiao_number, fapiao_id: request.requestNo, file_format: "PDF" })) url.searchParams.set(name, value);
      if (typeof blue.fapiao_code === "string") url.searchParams.set("invoice_code", blue.fapiao_code);
      return { downloadUrl: url.toString(), expiresAt: reply.startedAt + 30000 };
    },
    async invite(profile: InvoiceProfile) {
      if (profile.provider === "fa-piao") throw new Error("invoice belongs to a different provider");
      if (!/^\d{6,32}$/.test(profile.subMchId)) throw new Error("invalid invoice merchant identity");
      const inviteCode = createHash("sha256").update(`perpay:invoice:${options.merchantId}:${profile.subMchId}`).digest("hex");
      const query = new URLSearchParams({ operation_type: "AUTH_BINDING", fapiao_mode: "TENCENT_DIGITAL_TAX",
        fapiao_ability_type_list: "BASE_ABILITY", invite_code: inviteCode, sub_mchid: profile.subMchId });
      const reply = await client.request("GET", `${ROOT}/fapiaomerchant/getspinviteurl?${query}`);
      if (reply.status !== 200 || typeof reply.fields.invite_url !== "string") throw new Error("invoice invitation unavailable");
      const url = new URL(reply.fields.invite_url);
      if (url.protocol !== "https:" || !["wxacurl.cn", "pay.weixin.qq.com", "pay.wechatpay.cn"].includes(url.hostname) || url.username || url.password || url.port || url.hash)
        throw new Error("invalid invoice invitation URL");
      return { url: url.toString(),
        ...(typeof reply.fields.miniprogram_appid === "string" ? { miniProgramAppId: reply.fields.miniprogram_appid } : {}),
        ...(typeof reply.fields.miniprogram_path === "string" ? { miniProgramPath: reply.fields.miniprogram_path } : {}) };
    },
  };
}
