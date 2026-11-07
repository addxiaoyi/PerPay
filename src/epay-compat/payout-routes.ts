import { Hono } from "hono";
import { z } from "zod";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { parseStrictJson } from "../http/strict-json.ts";
import { readBoundedBody } from "./main-order-auth.ts";
import { merchantMutationAuth, type MerchantMutationOptions } from "./merchant-mutation-auth.ts";
import { MerchantAccessError } from "./merchant-access.ts";
import { InsufficientBalance } from "./live-balance.ts";
import { addPayoutAccount, listPayoutAccounts, revealPayoutAccount, reviewPayoutAccount } from "./payout-accounts.ts";
import { listPayouts, requestPayout, reviewPayout } from "./payout-workflow.ts";
import { disabledPayoutPolicy, PayoutConflict, PayoutUnavailable, type PayoutDatabase, type PayoutPolicy } from "./payout-model.ts";
import type { WechatPayoutService } from "./payout-wechat.ts";
import { payoutAccess } from "./payout-model.ts";
import { listPayoutReconciliations } from "./payout-reconciliation.ts";
import { reconcilePayoutStatement } from "./payout-statement.ts";

export type PayoutServices = { policy?: PayoutPolicy; wechat?: WechatPayoutService; reconcile?: (day: string) => Promise<unknown> };
type Options = MerchantMutationOptions & PayoutServices & { database: PayoutDatabase & Pick<MerchantMutationOptions["database"], "instanceId">; enabled: boolean };

