import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";
import { z } from "zod";
import { readBoundedBody } from "../epay-compat/main-order-auth.ts";
import { parseStrictJson } from "../http/strict-json.ts";

const TOKEN_URL = "https://open.nuonuo.com/accessToken";
const GATEWAYS = { sandbox: "https://sandbox.nuonuocs.cn/open/v1/services", production: "https://sdk.nuonuo.com/open/v1/services" } as const;
const MAX_TOKEN_LIFETIME = 86_400_000;
const REQUEST_TIMEOUT = 10_000;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const printable = (limit: number) => z.string().min(1).max(limit).regex(/^[^\x00-\x1f\x7f]+$/);
const taxId = z.string().regex(/^[A-Z0-9]{15,20}$/);
const money = z.string().max(16).regex(/^(0|[1-9]\d*)\.\d{2}$/);
const detailSchema = z.object({
  goodsName: printable(100), goodsCode: z.string().regex(/^\d{19}$/), withTaxFlag: z.enum(["0", "1"]),
  taxRate: z.string().max(10).regex(/^(0|[1-9]\d*)(\.\d+)?$/),
  taxIncludedAmount: money, taxExcludedAmount: money, tax: money,
  invoiceLineProperty: z.literal("0").optional(), unit: printable(20).optional(), specType: printable(40).optional(),
  favouredPolicyFlag: z.string().regex(/^\d{1,2}$/).optional(), favouredPolicyName: z.string().max(50).optional(),
}).strict().refine(detail => {
  if (![detail.taxIncludedAmount, detail.taxExcludedAmount, detail.tax].every(value => money.safeParse(value).success)) return false;
  return cents(detail.taxIncludedAmount) > 0n && cents(detail.taxExcludedAmount) + cents(detail.tax) === cents(detail.taxIncludedAmount);
}, "invoice line amounts must balance");
const orderSchema = z.object({
  orderNo: printable(64), salerTaxNum: taxId, buyerName: printable(100), buyerTaxNum: z.union([taxId, z.literal("")]),
  invoiceDate: printable(20), invoiceDetail: z.array(detailSchema).min(1).max(2000),
  salerTel: printable(20).optional(), salerAddress: printable(80).optional(),
  email: z.string().max(50).email().optional(), buyerPhone: printable(20).optional(), pushMode: z.enum(["-1", "0"]).default("-1"),
}).strict().refine(order => order.pushMode !== "0" || order.email !== undefined, "email delivery requires an email address");

// This subset accepts normal blue invoice lines with caller-confirmed tax treatment; it does not calculate tax or split orders.
export type NuonuoPcInvoiceOrder = z.input<typeof orderSchema>;
export type NuonuoCachedToken = { accountKey: string; accessToken: string; issuedAt: number; expiresAt: number };
export interface NuonuoTokenCache {
  // Hold one shared account lock across load, remote acquisition and save, including callers in other processes.
  withLock<T>(accountKey: string, task: () => Promise<T>): Promise<T>;
  load(accountKey: string): Promise<NuonuoCachedToken | undefined>;
  save(accountKey: string, token: NuonuoCachedToken): Promise<void>;
}
export type NuonuoInvoiceClientOptions = {
  environment: "sandbox" | "production"; appKey: string; appSecret: string; sellerTaxId: string;
  tokenCache: NuonuoTokenCache; transport: typeof fetch; clock?: () => number;
};
export type NuonuoAcceptance = { status: "ACCEPTED"; orderNo: string; invoiceSerialNum: string };
export class NuonuoProtocolError extends Error {
  readonly code: string;
  readonly outcome: "NOT_SUBMITTED" | "UNKNOWN";
  readonly providerCode: string | undefined;
  constructor(code: string, outcome: "NOT_SUBMITTED" | "UNKNOWN", providerCode?: string) {
    super(`Nuonuo invoice protocol: ${code}`);
    this.name = "NuonuoProtocolError";
    this.code = code;
    this.outcome = outcome;
    this.providerCode = providerCode;
  }
}

