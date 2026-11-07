import { isIP } from "node:net";
import type { AppDatabase } from "../database/database.ts";
import { parseStrictJson } from "../http/strict-json.ts";

type Role = "admin" | "owner" | "member";
type Access = { merchantId: string; role: Role; userId?: string };
type Binding = { main_merchant_id: string; main_api_id: string; epay_merchant_id: number | bigint };

export class MerchantAccessError extends Error {
  readonly code: "unauthenticated" | "forbidden" | "unavailable" | "invalid_binding";
  constructor(code: "unauthenticated" | "forbidden" | "unavailable" | "invalid_binding") {
    super(`merchant access ${code}`);
    this.code = code;
  }
}

export async function authorizeMerchant(options: {
  origin: string;
  cookie: string;
  merchantId: string;
  database: Pick<AppDatabase, "read">;
  fetch?: typeof fetch;
}): Promise<Access & { epayMerchantId: number; mainApiId: string }> {
  if (!options.cookie || options.cookie.length > 8192 || /[\r\n]/.test(options.cookie)) throw new MerchantAccessError("unauthenticated");
  if (!options.merchantId || options.merchantId !== options.merchantId.trim() || options.merchantId.length > 128) throw new MerchantAccessError("forbidden");
  let origin: URL;
  try { origin = new URL(options.origin); } catch { throw new MerchantAccessError("unavailable"); }
  const host = origin.hostname === "[::1]" ? "::1" : origin.hostname;
  if (origin.protocol !== "http:" || !["127.0.0.1", "::1"].includes(host) || isIP(host) === 0 || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new MerchantAccessError("unavailable");
  const target = new URL("/api/merchant/access", origin);
  target.searchParams.set("merchantId", options.merchantId);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(target, { method: "GET", headers: { accept: "application/json", cookie: options.cookie }, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000) });
  } catch { throw new MerchantAccessError("unavailable"); }
  if (response.status === 401) throw new MerchantAccessError("unauthenticated");
  if (response.status === 403 || response.status === 404) throw new MerchantAccessError("forbidden");
  if (!response.ok || !(response.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) throw new MerchantAccessError("unavailable");
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > 4096)) throw new MerchantAccessError("unavailable");
  let body: unknown;
  try {
    if (!response.body) throw new Error("empty response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 4096) throw new Error("response too large");
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    body = parseStrictJson(Buffer.concat(chunks));
  } catch { throw new MerchantAccessError("unavailable"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new MerchantAccessError("unavailable");
  const access = body as { ok?: unknown; merchantId?: unknown; apiId?: unknown; role?: unknown; userId?: unknown };
  if (access.ok !== true || access.merchantId !== options.merchantId || typeof access.role !== "string" || !["admin", "owner", "member"].includes(access.role)) throw new MerchantAccessError("forbidden");
  if (typeof access.apiId !== "string" || !access.apiId || access.apiId !== access.apiId.trim() || access.apiId.length > 80) throw new MerchantAccessError("invalid_binding");
  const binding = options.database.read((db) => db.prepare(`SELECT b.main_merchant_id, b.main_api_id, b.epay_merchant_id FROM epay_merchant_bindings b
    JOIN epay_merchant_accounts m ON m.merchant_id = b.epay_merchant_id AND m.enabled = 1
    WHERE b.main_merchant_id = ?`).get(options.merchantId)) as Binding | undefined;
  const epayMerchantId = Number(binding?.epay_merchant_id);
  if (!binding || binding.main_merchant_id !== options.merchantId || binding.main_api_id !== access.apiId || !Number.isSafeInteger(epayMerchantId) || epayMerchantId < 1) throw new MerchantAccessError("invalid_binding");
  if (access.userId !== undefined && (typeof access.userId !== "string" || !access.userId || access.userId !== access.userId.trim() || access.userId.length > 128 || /[\x00-\x1f\x7f]/.test(access.userId))) throw new MerchantAccessError("unavailable");
  return { merchantId: options.merchantId, role: access.role as Role, epayMerchantId, mainApiId: access.apiId, ...(typeof access.userId === "string" ? { userId: access.userId } : {}) };
}

// Identity alone does not authorize a financial write or replace CSRF protection.
export async function authorizeMainAdmin(options: Parameters<typeof authorizeMerchant>[0]) {
  const access = await authorizeMerchant(options);
  if (access.role !== "admin" || !access.userId) throw new MerchantAccessError("forbidden");
  return { ...access, role: "admin" as const, userId: access.userId };
}
