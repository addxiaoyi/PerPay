export interface ShadowOrderPage {
  orders: Array<{
    id: string;
    merchantOrderId: string;
    name: string;
    amount: string;
    status: string;
    createdAt: string;
    paidAt: string | null;
    source: "epay";
    canInvoice: false;
  }>;
  pageInfo: { page: number; pageSize: number; total: number; totalPages: number; hasNext: boolean; hasPrevious: boolean };
}

export class ShadowOrdersError extends Error {
  readonly status: number;
  constructor(status: number) {
    super("Shadow order service unavailable");
    this.status = status;
  }
}

const MAX_RESPONSE_BYTES = 256 * 1024;
const ORDER_STATUSES = new Set(["pending_payment", "paid", "refunded", "frozen", "closed", "unknown"]);
const FILTER_STATUSES = { PENDING: "pending_payment", PAID: "paid", REFUNDED: "refunded", FROZEN: "frozen", CLOSED: "closed" } as const;
type FilterStatus = keyof typeof FILTER_STATUSES;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 30 && Number.isFinite(Date.parse(value));
}

function validOrder(value: unknown): value is ShadowOrderPage["orders"][number] {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && value.id.startsWith("epay_") && value.id.length > 5 && value.id.length <= 69
    && typeof value.merchantOrderId === "string" && value.merchantOrderId.length <= 128
    && typeof value.name === "string" && value.name.length <= 512
    && typeof value.amount === "string" && value.amount.length <= 18 && /^(0|[1-9]\d*)\.\d{2}$/.test(value.amount)
    && typeof value.status === "string" && ORDER_STATUSES.has(value.status)
    && validDate(value.createdAt) && (value.paidAt === null || validDate(value.paidAt))
    && value.source === "epay" && value.canInvoice === false;
}

export async function readShadowOrders(input: { origin: string; cookie: string; merchantId: string; page: number; pageSize: number; status?: FilterStatus; search?: string; fetch?: typeof fetch }): Promise<ShadowOrderPage> {
  let origin: URL;
  try { origin = new URL(input.origin); } catch { throw new ShadowOrdersError(503); }
  if (origin.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(origin.hostname) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new ShadowOrdersError(503);
  if (!input.cookie || input.cookie.length > 8192 || /[\r\n]/.test(input.cookie)) throw new ShadowOrdersError(401);
  if (!input.merchantId || input.merchantId.length > 128 || input.merchantId.trim() !== input.merchantId || !Number.isSafeInteger(input.page) || input.page < 1 || input.page > 99999 || !Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 100) throw new ShadowOrdersError(400);
  if ((input.status !== undefined && !Object.hasOwn(FILTER_STATUSES, input.status)) || (input.search !== undefined && (typeof input.search !== "string" || input.search.trim().length > 150 || /[\x00-\x1f\x7f]/.test(input.search)))) throw new ShadowOrdersError(400);
  const url = new URL("/api/merchant/epay/orders", origin);
  const query = new URLSearchParams({ merchantId: input.merchantId, page: String(input.page), pageSize: String(input.pageSize), format: "legacy" });
  if (input.status) query.set("status", input.status);
  if (input.search?.trim()) query.set("search", input.search.trim());
  url.search = query.toString();
  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(url, { headers: { accept: "application/json", cookie: input.cookie }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5000) });
  } catch { throw new ShadowOrdersError(503); }
  if (response.status === 401 || response.status === 404) throw new ShadowOrdersError(response.status);
  if (!response.ok || !(response.headers.get("content-type") ?? "").toLowerCase().includes("application/json") || !response.body) throw new ShadowOrdersError(503);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("response too large");
      chunks.push(part.value);
    }
  } catch { throw new ShadowOrdersError(503); }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ShadowOrdersError(503); }
  if (!isRecord(body) || body.ok !== true || !isRecord(body.data)) throw new ShadowOrdersError(503);
  const { merchantId, scope, invoiceAvailable, orders, pageInfo } = body.data;
  if (merchantId !== input.merchantId || scope !== "epay_only" || invoiceAvailable !== false || !Array.isArray(orders) || orders.length > input.pageSize || !orders.every(validOrder) || !isRecord(pageInfo)) throw new ShadowOrdersError(503);
  if (input.status && orders.some((order) => order.status !== FILTER_STATUSES[input.status!])) throw new ShadowOrdersError(503);
  const { page, pageSize, total, totalPages, hasNext, hasPrevious } = pageInfo;
  if (page !== input.page || pageSize !== input.pageSize || !Number.isSafeInteger(total) || (total as number) < 0 || !Number.isSafeInteger(totalPages) || totalPages !== Math.max(1, Math.ceil((total as number) / input.pageSize)) || typeof hasNext !== "boolean" || typeof hasPrevious !== "boolean" || hasNext !== (input.page * input.pageSize < (total as number)) || hasPrevious !== (input.page > 1)) throw new ShadowOrdersError(503);
  const safeOrders = orders.map(({ id, merchantOrderId, name, amount, status, createdAt, paidAt, source, canInvoice }) => ({ id, merchantOrderId, name, amount, status, createdAt, paidAt, source, canInvoice }));
  return { orders: safeOrders, pageInfo: { page: input.page, pageSize: input.pageSize, total: total as number, totalPages: totalPages as number, hasNext, hasPrevious } };
}
