import { randomUUID } from "node:crypto";
import { Hono } from "hono";

import { parseStrictJson } from "../http/strict-json.ts";
import { validateEPayOrder, type EPayMerchantIdentity, type EPayOrderRequest } from "./order-request.ts";

const MAX_BODY_BYTES = 16 * 1024;

export function createEPayShadowGateway(merchants: readonly EPayMerchantIdentity[]) {
  const app = new Hono();
  const identities = new Map(merchants.map((merchant) => [String(merchant.merchantId), merchant]));
  const orders = new Map<string, { tradeNo: string; fingerprint: string }>();

  app.on(["GET", "POST"], ["/submit.php", "/mapi.php"], async (context) => {
    try {
      const params = await readEPayParams(context.req.raw);
      const merchant = identities.get(params.pid ?? "");
      if (!merchant) return context.json({ code: -1, msg: "商户认证失败", shadow: true }, 401);
      const mode = context.req.path === "/mapi.php" ? "api" : "page";
      const order = validateEPayOrder(params, merchant, mode);
      const fingerprint = orderFingerprint(order);
      const existing = orders.get(order.idempotencyKey);
      if (existing && existing.fingerprint !== fingerprint) return context.json({ code: -1, msg: "订单参数不一致", shadow: true }, 409);
      const tradeNo = existing?.tradeNo ?? randomUUID();
      if (!existing) orders.set(order.idempotencyKey, { tradeNo, fingerprint });
      return context.json({ code: 0, msg: "影子订单未发起支付", trade_no: tradeNo, shadow: true }, 202);
    } catch {
      return context.json({ code: -1, msg: "请求或签名无效", shadow: true }, 400);
    }
  });
  return app;
}

function orderFingerprint(order: EPayOrderRequest): string {
  return JSON.stringify([order.merchantId, order.merchantOrderNo, order.amountCents, order.name, order.type, order.notifyUrl, order.returnUrl, order.param, order.device, order.openid]);
}

export async function readEPayParams(request: Request): Promise<Record<string, string>> {
  if (request.url.length > MAX_BODY_BYTES) throw new Error("request target too large");
  const query = new URL(request.url).searchParams;
  if (request.method !== "GET" && [...query].length) throw new Error("query parameters are not allowed with a request body");
  if ([...query].length) return uniqueParams(query);
  if (request.method === "GET") return {};
  const bytes = await readBody(request);
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (contentType === "application/json") {
    const body = parseStrictJson(bytes);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid JSON body");
    const result: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [key, value] of Object.entries(body)) {
      if (typeof value !== "string" && typeof value !== "number") throw new Error("invalid JSON field");
      result[key] = String(value);
    }
    return result;
  }
  if (contentType !== "application/x-www-form-urlencoded") throw new Error("unsupported content type");
  return uniqueParams(new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
}

function uniqueParams(input: URLSearchParams): Record<string, string> {
  const params: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of input) {
    if (Object.hasOwn(params, key)) throw new Error("duplicate parameter");
    params[key] = value;
  }
  return params;
}

async function readBody(request: Request): Promise<Uint8Array> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new Error("body too large");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new Error("body too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
