import { Hono } from "hono";
import type { AppDatabase } from "../database/database.ts";
import { parseStrictJson } from "../http/strict-json.ts";
import { verifyCheckoutToken } from "./isolated-checkout-status.ts";
import { readBoundedBody } from "./main-order-auth.ts";
import { verifyMainOrderAccess } from "./main-order-access.ts";
import { readMainOrder, publicMainOrder } from "./main-order-view.ts";
import { MainInvoiceError, requestMainInvoice } from "./main-invoice-request.ts";

type Options = {
  database: Pick<AppDatabase, "read" | "write" | "instanceId">;
  masterKey: Uint8Array;
  identityOrigin: string;
  send?: typeof fetch;
  clock?: () => number;
  invoiceFeeCents?: number | undefined;
  canRequestInvoice?: () => boolean;
};
const messages: Record<string, string> = {
  invoice_validation_error: "请填写有效的发票抬头、税号和邮箱。", invoice_fee_unconfigured: "开票服务暂未开放。",
  invoice_access_denied: "订单不存在或访问凭证无效。", invoice_not_ready: "订单尚未确认支付成功。",
  invoice_already_requested: "该订单已有开票申请，请勿重复提交不同资料。", invoice_fee_insufficient_balance: "商户余额不足以支付开票服务费。",
};

// Legacy capabilities stay with their original owner; this proxy cannot create orders.
async function legacyPayment(options: Options, request: Request, kind: string, id: string, body?: string) {
  const origin = new URL(options.identityOrigin);
  if (origin.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(origin.hostname) || origin.pathname !== "/" || origin.username || origin.password || origin.search || origin.hash) throw new Error("legacy payment origin is invalid");
  const target = new URL(`/api/payment/${kind}/${id}`, origin);
  target.search = new URL(request.url).search;
  const response = await (options.send ?? fetch)(target, { method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body, headers: { "content-type": "application/json" } }), redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000) });
  if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("legacy payment response is not JSON");
  const bytes = await readBoundedBody(response.body, 65_536);
  parseStrictJson(bytes);
  return new Response(Uint8Array.from(bytes), { status: response.status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

export function createMainPaymentRoutes(options: Options) {
  const app = new Hono(), clock = options.clock ?? Date.now;
  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store"); context.header("Referrer-Policy", "no-referrer");
    const query = new URL(context.req.url).searchParams;
    if (query.getAll("token").length > 1 || [...query.keys()].some(key => key !== "token")) return context.json({ ok: false, error: "访问凭证无效。", code: "invalid_query" }, 400);
    await next();
  });
  const native = (id: string) => options.database.read(sql => sql.prepare("SELECT merchant_id,trade_no FROM epay_main_native_orders WHERE order_id=?").get(id));
  app.get("/:kind{checkout|order|receipt}/:id", async context => {
    const id = context.req.param("id"), kind = context.req.param("kind"), row = native(id);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) return context.json({ ok: false, error: "订单不存在。", code: "order_not_found" }, 404);
    if (!row) return legacyPayment(options, context.req.raw, kind, id);
    const token = context.req.query("token"), now = clock();
    const checkout = kind === "checkout" && token ? verifyCheckoutToken(token, options.masterKey, options.database.instanceId(), now) : null;
    const grant = kind === "checkout" ? null : options.database.read(sql => verifyMainOrderAccess(sql, token, kind === "receipt" ? "receipt:read" : "order:read", id, now));
    if (kind === "checkout" ? !checkout || checkout.tradeNo !== row.trade_no || checkout.merchantId !== Number(row.merchant_id) : !grant) return context.json({ ok: false, error: "订单不存在或访问凭证无效。", code: `${kind}_access_denied` }, 404);
    const order = readMainOrder(options, id, Number(row.merchant_id), now);
    if (kind === "receipt") {
      if (order.status !== "paid") return context.json({ ok: false, error: "订单尚未支付成功。", code: "receipt_not_ready" }, 409);
      return context.json({ ok: true, receipt: { receiptNo: `R-${id}`, order: publicMainOrder(order), issuedAt: order.paidAt } });
    }
    return context.json({ ok: true, order: kind === "checkout" ? order : publicMainOrder(order) });
  });
  app.post("/invoice/:id", async context => {
    const id = context.req.param("id");
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) return context.json({ ok: false, error: "订单不存在。", code: "order_not_found" }, 404);
    if (!/^application\/json(?:;|$)/i.test(context.req.header("content-type") ?? "")) return context.json({ ok: false, error: "请求格式应为 JSON。", code: "invalid_content_type" }, 415);
    let body: Record<string, unknown>, raw: string;
    try {
      const bytes = await readBoundedBody(context.req.raw.body, 8192), parsed = parseStrictJson(bytes);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invoice body must be an object");
      body = parsed as Record<string, unknown>; raw = bytes.toString("utf8");
    } catch { return context.json({ ok: false, error: "开票资料格式无效。", code: "invalid_body" }, 400); }
    const queryToken = context.req.query("token"), { token: bodyToken, ...input } = body;
    if (queryToken && bodyToken && queryToken !== bodyToken) return context.json({ ok: false, error: messages.invoice_access_denied, code: "invoice_access_denied" }, 404);
    if (!options.canRequestInvoice?.()) return context.json({ ok: false, error: "暂未开放新的开票申请，历史发票仍可查看。", code: "invoice_maintenance" }, 503);
    if (!native(id)) return legacyPayment(options, context.req.raw, "invoice", id, raw);
    try {
      const requested = requestMainInvoice(options.database, { orderId: id, token: bodyToken ?? queryToken, input, feeCents: options.invoiceFeeCents, now: clock() });
      return context.json({ ok: true, ...requested }, requested.duplicate ? 200 : 201);
    } catch (error) {
      if (!(error instanceof MainInvoiceError)) throw error;
      const code = error.message;
      const status = code === "invoice_access_denied" ? 404 : code === "invoice_validation_error" ? 400 : code === "invoice_fee_unconfigured" ? 503 : 409;
      return context.json({ ok: false, error: messages[code], code }, status);
    }
  });
  return app;
}
