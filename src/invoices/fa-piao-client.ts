import { createHmac, randomBytes } from "node:crypto";
import { readBoundedBody } from "../epay-compat/main-order-auth.ts";
import { parseStrictJson } from "../http/strict-json.ts";

const ORIGIN = "https://api.fa-piao.com";
const TIMEOUT_MS = 10_000;
const MAX_REPLY_BYTES = 64 * 1024;
const TOKEN_TTL_MS = 15 * 60_000;
const TOKEN_FAILURE_TTL_MS = 60_000;
const TOKEN_PATH = "/v5/enterprise/authorization";
const PATHS = {
  login: "/v5/enterprise/queryFaceAuthState",
  issue: "/v5/enterprise/blueTicket",
  details: "/v5/enterprise/retMsg",
  files: "/v5/enterprise/pdfOfdXml",
} as const;

export type FaPiaoCredentials = {
  appKey: string; appSecret: string; accountId: string; sellerTaxId: string; sellerName: string;
  username: string; plan: "6" | "7"; sellerAddressPhone?: string | undefined; sellerBankAccount?: string | undefined;
  platformFees?: { itemName: string; taxCode: string; taxRateBps: 100 | 300; enabled: boolean; validUntil: number } | undefined;
};
export type FaPiaoReply = { code: number; fields: Record<string, unknown> };
export class FaPiaoError extends Error {
  readonly code: string;
  readonly outcome: "NOT_SUBMITTED" | "UNKNOWN";
  constructor(code: string, outcome: "NOT_SUBMITTED" | "UNKNOWN") {
    super(`fa-piao protocol: ${code}`);
    this.name = "FaPiaoError";
    this.code = code;
    this.outcome = outcome;
  }
}

export function faPiaoSignature(method: string, path: string, nonce: string, timestamp: string, appKey: string, appSecret: string): string {
  const canonical = `Method=${method}&Path=${path}&RandomString=${nonce}&TimeStamp=${timestamp}&AppKey=${appKey}`;
  return createHmac("sha256", appSecret).update(canonical, "utf8").digest("hex").toUpperCase();
}

export function faPiaoFields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new FaPiaoError("invalid_response", "UNKNOWN");
  return value as Record<string, unknown>;
}

export function createFaPiaoClient(options: {
  credentials: FaPiaoCredentials; allowIssue: boolean; transport?: typeof fetch; clock?: () => number;
}) {
  const credentials = { ...options.credentials }, transport = options.transport ?? fetch, clock = options.clock ?? Date.now;
  let token: string | undefined, tokenUntil = 0, pendingToken: Promise<string> | undefined;
  let tokenFailure: FaPiaoError | undefined, retryTokenAt = 0;

  async function request(path: string, body: Record<string, unknown>, authorization?: string, signal?: AbortSignal): Promise<FaPiaoReply> {
    const isIssue = path === PATHS.issue;
    if (isIssue && !options.allowIssue) throw new FaPiaoError("issuance_disabled", "NOT_SUBMITTED");
    if (signal?.aborted) throw new FaPiaoError("request_aborted", "NOT_SUBMITTED");
    const timestamp = clock();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new FaPiaoError("invalid_clock", "NOT_SUBMITTED");
    const nonce = randomBytes(10).toString("hex"), seconds = String(Math.floor(timestamp / 1000));
    const rawBody = JSON.stringify(body);
    if (Buffer.byteLength(rawBody, "utf8") > 256 * 1024) throw new FaPiaoError("request_too_large", "NOT_SUBMITTED");
    try {
      const response = await transport(`${ORIGIN}${path}`, {
        method: "POST", redirect: "error", cache: "no-store",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          "Content-Type": "application/json", Accept: "application/json", AppKey: credentials.appKey,
          TimeStamp: seconds, RandomString: nonce,
          Sign: faPiaoSignature("POST", path, nonce, seconds, credentials.appKey, credentials.appSecret),
          ...(authorization ? { Authorization: authorization } : {}),
        }, body: rawBody,
      });
      if (!response.ok) throw new Error("upstream HTTP failure");
      const fields = faPiaoFields(parseStrictJson(await readBoundedBody(response.body, MAX_REPLY_BYTES)));
      if (!Number.isSafeInteger(fields.code)) throw new Error("missing provider code");
      return { code: Number(fields.code), fields };
    } catch {
      // A transport failure cannot establish whether a tax invoice was issued.
      throw new FaPiaoError("response_unavailable", isIssue ? "UNKNOWN" : "NOT_SUBMITTED");
    }
  }

  async function acquireToken(signal?: AbortSignal): Promise<string> {
    const reply = await request(TOKEN_PATH, { nsrsbh: credentials.sellerTaxId, type: credentials.plan, username: credentials.username }, undefined, signal);
    if (reply.code !== 200) throw new FaPiaoError(providerError(reply.code, reply.fields), "NOT_SUBMITTED");
    const grant = faPiaoFields(reply.fields.data).token;
    if (typeof grant !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(grant)) throw new FaPiaoError("invalid_token", "NOT_SUBMITTED");
    token = grant;
    tokenFailure = undefined; retryTokenAt = 0;
    tokenUntil = clock() + TOKEN_TTL_MS;
    return grant;
  }

  async function accessToken(signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new FaPiaoError("request_aborted", "NOT_SUBMITTED");
    if (token && clock() < tokenUntil) return token;
    if (tokenFailure && clock() < retryTokenAt) throw tokenFailure;
    pendingToken ??= acquireToken(signal).catch(error => {
      if (error instanceof FaPiaoError && error.code !== "request_aborted") { tokenFailure = error; retryTokenAt = clock() + TOKEN_FAILURE_TTL_MS; }
      throw error;
    }).finally(() => { pendingToken = undefined; });
    return pendingToken;
  }

  async function authenticated(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<FaPiaoReply> {
    const reply = await request(path, { ...body, username: credentials.username }, await accessToken(signal), signal);
    // Refresh only the next call. An issuance request is never replayed automatically.
    if (reply.code === 401) { token = undefined; tokenUntil = 0; }
    return reply;
  }

  return {
    async checkLogin(signal?: AbortSignal, fresh = false) {
      if (fresh) { tokenFailure = undefined; retryTokenAt = 0; }
      return authenticated(PATHS.login, { nsrsbh: credentials.sellerTaxId }, signal);
    },
    async issueBlue(body: Record<string, unknown>) {
      if (!options.allowIssue) throw new FaPiaoError("issuance_disabled", "NOT_SUBMITTED");
      return authenticated(PATHS.issue, body);
    },
    async invoiceDetails(invoiceNo: string, signal?: AbortSignal) {
      return authenticated(PATHS.details, { nsrsbh: credentials.sellerTaxId, fphm: invoiceNo, sqyy: "2" }, signal);
    },
    async invoiceFiles(invoiceNo: string) {
      return authenticated(PATHS.files, { nsrsbh: credentials.sellerTaxId, fphm: invoiceNo, downflag: "4" });
    },
  };
}

export function providerError(code: number, fields?: Record<string, unknown>): string {
  const message = [fields?.msg, typeof fields?.data === "string" ? fields.data : ""].filter(value => typeof value === "string").join(" ");
  if (code === 3002 || /服务.*(?:到期|过期)|(?:续费|续期)/.test(message)) return "fapiao_service_expired";
  if (code === 420) return "fapiao_sms_required";
  if (code === 430) return "fapiao_face_required";
  if (code === 401) return "fapiao_authorization_expired";
  return `fapiao_code_${code}`;
}
