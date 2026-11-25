import { Hono } from "hono";
import { ZodError } from "zod";
import type { AppDatabase } from "../database/database.ts";
import { MerchantAccessError } from "../epay-compat/merchant-access.ts";
import { merchantMutationAuth, type MerchantMutationOptions } from "../epay-compat/merchant-mutation-auth.ts";
import { readBoundedBody } from "../epay-compat/main-order-auth.ts";
import { parseStrictJson } from "../http/strict-json.ts";
import { InvoiceError, type InvoiceProvider } from "./model.ts";
import { createInvoiceService } from "./service.ts";
import { createInvoiceReconciliation } from "./reconciliation.ts";

export type InvoiceRouteOptions = MerchantMutationOptions & {
  database: Pick<AppDatabase, "read" | "write" | "instanceId">;
  enabled: boolean;
  autoSyncEnabled?: boolean;
  provider?: InvoiceProvider | undefined;
};

const messages: Record<string, string> = {
  invoice_reconcile_conflict: "核对已过期、申请状态已变化或发票号已被使用，请重新预览。",
  invoice_reconcile_unverified: "无法核实原发票，请检查发票号、销购双方、金额、税目和税率；没有保存回填。",
  invoice_reconcile_unavailable: "当前开票平台不支持原发票核对。",
  invoice_unconfigured: "平台尚未配置电子发票服务商。",
  invoice_provider_mismatch: "开票主体配置与当前服务商不一致，请联系管理员核对。",
  invoice_disabled: "该商户尚未启用开票，请先完成税务授权和开票配置。",
  invoice_not_authorized: "商户未完成数电开票授权，或登记的开票人不可用。",
  invoice_provider_unavailable: "开票平台暂时无法确认结果，请查询原申请。",
  invoice_profile_conflict: "开票资料已变化，请刷新后重新保存。",
  invoice_request_conflict: "该订单已存在开票申请，请查询原申请。",
  invoice_buyer_conflict: "同一开票申请重试时不能修改购方类型、抬头、税号或邮箱，请恢复原资料。",
  invoice_order_unavailable: "订单尚未确认支付、正在退款或不属于当前商户。",
  invoice_payment_unsupported: "当前接口仅支持微信支付订单，支付宝订单需要另行接入开票服务。",
  invoice_not_found: "未找到当前商户的开票记录。",
  invoice_not_issued: "发票尚未开具完成，暂时无法下载。",
  invoice_payment_merchant_mismatch: "原订单的微信收款商户与开票主体不一致，不能以当前商户开具。",
  invoice_seller_conflict: "该微信商户号已绑定其他 StarPAY 商户。",
  invoice_profile_unavailable: "请先配置商户开票资料并完成授权。",
  invoice_order_unconfirmed: "订单尚未确认支付成功，或不属于当前商户。",
  invoice_refund_conflict: "订单已退款或正在退款，不能提交开票。",
  invoice_legacy_conflict: "订单已有历史发票或申请，请核对原记录。",
  invoice_retry_limit: "该订单已达到五次申请上限，请核查原申请及失败原因。",
  invoice_retry_unconfirmed: "尚未确认上次开票失败，请先查询原申请，暂时不能补开。",
};

function unavailable(): never {
  throw new InvoiceError("invoice_unconfigured", 503, "invoice provider is not configured");
}
const unavailableProvider: InvoiceProvider = {
  authorize: async () => unavailable(), issue: async () => unavailable(), query: async () => unavailable(),
  download: async () => unavailable(), invite: async () => unavailable(),
};

