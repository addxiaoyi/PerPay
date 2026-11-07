import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { AppDatabase } from "../database/database.ts";
import { parseStrictJson } from "../http/strict-json.ts";
import { authorizeMerchant, MerchantAccessError } from "./merchant-access.ts";
import { readBoundedBody } from "./main-order-auth.ts";
import { approveRefund, rejectRefund, requestRefund } from "./refund-workflow.ts";
import { publicRefund, refundRow, requireRefundAccess, RefundConflict, RefundPermission } from "./refund-store.ts";
import { InsufficientBalance } from "./live-balance.ts";

type Options = {
  database: Pick<AppDatabase, "read" | "write" | "instanceId">; masterKey: Uint8Array;
  identityOrigin: string; publicOrigin: string; enabled: boolean; identityFetch?: typeof fetch | undefined; clock?: (() => number) | undefined;
};
const TTL_MS = 10 * 60 * 1000;
export function createRefundRoutes(options: Options) {
  const app = new Hono(), clock = options.clock ?? Date.now;
  const tokenKey = Buffer.from(hkdfSync("sha256", options.masterKey, options.database.instanceId(), "perpay:refund-csrf:v1", 32));
  const signature = (cookie: string, merchantId: string, userId: string, expiresAt: number) => createHmac("sha256", tokenKey).update(JSON.stringify([cookie, merchantId, userId, expiresAt])).digest("base64url");
  async function authorize(request: Request, write: boolean) {
    const url = new URL(request.url), ids = url.searchParams.getAll("merchantId");
    const allowed = write ? new Set(["merchantId"]) : new Set(["merchantId", "page"]);
    if (ids.length !== 1 || !ids[0] || ids[0].length > 128 || [...url.searchParams.keys()].some(key => !allowed.has(key))) throw new RefundPermission("invalid refund query");
    const cookie = request.headers.get("cookie") ?? "";
    const access = await authorizeMerchant({ database: options.database, origin: options.identityOrigin, cookie, merchantId: ids[0], ...(options.identityFetch ? { fetch: options.identityFetch } : {}) });
    if (!access.userId) throw new RefundPermission("refund actor is unavailable");
    if (write) {
      if (request.headers.get("origin") !== options.publicOrigin || request.headers.get("sec-fetch-site") === "cross-site") throw new RefundPermission("refund origin differs");
      const token = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(request.headers.get("x-csrf-token") ?? "");
      const expiry = Number(token?.[1]), now = clock();
      if (!token || !Number.isSafeInteger(now) || expiry <= now || expiry - now > TTL_MS || !timingSafeEqual(Buffer.from(token[2]!), Buffer.from(signature(cookie, access.merchantId, access.userId, expiry)))) throw new RefundPermission("refund CSRF token differs");
    }
    return { access, cookie };
  }
  app.use("*", async (context, next) => { context.header("Cache-Control", "no-store"); await next(); });
  app.onError((error, context) => {
    if (error instanceof MerchantAccessError) return context.json({ ok: false, error: error.code }, error.code === "unauthenticated" ? 401 : error.code === "unavailable" ? 503 : 403);
    if (error instanceof RefundPermission) return context.json({ ok: false, error: "没有权限处理该退款，请刷新登录状态后重试。", code: "refund_forbidden" }, 403);
    if (error instanceof z.ZodError) return context.json({ ok: false, error: "请检查订单号、退款金额和原因。", code: "refund_invalid" }, 400);
    if (error instanceof InsufficientBalance) return context.json({ ok: false, error: "商户可用余额不足，退款申请仍保留待处理。", code: "refund_insufficient_balance" }, 409);
    if (error instanceof RefundConflict) return context.json({ ok: false, error: "订单不支持本次退款或申请已处理，请刷新记录核对。", code: "refund_conflict" }, 409);
    return context.json({ ok: false, error: "退款服务暂时不可用，请稍后查看原申请。", code: "refund_unavailable" }, 503);
  });
  app.get("/session", async context => {
    const { access, cookie } = await authorize(context.req.raw, false), expiresAt = clock() + TTL_MS;
    return context.json({ ok: true, data: { enabled: options.enabled, canApprove: options.enabled && access.role === "admin",
      csrfToken: `${expiresAt}.${signature(cookie, access.merchantId, access.userId!, expiresAt)}` } });
  });
  app.get("/", async context => {
    const { access } = await authorize(context.req.raw, false);
    const page = context.req.query("page") ?? "1";
    if (!/^[1-9]\d{0,4}$/.test(page) || new URL(context.req.url).searchParams.getAll("page").length > 1) return context.json({ ok: false, error: "分页参数无效。" }, 400);
    const rows = options.database.read(sql => {
      requireRefundAccess(sql, access);
      return sql.prepare("SELECT refund_no FROM epay_native_refunds WHERE merchant_id=? ORDER BY created_at DESC,refund_no DESC LIMIT 21 OFFSET ?")
        .all(access.epayMerchantId, (Number(page) - 1) * 20).map(row => publicRefund(refundRow(sql, String(row.refund_no))));
    });
    return context.json({ ok: true, data: { refunds: rows.slice(0, 20), hasNext: rows.length > 20 } });
  });
  app.post("*", async context => {
    if (!options.enabled) return context.json({ ok: false, error: "支付服务升级中，暂不处理新的退款。", code: "refund_maintenance" }, 503);
    const { access } = await authorize(context.req.raw, true);
    if (!/^application\/json(?:;|$)/i.test(context.req.header("content-type") ?? "")) return context.json({ ok: false, error: "请求格式应为 JSON。" }, 415);
    let body: unknown;
    try { body = parseStrictJson(await readBoundedBody(context.req.raw.body, 4096)); }
    catch { return context.json({ ok: false, error: "退款资料格式无效。" }, 400); }
    if (context.req.path.endsWith("/refunds") || context.req.path.endsWith("/refunds/")) return context.json({ ok: true, data: requestRefund(options.database, access, body, clock()) }, 201);
    const operation = /\/([A-Za-z0-9_-]{16,64})\/(approve|reject)$/.exec(context.req.path);
    if (!operation) return context.json({ ok: false, error: "退款操作不存在。" }, 404);
    z.object({}).strict().parse(body);
    const changed = operation[2] === "approve" ? approveRefund(options.database, access, operation[1]!, clock()) : rejectRefund(options.database, access, operation[1]!, clock());
    return context.json({ ok: true, data: changed });
  });
  return app;
}
