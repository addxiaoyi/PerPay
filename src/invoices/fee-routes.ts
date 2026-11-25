import { Hono } from "hono";
import { z, ZodError } from "zod";
import { merchantMutationAuth } from "../epay-compat/merchant-mutation-auth.ts";
import { MerchantAccessError } from "../epay-compat/merchant-access.ts";
import { readBoundedBody } from "../epay-compat/main-order-auth.ts";
import { parseStrictJson } from "../http/strict-json.ts";
import { InvoiceError } from "./model.ts";
import { createFeeInvoiceService } from "./fee-service.ts";
import type { InvoiceRouteOptions } from "./routes.ts";
import { createInvoiceSubscriptionRoutes } from "./subscription-routes.ts";
import { readInvoiceSubscription } from "./subscription.ts";

export function createFeeInvoiceRoutes(options: InvoiceRouteOptions) {
  const app = new Hono(), auth = merchantMutationAuth(options, "invoice");
  app.route('/subscription',createInvoiceSubscriptionRoutes(options));
  const provider = options.provider;
  const service = provider ? createFeeInvoiceService({ ...options, provider, canIssue: () => options.enabled }) : null;
  app.use("*", async (context, next) => { context.header("Cache-Control", "no-store"); context.header("Referrer-Policy", "no-referrer"); await next(); });
  app.onError((error, context) => {
    if (error instanceof MerchantAccessError) return context.json({ ok: false, code: error.code, error: "请检查当前商户权限和登录状态。" }, error.code === "unauthenticated" ? 401 : error.code === "unavailable" ? 503 : 403);
    if (error instanceof ZodError) return context.json({ ok: false, code: "invoice_invalid", error: "请核对商户的发票抬头、税号和接收邮箱。" }, 400);
    if (error instanceof InvoiceError) return context.json({ ok: false, code: error.code, error: "服务费开票未完成，请核对资料、实际扣费和开票状态。" }, error.status);
    console.error("fee invoice route failed", { path: context.req.path, errorType: error.name });
    return context.json({ ok: false, code: "invoice_unavailable", error: "服务费开票暂不可用，请查询原申请。" }, 503);
  });
  app.get("/session", async context => {
    const { access, cookie } = await auth.authenticate(context.req.raw, false);
    const canConfigure = options.enabled && access.role !== "member";
    return context.json({ ok: true, data: { merchantId: access.merchantId, configured: Boolean(provider?.platformFees),
      enabled: service?.enabled() ?? false, canConfigure, canRequest: canConfigure && Boolean(service?.enabled()) && options.database.read(sql=>readInvoiceSubscription(sql,access.epayMerchantId,(options.clock??Date.now)()).active),
      buyer: service?.readBuyer(access) ?? null, seller: provider?.platformFees ? {
        sellerName: provider.platformFees.profile.sellerName, sellerTaxId: provider.platformFees.profile.sellerTaxId,
        itemName: provider.platformFees.profile.itemName, taxCode: provider.platformFees.profile.taxCode, taxRateBps: provider.platformFees.profile.taxRateBps,
      } : null,
      csrfToken: canConfigure ? auth.issue(cookie, access) : null } });
  });
  app.get("/", async context => {
    const { access } = await auth.authenticate(context.req.raw, false);
    return context.json({ ok: true, data: { merchantId: access.merchantId, invoices: service?.list(access) ?? [] } });
  });
  app.get("/readiness", async context => {
    const { access } = await auth.authenticate(context.req.raw, false);
    if (!service) throw new InvoiceError("invoice_unconfigured", 503, "invoice provider is unconfigured");
    return context.json({ ok: true, data: { merchantId: access.merchantId, automaticEnabled: options.autoSyncEnabled === true, ...service.readiness(access) } });
  });
  const body = async (request: Request) => {
    if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? "")) throw new InvoiceError("invoice_invalid", 400, "expected JSON");
    try { return parseStrictJson(await readBoundedBody(request.body, 8192)); }
    catch { throw new InvoiceError("invoice_invalid", 400, "invalid fee invoice JSON"); }
  };
  app.post("/buyer", async context => {
    const { access } = await auth.authenticate(context.req.raw, true);
    if (!options.enabled || access.role === "member") throw new MerchantAccessError("forbidden");
    if (!service) throw new InvoiceError("invoice_unconfigured", 503, "invoice provider is unconfigured");
    return context.json({ ok: true, data: { merchantId: access.merchantId, buyer: service.saveBuyer(access, await body(context.req.raw)) } });
  });
  app.post("/provider-status", async context => {
    const { access } = await auth.authenticate(context.req.raw, true);
    if (!options.enabled || access.role !== "admin") throw new MerchantAccessError("forbidden");
    z.object({}).strict().parse(await body(context.req.raw));
    if (!service) throw new InvoiceError("invoice_unconfigured", 503, "invoice provider is unconfigured");
    return context.json({ ok: true, data: { merchantId: access.merchantId, provider: await service.checkProvider(access) } });
  });
  app.post("/applications", async context => {
    const { access } = await auth.authenticate(context.req.raw, true);
    if (access.role === "member") throw new MerchantAccessError("forbidden");
    if (!service?.enabled()) throw new InvoiceError("invoice_disabled", 503, "fee invoicing is disabled");
    const command = z.object({ tradeNo: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) }).strict().parse(await body(context.req.raw));
    return context.json({ ok: true, data: { merchantId: access.merchantId, invoice: await service.create(access, command.tradeNo) } });
  });
  return app;
}