export function createInvoiceRoutes(options: InvoiceRouteOptions) {
  const app = new Hono();
  const auth = merchantMutationAuth(options, "invoice");
  const service = createInvoiceService({ database: options.database, provider: options.provider ?? unavailableProvider,
    canIssue: () => options.enabled,
    ...(options.clock ? { clock: options.clock } : {}) });
  const providerConfigured = Boolean(options.provider);
  const reconciliation = options.provider ? createInvoiceReconciliation({ ...options, provider: options.provider }) : null;
  app.use("*", async (context, next) => {
    context.header("Cache-Control", "no-store");
    context.header("Referrer-Policy", "no-referrer");
    await next();
  });
  app.onError((error, context) => {
    if (error instanceof MerchantAccessError) return context.json({ ok: false, code: error.code, error: "请检查当前商户权限和登录状态。" },
      error.code === "unauthenticated" ? 401 : error.code === "unavailable" ? 503 : 403);
    if (error instanceof ZodError) return context.json({ ok: false, code: "invoice_invalid", error: "请核对开票资料、税号、税目和税率。" }, 400);
    if (error instanceof InvoiceError) return context.json({ ok: false, code: error.code, error: messages[error.code] ?? "开票操作未完成，请核对当前商户、订单和申请状态。" }, error.status);
    console.error("invoice route failed", { path: context.req.path, errorType: error.name });
    return context.json({ ok: false, code: "invoice_unavailable", error: "开票服务暂不可用，请查询原申请状态。" }, 503);
  });

  const canPrepare = options.provider?.kind === "fa-piao";
  const supportsReconcile = canPrepare && Boolean(options.provider?.reviewInvoice);
  const authenticateWrite = async (request: Request, requireProvider = true, preparing = false) => {
    const session = await auth.authenticate(request, true);
    if (!["admin", "owner"].includes(session.access.role)) throw new MerchantAccessError("forbidden");
    if (!options.enabled && !(preparing && canPrepare)) throw new InvoiceError("invoice_disabled", 503, "invoice changes are disabled");
    if (requireProvider && !providerConfigured) unavailable();
    return session;
  };
  const body = async (request: Request) => {
    if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? ""))
      throw new InvoiceError("invoice_invalid", 400, "expected JSON");
    try { return parseStrictJson(await readBoundedBody(request.body, 8192)); }
    catch { throw new InvoiceError("invoice_invalid", 400, "invalid invoice request body"); }
  };

  app.get("/session", async context => {
    const { access, cookie } = await auth.authenticate(context.req.raw, false);
    const profile = service.getProfile(access);
    const canWrite = options.enabled && ["owner", "admin"].includes(access.role);
    const canConfigure = (options.enabled || canPrepare) && access.role === "admin";
    const canReconcile = supportsReconcile && access.role === "admin";
    return context.json({ ok: true, data: { merchantId: access.merchantId, enabled: options.enabled, providerConfigured, providerKind: options.provider?.kind ?? "wechat", profile,
      platformFeesConfigured: Boolean(options.provider?.platformFees),
      canConfigure, canReconcile, canRequest: canWrite && providerConfigured && Boolean(profile?.enabled && profile.authorized),
      csrfToken: canWrite || canConfigure || canReconcile ? auth.issue(cookie, access) : null } });
  });
  app.get("/", async context => {
    const { access } = await auth.authenticate(context.req.raw, false);
    const page = context.req.query("page") ?? "1";
    if (!/^[1-9]\d{0,4}$/.test(page)) throw new InvoiceError("invoice_invalid_page", 400, "invalid invoice page");
    return context.json({ ok: true, data: { merchantId: access.merchantId, ...service.list(access, Number(page)) } });
  });
  app.post("/profile", async context => {
    const { access } = await authenticateWrite(context.req.raw, false, true);
    if (access.role !== "admin") throw new MerchantAccessError("forbidden");
    const input = await body(context.req.raw);
    if (!options.enabled && input && typeof input === "object" && "enabled" in input && input.enabled === true)
      throw new InvoiceError("invoice_disabled", 503, "invoice issuance is disabled");
    if (input && typeof input === "object" && "enabled" in input && input.enabled === true && !providerConfigured) unavailable();
    return context.json({ ok: true, data: { merchantId: access.merchantId, profile: await service.saveProfile(access, input) } });
  });
  app.post("/authorization", async context => {
    const { access } = await authenticateWrite(context.req.raw);
    return context.json({ ok: true, data: { merchantId: access.merchantId, ...await service.checkAuthorization(access) } });
  });
  app.post("/invite", async context => {
    const { access } = await authenticateWrite(context.req.raw);
    return context.json({ ok: true, data: { merchantId: access.merchantId, url: await service.invite(access) } });
  });
  app.post("/applications", async context => {
    const { access } = await authenticateWrite(context.req.raw);
    const invoice = await service.createAndIssue(access, await body(context.req.raw));
    return context.json({ ok: true, data: { merchantId: access.merchantId, invoice } });
  });
  app.post("/:id/refresh", async context => {
    const { access } = await authenticateWrite(context.req.raw);
    return context.json({ ok: true, data: { merchantId: access.merchantId, invoice: await service.refresh(access, context.req.param("id")) } });
  });
  const authenticateReconcile = async (request: Request) => {
    const { access } = await auth.authenticate(request, true);
    if (access.role !== "admin") throw new MerchantAccessError("forbidden");
    if (!supportsReconcile || !reconciliation) throw new InvoiceError("invoice_reconcile_unavailable", 503, "invoice reconciliation unavailable");
    return access;
  };
  app.post("/:id/reconcile/preview", async context => {
    const access = await authenticateReconcile(context.req.raw);
    const review = await reconciliation!.preview(access, context.req.param("id"), await body(context.req.raw));
    return context.json({ ok: true, data: { merchantId: access.merchantId, review } });
  });
  app.post("/:id/reconcile/confirm", async context => {
    const access = await authenticateReconcile(context.req.raw);
    const invoice = await reconciliation!.confirm(access, context.req.param("id"), await body(context.req.raw));
    return context.json({ ok: true, data: { merchantId: access.merchantId, invoice } });
  });
  app.post("/:id/files", async context => {
    const { access } = await authenticateWrite(context.req.raw);
    return context.json({ ok: true, data: { merchantId: access.merchantId, url: await service.download(access, context.req.param("id")) } });
  });
  return app;
}