export function createNuonuoInvoiceClient(settings: NuonuoInvoiceClientOptions) {
  const options = { ...settings };
  if (!Object.hasOwn(GATEWAYS, options.environment) || !/^[A-Za-z0-9_-]{1,128}$/.test(options.appKey)
      || !/^[\x21-\x7e]{1,256}$/.test(options.appSecret) || !taxId.safeParse(options.sellerTaxId).success
      || typeof options.tokenCache?.withLock !== "function" || typeof options.tokenCache.load !== "function" || typeof options.tokenCache.save !== "function")
    throw new NuonuoProtocolError("invalid_configuration", "NOT_SUBMITTED");
  const clock = options.clock ?? Date.now;
  const accountKey = createHash("sha256").update(`${options.environment}\n${options.appKey}\n${options.sellerTaxId}`).digest("hex");
  let current: NuonuoCachedToken | undefined, persisted = false, refreshing: Promise<string> | undefined;

  function now(): number {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new NuonuoProtocolError("invalid_clock", "NOT_SUBMITTED");
    return value;
  }

  async function saveToken(token: NuonuoCachedToken): Promise<string> {
    try { await options.tokenCache.save(accountKey, { ...token }); }
    catch { throw new NuonuoProtocolError("token_cache_unavailable", "NOT_SUBMITTED"); }
    persisted = true;
    return token.accessToken;
  }

  async function accessToken(): Promise<string> {
    try { return await options.tokenCache.withLock(accountKey, lockedAccessToken); }
    catch (error) {
      if (error instanceof NuonuoProtocolError) throw error;
      throw new NuonuoProtocolError("token_cache_unavailable", "NOT_SUBMITTED");
    }
  }

  async function lockedAccessToken(): Promise<string> {
    const started = now();
    if (current && tokenFresh(current, started)) return persisted ? current.accessToken : saveToken(current);
    let cached: NuonuoCachedToken | undefined;
    try { cached = await options.tokenCache.load(accountKey); }
    catch { throw new NuonuoProtocolError("token_cache_unavailable", "NOT_SUBMITTED"); }
    if (cached !== undefined) {
      validateCachedToken(cached, accountKey, started);
      if (tokenFresh(cached, started)) { current = { ...cached }; persisted = true; return current.accessToken; }
    }
    const fields = await requestJson(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", accept: "application/json" },
      body: new URLSearchParams({ client_id: options.appKey, client_secret: options.appSecret, grant_type: "client_credentials" }) }, "NOT_SUBMITTED");
    const seconds = typeof fields.expires_in === "string" && /^\d+$/.test(fields.expires_in) ? Number(fields.expires_in) : fields.expires_in;
    if (!safeToken(fields.access_token) || !Number.isSafeInteger(seconds) || Number(seconds) < 1 || Number(seconds) > MAX_TOKEN_LIFETIME / 1000)
      throw new NuonuoProtocolError("invalid_token_response", "NOT_SUBMITTED");
    const expiresAt = started + Number(seconds) * 1000;
    if (!Number.isSafeInteger(expiresAt) || now() < started || now() >= expiresAt)
      throw new NuonuoProtocolError("invalid_token_response", "NOT_SUBMITTED");
    // Retain the grant even if durable storage fails, so a later attempt can save it without spending another grant.
    current = { accountKey, accessToken: fields.access_token, issuedAt: started, expiresAt };
    persisted = false;
    return saveToken(current);
  }

  async function tokenFor(signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new NuonuoProtocolError("request_aborted", "NOT_SUBMITTED");
    refreshing ??= accessToken().finally(() => { refreshing = undefined; });
    return abortable(refreshing, signal);
  }

  async function requestJson(url: string | URL, init: RequestInit, outcome: "NOT_SUBMITTED" | "UNKNOWN", signal?: AbortSignal): Promise<Record<string, unknown>> {
    try {
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT);
      const response = await options.transport(url, { ...init, redirect: "error", cache: "no-store",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!response.ok) throw new Error("upstream HTTP response unavailable");
      const fields = parseStrictJson(await readBoundedBody(response.body, MAX_RESPONSE_BYTES));
      if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("invalid upstream response");
      return fields as Record<string, unknown>;
    } catch { throw new NuonuoProtocolError(outcome === "UNKNOWN" ? "invoice_response_uncertain" : "token_unavailable", outcome); }
  }

  return {
    // The caller must durably save orderNo and this exact order snapshot before calling; no retry or final issuance is implied.
    async submitPcInvoice(input: NuonuoPcInvoiceOrder, signal?: AbortSignal): Promise<NuonuoAcceptance> {
      const parsed = orderSchema.safeParse(input);
      if (!parsed.success || parsed.data.salerTaxNum !== options.sellerTaxId) throw new NuonuoProtocolError("invalid_invoice", "NOT_SUBMITTED");
      const order = parsed.data, body = JSON.stringify({ order: { ...order, invoiceLine: "pc", invoiceType: "1" } });
      if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) throw new NuonuoProtocolError("invalid_invoice", "NOT_SUBMITTED");
      const token = await tokenFor(signal);
      if (signal?.aborted) throw new NuonuoProtocolError("request_aborted", "NOT_SUBMITTED");
      const timestamp = String(Math.floor(now() / 1000)), senid = randomBytes(16).toString("hex"), nonce = String(randomInt(10_000_000, 100_000_000));
      const url = new URL(GATEWAYS[options.environment]);
      url.search = new URLSearchParams({ senid, nonce, timestamp, appkey: options.appKey }).toString();
      const canonical = `a=services&l=v1&p=open&k=${options.appKey}&i=${senid}&n=${nonce}&t=${timestamp}&f=${body}`;
      const signature = createHmac("sha1", options.appSecret).update(canonical, "utf8").digest("base64");
      const fields = await requestJson(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json",
        "X-Nuonuo-Sign": signature, accessToken: token, userTax: options.sellerTaxId, method: "nuonuo.OpeMplatform.requestBillingNew" }, body }, "UNKNOWN", signal);
      if (fields.code !== "E0000") {
        const code = typeof fields.code === "string" && /^[A-Z]\d{4}$/.test(fields.code) ? fields.code : undefined;
        // E9106 can refer to a previously accepted order; all business errors stay outside the refundable FAILED state.
        throw new NuonuoProtocolError(code === "E9106" ? "duplicate_order_requires_query" : "invoice_rejected_requires_query", "UNKNOWN", code);
      }
      const reply = fields.result;
      if (!reply || typeof reply !== "object" || Array.isArray(reply)
          || !printable(200).safeParse((reply as Record<string, unknown>).invoiceSerialNum).success)
        throw new NuonuoProtocolError("invalid_acceptance", "UNKNOWN");
      return { status: "ACCEPTED", orderNo: order.orderNo, invoiceSerialNum: String((reply as Record<string, unknown>).invoiceSerialNum) };
    },
  };
}

