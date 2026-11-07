export type CombinedShadowOrder = { id: string; merchantOrderId: string; amountCents: number; status: string; createdAt: string; source: "main_site" | "epay" };
export type CombinedShadowPage = { merchantId: string; orders: CombinedShadowOrder[]; page: number; pageSize: number; hasNext: boolean; scope: "unreconciled_sources"; deduplicated: false; reconciled: false };

export class CombinedShadowError extends Error {
  readonly status: number;
  constructor(status: number) { super("Combined shadow orders unavailable"); this.status = status; }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function order(value: unknown): value is CombinedShadowOrder {
  if (!record(value)) return false;
  return typeof value.id === "string" && value.id.length > 0 && value.id.length <= 128
    && typeof value.merchantOrderId === "string" && value.merchantOrderId.length > 0 && value.merchantOrderId.length <= 150
    && Number.isSafeInteger(value.amountCents) && Number(value.amountCents) >= 0
    && typeof value.status === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value.status)
    && typeof value.createdAt === "string" && value.createdAt.length <= 40 && Number.isFinite(Date.parse(value.createdAt))
    && (value.source === "main_site" || value.source === "epay");
}

export async function readCombinedShadowOrders(input: { origin: string; cookie: string; merchantId: string; page: number; pageSize: number; fetch?: typeof fetch }): Promise<CombinedShadowPage> {
  let origin: URL;
  try { origin = new URL(input.origin); } catch { throw new CombinedShadowError(503); }
  if (origin.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(origin.hostname) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new CombinedShadowError(503);
  if (!input.cookie || input.cookie.length > 8192 || /[\r\n]/.test(input.cookie)) throw new CombinedShadowError(401);
  if (!input.merchantId || input.merchantId.length > 128 || input.merchantId.trim() !== input.merchantId || !Number.isSafeInteger(input.page) || input.page < 1 || input.page > 99999 || !Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 100) throw new CombinedShadowError(400);
  const url = new URL("/api/merchant/epay/combined-orders", origin);
  url.search = new URLSearchParams({ merchantId: input.merchantId, page: String(input.page), pageSize: String(input.pageSize) }).toString();
  let response: Response;
  try { response = await (input.fetch ?? fetch)(url, { headers: { accept: "application/json", cookie: input.cookie }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5000) }); }
  catch { throw new CombinedShadowError(503); }
  if (response.status === 401 || response.status === 404) throw new CombinedShadowError(response.status);
  if (!response.ok || !(response.headers.get("content-type") ?? "").toLowerCase().includes("application/json") || !response.body) throw new CombinedShadowError(503);
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 256 * 1024) throw new Error("response too large");
      chunks.push(part.value);
    }
  } catch { throw new CombinedShadowError(503); }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new CombinedShadowError(503); }
  if (!record(body) || body.ok !== true || !record(body.data)) throw new CombinedShadowError(503);
  const data = body.data;
  if (data.merchantId !== input.merchantId || data.page !== input.page || data.pageSize !== input.pageSize || data.scope !== "unreconciled_sources" || data.deduplicated !== false || data.reconciled !== false || typeof data.hasNext !== "boolean" || !Array.isArray(data.orders) || data.orders.length > input.pageSize || (data.hasNext && data.orders.length !== input.pageSize) || !data.orders.every(order)) throw new CombinedShadowError(503);
  const seen = new Set<string>();
  const orders = data.orders.map(({ id, merchantOrderId, amountCents, status, createdAt, source }) => {
    const key = JSON.stringify([source, id]);
    if (seen.has(key)) throw new CombinedShadowError(503);
    seen.add(key);
    return { id, merchantOrderId, amountCents, status, createdAt, source };
  });
  return { merchantId: input.merchantId, orders, page: input.page, pageSize: input.pageSize, hasNext: data.hasNext, scope: "unreconciled_sources", deduplicated: false, reconciled: false };
}
