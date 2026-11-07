import { Hono } from "hono";
import { createExactAlipayOrder } from "./exact-alipay-order.ts";
import { readEPayParams } from "./shadow-gateway.ts";
import { prepareAlipayWebPayment, recordAlipayWebMode, type AlipayWebOptions } from "./alipay-web.ts";
import { verifyCheckoutToken } from "./isolated-checkout-status.ts";
import { paymentWaitingPage } from "./isolated-checkout.ts";

export function createAlipayWebGateway(options: AlipayWebOptions, product: "pc" | "wap" = "pc") {
  const app = new Hono();
  app.on(["GET", "POST"], ["/submit.php", "/mapi.php"], async context => {
    context.header("Cache-Control", "no-store");
    try {
      const params = await readEPayParams(context.req.raw), mode = context.req.path.endsWith("submit.php") ? "page" : "api";
      const now = (options.clock ?? Date.now)();
      const order = options.database.write(sql => {
        const transaction = { write: <T>(action: (connection: typeof sql) => T) => action(sql), instanceId: () => options.database.instanceId() };
        const order = createExactAlipayOrder(transaction, options.masterKey, params, mode, now, "web");
        if (!order.created && !sql.prepare("SELECT 1 FROM epay_alipay_web_orders WHERE trade_no=?").get(order.tradeNo)) throw new Error("existing order has another Alipay product");
        recordAlipayWebMode(sql, order.tradeNo, product, now);
        return order;
      });
      const url = prepareAlipayWebPayment(options, order.tradeNo);
      return mode === "page" ? context.redirect(url, 303) : context.json({ code: 1, type: "jump", trade_no: order.tradeNo, payurl: url });
    } catch {
      return context.json({ code: -1, msg: "订单参数、签名或支付状态无效，请核对后重试。" }, 400);
    }
  });
  return app;
}

export function createAlipayWebReturn(options: Pick<AlipayWebOptions, "database" | "masterKey" | "clock">, basePath: string) {
  const app = new Hono();
  app.get("/alipay/return", async context => {
    const query = new URL(context.req.url).searchParams, tokens = query.getAll("token");
    const identity = tokens.length === 1 ? verifyCheckoutToken(tokens[0]!, options.masterKey, options.database.instanceId(), (options.clock ?? Date.now)()) : null;
    if (!identity) return context.text("订单访问凭证无效或已过期，请返回商户查看订单。", 404);
    const exists = options.database.read(sql => sql.prepare(`SELECT 1 FROM epay_alipay_web_orders w JOIN epay_orders o ON o.trade_no=w.trade_no WHERE w.trade_no=? AND o.merchant_id=?`).get(identity.tradeNo, identity.merchantId));
    if (!exists) return context.text("订单不存在。", 404);
    // Redirect parameters are never payment evidence; polling reads only verified settlement.
    return paymentWaitingPage(tokens[0]!, `${basePath === "/" ? "" : basePath}/epay/checkout-status`);
  });
  return app;
}
