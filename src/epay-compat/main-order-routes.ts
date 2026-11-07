import { Hono } from "hono";
import type { AppDatabase } from "../database/database.ts";
import { parseStrictJson } from "../http/strict-json.ts";
import { authenticateMainOrder, readBoundedBody } from "./main-order-auth.ts";
import { createMainNativeOrder, LegacyMainOrder, MainOrderConflict, MainOrderInputError } from "./main-native-order.ts";
import { MerchantAccessError } from "./merchant-access.ts";
import { issueCheckoutToken, verifyCheckoutToken } from "./isolated-checkout-status.ts";
import { isolatedCheckout, checkoutNotice } from "./isolated-checkout.ts";
import { readMainOrder, storedMainQr } from "./main-order-view.ts";
import { createMainPaymentRoutes } from "./main-payment-routes.ts";
import { createMainOrderList } from "./main-order-list.ts";
import { readAlipayWebUrl } from "./alipay-web.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";

type Database = Pick<AppDatabase, "read" | "write" | "instanceId">;
type Gateway = { fetch(request: Request): Response | Promise<Response> };
type Options = {
  database: Database; masterKey: Uint8Array; identityOrigin: string; publicOrigin: string; basePath: string;
  bridgeSecret?: string | undefined; send?: typeof fetch; clock?: () => number;
  alipayScanEnabled?: boolean;
  invoiceFeeCents?: number | undefined; canRequestInvoice?: () => boolean;
  wechatCredentialId?: string | undefined; alipay: Gateway; alipayWeb?: Gateway | undefined; wechat: Gateway; onError: (code: string) => void;
};