export function createPayoutRoutes(options: Options) {
  const app = new Hono(), auth = merchantMutationAuth(options, "payout"), clock = options.clock ?? Date.now;
  const cipher = new RuntimeSecretCipher(options.masterKey, options.database.instanceId());
  const policy = options.policy ?? disabledPayoutPolicy;
  app.use("*", async (context, next) => { context.header("Cache-Control", "no-store"); await next(); });
  app.onError((error, context) => {
    if (error instanceof MerchantAccessError) return context.json({ ok: false, error: error.code }, error.code === "unauthenticated" ? 401 : error.code === "unavailable" ? 503 : 403);
    if (error instanceof z.ZodError) return context.json({ ok: false, error: "请核对收款资料、金额和审核说明。", code: "payout_invalid" }, 400);
    if (error instanceof PayoutUnavailable) return context.json({ ok: false, error: "自动打款通道尚未验收开放，请使用现有线下结算流程。", code: "payout_unavailable" }, 503);
    if (error instanceof InsufficientBalance) return context.json({ ok: false, error: "可用余额不足，请刷新后核对。", code: "payout_insufficient" }, 409);
    if (error instanceof PayoutConflict) return context.json({ ok: false, error: "账户或提现状态已变化，或金额超过限额，请刷新后核对。", code: "payout_conflict" }, 409);
    return context.json({ ok: false, error: "结果暂未确认，请查询原记录后重试。", code: "payout_unavailable" }, 503);
  });
  app.get("/session", async context => {
    const { access, cookie } = await auth.authenticate(context.req.raw, false);
    return context.json({ ok: true, data: { canBind: options.enabled && access.role !== "member", canReview: options.enabled && access.role === "admin",
      canRequest: options.enabled && policy.enabled && access.role !== "member", csrfToken: auth.issue(cookie, access),
      wechatAuthorization: options.enabled && options.wechat?.enabled === true && access.role !== "member", canReconcile: options.enabled && Boolean(options.reconcile) && access.role === "admin",
      channels: (["bank", "alipay", "wechat"] as const).map(kind => ({ kind, enabled: options.enabled && policy.enabled && Boolean(policy.channels[kind]),
        maxSingleCents: policy.channels[kind]?.maxSingleCents ?? null, reason: policy.channels[kind] ? policy.enabled ? null : "平台暂未开启自动打款" : kind === "bank" ? "中国银行银企直联出款权限待核实" : "商家转账权限与接口待验收" })) } });
  });
  app.get("/accounts", async context => {
    const { access } = await auth.authenticate(context.req.raw, false);
    return context.json({ ok: true, data: listPayoutAccounts(options.database, access, Number(context.req.query("page") ?? 1)) });
  });
  app.get("/requests", async context => {
    const { access } = await auth.authenticate(context.req.raw, false);
    return context.json({ ok: true, data: listPayouts(options.database, access, Number(context.req.query("page") ?? 1)) });
  });
  app.get("/accounts/:id/wechat", async context => {
    const { access } = await auth.authenticate(context.req.raw, false);
    if (!options.wechat) throw new PayoutUnavailable("WeChat authorization unavailable");
    return context.json({ ok: true, data: options.wechat.status(access, z.uuid().parse(context.req.param("id"))) });
  });
  app.get("/reconciliations", async context => {
    const { access } = await auth.authenticate(context.req.raw, false);
    return context.json({ ok: true, data: listPayoutReconciliations(options.database, access) });
  });
  app.post("/*", async context => {
    if (!options.enabled) return context.json({ ok: false, error: "维护期间暂不受理出款设置或提现操作。" }, 503);
    const preliminary = await auth.authenticate(context.req.raw, true);
    const statement = context.req.path.endsWith("/statements");
    if (statement) options.database.read(sql => payoutAccess(sql, preliminary.access, "admin"));
    if (!/^application\/json(?:;|$)/i.test(context.req.header("content-type") ?? "")) return context.json({ ok: false, error: "请求格式应为 JSON。" }, 415);
    let body: unknown;
    try { body = parseStrictJson(await readBoundedBody(context.req.raw.body, statement ? 524288 : 8192)); }
    catch { return context.json({ ok: false, error: "收款资料格式无效。" }, 400); }
    const { access, cookie } = await auth.authenticate(context.req.raw, true);
    if (statement) return context.json({ ok: true, data: reconcilePayoutStatement(options.database, access, body, clock()) });
    if (context.req.path.endsWith("/reconciliations")) {
      options.database.read(sql => payoutAccess(sql, access, "admin"));
      const command = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict().parse(body);
      if (!options.reconcile) throw new PayoutUnavailable("payout reconciliation unavailable");
      return context.json({ ok: true, data: await options.reconcile(command.day) });
    }
    if (context.req.path.includes("/wechat/")) {
      if (!options.wechat) throw new PayoutUnavailable("WeChat authorization unavailable");
      if (context.req.path.endsWith("/wechat/binding/begin")) {
        const command = z.object({ holderName: z.string() }).strict().parse(body);
        return context.json({ ok: true, data: options.wechat.beginBinding(access, cookie, command.holderName) });
      }
      if (context.req.path.endsWith("/wechat/binding/complete")) {
        const command = z.object({ state: z.string(), code: z.string() }).strict().parse(body);
        return context.json({ ok: true, data: await options.wechat.completeBinding(access, cookie, command.state, command.code, async () => (await auth.authenticate(context.req.raw, true)).access) });
      }
      const grant = /\/accounts\/([a-f0-9-]{36})\/wechat\/authorize$/.exec(context.req.path);
      if (grant) { z.object({}).strict().parse(body); return context.json({ ok: true, data: await options.wechat.authorize(access, grant[1]!) }); }
    }
    const path = context.req.path, match = /\/accounts\/([a-f0-9-]{36})\/(review|reveal)$/.exec(path);
    if (match) {
      if (match[2] === "reveal") { z.object({}).strict().parse(body); return context.json({ ok: true, data: revealPayoutAccount(options.database, cipher, access, match[1]!, clock()) }); }
      return context.json({ ok: true, data: reviewPayoutAccount(options.database, access, match[1]!, body, clock()) });
    }
    const decision = /\/requests\/([a-f0-9-]{36})\/review$/.exec(path);
    if (decision) return context.json({ ok: true, data: reviewPayout(options.database, access, decision[1]!, body, policy, clock()) });
    if (/\/accounts$/.test(path)) return context.json({ ok: true, data: addPayoutAccount(options.database, cipher, access, body, clock()) }, 201);
    if (/\/requests$/.test(path)) return context.json({ ok: true, data: requestPayout(options.database, access, body, policy, clock()) }, 201);
    return context.json({ ok: false, error: "出款操作不存在。" }, 404);
  });
  return app;
}