function cents(value: string): bigint { return BigInt(value.replace(".", "")); }
function safeToken(value: unknown): value is string { return typeof value === "string" && /^[\x21-\x7e]{1,4096}$/.test(value); }
function validateCachedToken(token: NuonuoCachedToken, key: string, now: number): void {
  if (!token || token.accountKey !== key || !safeToken(token.accessToken) || !Number.isSafeInteger(token.issuedAt) || !Number.isSafeInteger(token.expiresAt)
      || token.issuedAt < 0 || token.issuedAt > now || token.expiresAt <= token.issuedAt || token.expiresAt - token.issuedAt > MAX_TOKEN_LIFETIME)
    throw new NuonuoProtocolError("invalid_token_cache", "NOT_SUBMITTED");
}
function tokenFresh(token: NuonuoCachedToken, now: number): boolean {
  return now >= token.issuedAt && now < token.expiresAt - Math.min(60_000, (token.expiresAt - token.issuedAt) / 10);
}
async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const canceled = () => { reject(new NuonuoProtocolError("request_aborted", "NOT_SUBMITTED")); };
    signal.addEventListener("abort", canceled, { once: true });
    promise.then(value => { signal.removeEventListener("abort", canceled); resolve(value); }, error => { signal.removeEventListener("abort", canceled); reject(error); });
    if (signal.aborted) canceled();
  });
}