export function createMainOrderRoutes(options: Options) {
  const app = new Hono(), clock = options.clock ?? Date.now;
  app.use("*", async (context, next) => { context.header("Cache-Control", "no-store"); await next(); });
  app.route("/payment", createMainPaymentRoutes(options));
  app.route("/", createMainOrderList(options));
  app.onError((error, context) => {
    if (error instanceof MerchantAccessError) return context.json({ ok: false, error: error.code }, error.code === "unauthenticated" ? 401 : error.code === "unavailable" ? 503 : 403);
    if (error instanceof MainOrderInputError) return context.json({ ok: false, error: "订单参数无效，当前支持支付宝网页、支付宝扫码和微信扫码。", code: "invalid_order" }, 400);
    if (error instanceof LegacyMainOrder) return context.json({ ok: false, error: "该订单由原支付系统处理，请查询原订单。", code: "legacy_order_owned" }, 409);
    if (error instanceof MainOrderConflict) return context.json({ ok: false, error: "订单号已使用且参数不一致。", code: "order_conflict" }, 409);
    options.onError("main_order_request_failed");
    return context.json({ ok: false, error: "暂时无法处理订单，请使用原订单号重试。", code: "order_unavailable" }, 503);
  });
  app.post("/orders", async context => {
    if (!/^application\/json(?:;|$)/i.test(context.req.header("content-type") ?? "")) return context.json({ ok: false, error: "invalid_content_type" }, 415);
    let raw: string, input: unknown;
    try { const bytes = await readBoundedBody(context.req.raw.body, 8192); raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); input = parseStrictJson(bytes); }
    catch { return context.json({ ok: false, error: "invalid_body" }, 400); }
    const identity = await authenticateMainOrder(options, context.req.raw, raw);
    if (options.alipayScanEnabled === false && input && typeof input === "object" && "channel" in input && input.channel === "alipay_scan") {
      return context.json({ ok: false, code: "channel_unavailable", error: "当前支付宝通道使用网页收银台，请选择支付宝网页支付。" }, 400);
    }
    const created = createMainNativeOrder({ database: options.database, masterKey: options.masterKey, identity, input, now: clock(), ...(options.wechatCredentialId ? { wechatCredentialId: options.wechatCredentialId } : {}) });
    const before = readMainOrder(options, created.orderId, identity.epayMerchantId, clock());
    if (before.status === "pending_sync" && !storedMainQr(options, created.tradeNo, identity.epayMerchantId)) {
      const web = options.database.read(sql => Boolean(sql.prepare("SELECT 1 FROM epay_alipay_web_orders WHERE trade_no=?").get(created.tradeNo)));
      const gateway = web ? options.alipayWeb : created.params.type === "alipay" ? options.alipay : options.wechat;
      if (!gateway) throw new Error("requested payment mode is unavailable");
      // Only normalized, internally signed fields reach the exact channel adapters.
      const response = await gateway.fetch(new Request("https://perpay.internal/mapi.php", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(created.params) }));
      await response.body?.cancel();
    }
    const now = clock(), token = issueCheckoutToken(options.masterKey, options.database.instanceId(), created.tradeNo, identity.epayMerchantId, now);
    const order = readMainOrder(options, created.orderId, identity.epayMerchantId, now);
    const root = `${options.publicOrigin}${options.basePath === "/" ? "" : options.basePath}/epay/main`;
    const checkoutUrl = `${root}/checkout/${created.orderId}?token=${encodeURIComponent(token)}`;
    return context.json({ ok: true, order, checkoutToken: token, checkoutUrl, access: created.access, duplicate: !created.created }, order.status === "pending_sync" ? 202 : created.created ? 201 : 200);
  });
  app.get("/checkout/:id", async context => {
    const query = new URL(context.req.url).searchParams, tokens = query.getAll("token");
    if (tokens.length !== 1 || [...query.keys()].some(key => key !== "token")) return checkoutNotice("订单链接无效", "请返回商户重新获取收款链接。", 404);
    const token = tokens[0]!, identity = verifyCheckoutToken(token, options.masterKey, options.database.instanceId(), clock());
    if (!identity) return checkoutNotice("收款链接已失效", "链接已过期或无效，请返回商户重新获取；已经付款的订单请勿重复支付。", 404);
    const mapping = options.database.read(sql => sql.prepare("SELECT order_id FROM epay_main_native_orders WHERE trade_no=? AND merchant_id=?").get(identity.tradeNo, identity.merchantId));
    if (mapping?.order_id !== context.req.param("id")) return checkoutNotice("订单链接无效", "请返回商户重新获取收款链接。", 404);
    const qr = storedMainQr(options, identity.tradeNo, identity.merchantId);
    const order = readMainOrder(options, String(mapping.order_id), identity.merchantId, clock());
    if (order.status === "pending_payment" && order.channel === "alipay_web") {
      const url = options.database.read(sql => readAlipayWebUrl(sql, new RuntimeSecretCipher(options.masterKey, options.database.instanceId()), identity.tradeNo));
      if (url) return context.redirect(url, 303);
    }
    if (order.status !== "pending_payment" || !qr) {
      const messages: Record<string, [string, string]> = {
        pending_sync: ["暂未获取到收款信息", "订单已保存，支付渠道尚未返回可付款信息。请联系商户查询或选择其他支付方式，请勿重复付款。"],
        paid: ["付款已确认", "请返回商户查看订单，勿重复付款。"],
        expired: ["订单已过期", "当前收款链接已不能付款，请返回商户重新创建订单。"],
        closed: ["订单已关闭", "当前收款链接已不能付款，请返回商户核对订单。"],
        refunded: ["订单已退款", "请返回商户查看退款记录。"],
      };
      const [title, message] = messages[order.status] ?? ["订单正在处理中", "请返回商户核对最新状态，勿重复付款。"];
      return checkoutNotice(title, message, order.status === "pending_sync" ? 202 : 200, { name: order.name, amountCents: order.amountCents });
    }
    const endpoint = `${options.basePath === "/" ? "" : options.basePath}/epay/checkout-status`;
    return isolatedCheckout(qr, String(order.name), order.amountCents, token, endpoint);
  });
  return app;
}
