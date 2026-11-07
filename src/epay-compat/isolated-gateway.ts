import { Hono } from "hono";
import { readEPayParams } from "./shadow-gateway.ts";

type Gateway = { fetch(request: Request): Response | Promise<Response> };

// The caller must supply isolated handlers and must not mount this on production ingress.
export function createIsolatedGateway(options: { wechat: Gateway; alipay: Gateway; wechatCallback: Hono; alipayCallback: Hono; checkoutStatus?: Hono; apiQuery?: Hono }) {
  const app = new Hono();
  app.on(["GET", "POST"], ["/mapi.php", "/submit.php"], async (context) => {
    context.header("Cache-Control", "no-store");
    const request = context.req.raw;
    let params: Record<string, string>;
    try {
      params = await readEPayParams(request);
    } catch {
      return context.json({ code: -1, msg: "invalid or unavailable order", isolated: true }, 400);
    }
    const target = params.type === "wxpay" ? options.wechat : params.type === "alipay" ? options.alipay : null;
    if (!target) return context.json({ code: -1, msg: "invalid or unavailable order", isolated: true }, 400);
    let forwarded = request;
    if (request.method === "POST") {
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      headers.set("content-type", "application/x-www-form-urlencoded");
      forwarded = new Request(request.url, { method: "POST", headers, body: new URLSearchParams(params), signal: request.signal });
    }
    const response = await target.fetch(forwarded);
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  });
  app.route("/wechat", options.wechatCallback);
  app.route("/alipay", options.alipayCallback);
  if (options.checkoutStatus) app.route("/", options.checkoutStatus);
  if (options.apiQuery) app.route("/", options.apiQuery);
  return app;
}
