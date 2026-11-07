import type { AppDatabase } from "../database/database.ts";
import { parseStrictJson } from "../http/strict-json.ts";
import { authorizeMerchant, MerchantAccessError } from "./merchant-access.ts";
import type { MainOrderIdentity } from "./main-native-order.ts";
import { resolveDefaultMerchant } from "./default-merchant.ts";

type Options = {
  database: Pick<AppDatabase, "read" | "instanceId">;
  masterKey: Uint8Array;
  identityOrigin: string;
  publicOrigin: string;
  bridgeSecret?: string | undefined;
  send?: typeof fetch;
};

export async function readBoundedBody(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Buffer> {
  if (!body) throw new Error("request body is required");
  const reader = body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new Error("body exceeds limit");
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

async function identityJson(options: Options, path: string, init: RequestInit) {
  const origin = new URL(options.identityOrigin);
  if (origin.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(origin.hostname) || origin.pathname !== "/" || origin.username || origin.password || origin.search || origin.hash) throw new MerchantAccessError("unavailable");
  let response: Response;
  try { response = await (options.send ?? fetch)(new URL(path, origin), { ...init, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000) }); }
  catch { throw new MerchantAccessError("unavailable"); }
  if (response.status === 401) throw new MerchantAccessError("unauthenticated");
  if (response.status === 403 || response.status === 404) throw new MerchantAccessError("forbidden");
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new MerchantAccessError("unavailable");
  try {
    const value = parseStrictJson(await readBoundedBody(response.body, 8192));
    if (!value || typeof value !== "object" || Array.isArray(value) || (value as Record<string, unknown>).ok !== true) throw new Error("identity rejected");
    return value as Record<string, unknown>;
  } catch { throw new MerchantAccessError("unavailable"); }
}

export async function authenticateMainOrder(options: Options, request: Request, raw: string): Promise<MainOrderIdentity> {
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some(key => key !== "merchantId") || query.getAll("merchantId").length > 1) throw new MerchantAccessError("forbidden");
  const headerId = request.headers.get("x-merchant-id"), queryId = query.get("merchantId");
  if (headerId && queryId && headerId !== queryId) throw new MerchantAccessError("forbidden");
  let merchantId = queryId || headerId;
  let apiId: string, secret: string, callbackUrl: string;
  const signature = request.headers.get("x-lightpay-signature");
  const hasHmac = ["x-lightpay-signature", "x-lightpay-api-id", "x-lightpay-timestamp"].some(name => request.headers.has(name));
  if (hasHmac) {
    apiId = request.headers.get("x-lightpay-api-id") ?? "";
    const timestamp = request.headers.get("x-lightpay-timestamp") ?? "";
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(apiId) || !/^\d{10,11}$/.test(timestamp) || !/^sha256=[a-f0-9]{64}$/.test(signature ?? "")) throw new MerchantAccessError("unauthenticated");
    if (!options.bridgeSecret) throw new MerchantAccessError("unavailable");
    const access = await identityJson(options, "/api/internal/payment/merchant-auth", { method: "POST", headers: { "content-type": "application/json", "x-lightpay-bridge": options.bridgeSecret }, body: JSON.stringify({ apiId, timestamp, signature, raw }) });
    if (typeof access.merchantId !== "string" || (merchantId && merchantId !== access.merchantId)) throw new MerchantAccessError("forbidden");
    merchantId = access.merchantId;
    if (typeof access.callbackSecret !== "string" || typeof access.callbackUrl !== "string") throw new MerchantAccessError("unavailable");
    secret = access.callbackSecret;
    callbackUrl = access.callbackUrl;
  } else {
    if (request.headers.get("origin") !== options.publicOrigin || request.headers.get("sec-fetch-site") === "cross-site") throw new MerchantAccessError("forbidden");
    const cookie = request.headers.get("cookie") ?? "";
    if (!cookie || cookie.length > 8192) throw new MerchantAccessError("unauthenticated");
    if (!merchantId) {
      merchantId = await resolveDefaultMerchant({ database: options.database, identityOrigin: options.identityOrigin, cookie, send: options.send });
    }
    const access = await authorizeMerchant({ database: options.database, origin: options.identityOrigin, cookie, merchantId, ...(options.send ? { fetch: options.send } : {}) });
    apiId = access.mainApiId;
    const keys = await identityJson(options, `/api/merchant/keys?merchantId=${encodeURIComponent(merchantId)}`, { headers: { cookie, accept: "application/json" } });
    if (keys.apiId !== apiId || typeof keys.apiSecret !== "string") throw new MerchantAccessError("invalid_binding");
    secret = keys.apiSecret;
    const profile = await identityJson(options, `/api/merchant/profile?merchantId=${encodeURIComponent(merchantId)}`, { headers: { cookie, accept: "application/json" } });
    const merchant = profile.merchant as Record<string, unknown> | undefined;
    if (!merchant || merchant.id !== merchantId || merchant.apiId !== apiId || merchant.enabled !== true || typeof merchant.callbackUrl !== "string") throw new MerchantAccessError("invalid_binding");
    callbackUrl = merchant.callbackUrl;
  }
  if (!secret || secret.length > 4096 || !merchantId || merchantId.length > 80) throw new MerchantAccessError("unavailable");
  const binding = options.database.read(sql => sql.prepare(`SELECT b.epay_merchant_id FROM epay_merchant_bindings b JOIN epay_merchant_accounts m ON m.merchant_id=b.epay_merchant_id AND m.enabled=1 WHERE b.main_merchant_id=? AND b.main_api_id=?`).get(merchantId, apiId));
  const epayMerchantId = Number(binding?.epay_merchant_id);
  if (!Number.isSafeInteger(epayMerchantId) || epayMerchantId < 1) throw new MerchantAccessError("invalid_binding");
  return { merchantId, apiId, epayMerchantId, callbackSecret: secret, callbackUrl };
}
