import { Hono } from "hono";
import { z } from "zod";
import type { AppDatabase } from "../database/database.ts";
import { parseStrictJson } from "../http/strict-json.ts";
import { merchantMutationAuth, type MerchantMutationOptions } from "./merchant-mutation-auth.ts";
import { MerchantAccessError } from "./merchant-access.ts";
import { readBoundedBody } from "./main-order-auth.ts";
import { InsufficientBalance } from "./live-balance.ts";
import { requestSettlement, decideSettlement, listSettlements, SettlementConflict } from "./settlement-workflow.ts";

type Options = MerchantMutationOptions & { database: Pick<AppDatabase, "read" | "write" | "instanceId">; enabled: boolean };
export function createSettlementRoutes(options: Options) {
  const app = new Hono(), auth = merchantMutationAuth(options, "settlement"), clock = options.clock ?? Date.now;
  app.use("*", async (context, next) => { context.header("Cache-Control", "no-store"); await next(); });
  app.onError((error, context) => {
    if (error instanceof MerchantAccessError) return context.json({ ok: false, error: error.code }, error.code === "unauthenticated" ? 401 : error.code === "unavailable" ? 503 : 403);
    if (error instanceof z.ZodError) return context.json({ ok: false, code: "settlement_invalid", error: "请填写有效的结算金额、备注和打款凭证。" }, 400);
    if (error instanceof InsufficientBalance) return context.json({ ok: false, code: "settlement_insufficient_balance", error: "可用余额不足，请刷新后核对。" }, 409);
    if (error instanceof SettlementConflict) return context.json({ ok: false, code: "settlement_conflict", error: "结算申请已处理或请求与原申请不一致。" }, 409);
    return context.json({ ok: false, code: "settlement_unavailable", error: "结算结果暂未确认，请查看原申请后重试。" }, 503);
  });
  app.get("/session", async context => {
    const { access, cookie } = await auth.authenticate(context.req.raw, false);
    return context.json({ ok: true, data: { enabled: options.enabled, canReview: options.enabled && access.role === "admin", csrfToken: auth.issue(cookie, access) } });
  });
  app.get("/", async context => {
    const { access } = await auth.authenticate(context.req.raw, false), page = context.req.query("page") ?? "1";
    if (!/^[1-9]\d{0,4}$/.test(page)) return context.json({ ok: false, error: "分页参数无效。" }, 400);
    return context.json({ ok: true, data: listSettlements(options.database, access, Number(page)) });
  });
  app.post("*", async context => {
    if (!options.enabled) return context.json({ ok: false, code: "settlement_maintenance", error: "暂不受理新的结算操作。" }, 503);
    const { access } = await auth.authenticate(context.req.raw, true);
    const decision = /\/([a-f0-9-]{36})\/decision$/.exec(context.req.path);
    if (decision && access.role !== "admin") throw new MerchantAccessError("forbidden");
    if (!/^application\/json(?:;|$)/i.test(context.req.header("content-type") ?? "")) return context.json({ ok: false, error: "请求格式应为 JSON。" }, 415);
    let body: unknown;
    try { body = parseStrictJson(await readBoundedBody(context.req.raw.body, 4096)); }
    catch { return context.json({ ok: false, code: "settlement_invalid", error: "结算资料格式无效。" }, 400); }
    if (decision) return context.json({ ok: true, data: decideSettlement(options.database, access, decision[1]!, body, clock()) });
    if (!/\/settlements\/?$/.test(context.req.path)) return context.json({ ok: false, error: "结算操作不存在。" }, 404);
    return context.json({ ok: true, data: requestSettlement(options.database, access, body, clock()) }, 201);
  });
  return app;
}
