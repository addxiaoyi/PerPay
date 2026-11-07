import { Hono } from "hono";
import { z } from "zod";
import type { AppDatabase } from "../database/database.ts";
import { merchantMutationAuth, type MerchantMutationOptions } from "./merchant-mutation-auth.ts";
import { readBoundedBody } from "./main-order-auth.ts";
import { parseStrictJson } from "../http/strict-json.ts";
import { MerchantAccessError } from "./merchant-access.ts";
import { retryMerchantCallback, CallbackRetryConflict } from "./callback-retry.ts";

type Options = MerchantMutationOptions & { database: Pick<AppDatabase, "read" | "write" | "instanceId">; enabled: boolean };
const retryCommand = z.object({ tradeNo: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), requestId: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/) }).strict();
export function createCallbackRetryRoutes(options: Options) {
  const app = new Hono(), auth = merchantMutationAuth(options, "callback-retry"), clock = options.clock ?? Date.now;
  app.use("*", async (context, next) => { context.header("Cache-Control", "no-store"); await next(); });
  app.onError((error, context) => {
    if (error instanceof MerchantAccessError) return context.json({ ok: false, error: error.code }, error.code === "unauthenticated" ? 401 : error.code === "unavailable" ? 503 : 403);
    if (error instanceof CallbackRetryConflict || error instanceof z.ZodError) return context.json({ ok: false, code: "callback_retry_conflict", error: "通知正在投递、刚刚重试或不属于当前商户，请刷新记录。" }, 409);
    return context.json({ ok: false, code: "callback_retry_unavailable", error: "重试结果尚未确认，请查看原订单记录。" }, 503);
  });
  app.get("/session", async context => {
    const { access, cookie } = await auth.authenticate(context.req.raw, false);
    return context.json({ ok: true, data: { enabled: options.enabled, csrfToken: auth.issue(cookie, access) } });
  });
  app.post("/retry", async context => {
    if (!options.enabled) return context.json({ ok: false, error: "maintenance_read_only" }, 503);
    const { access } = await auth.authenticate(context.req.raw, true);
    if (!/^application\/json(?:;|$)/i.test(context.req.header("content-type") ?? "")) return context.json({ ok: false, error: "invalid_content_type" }, 415);
    const input = retryCommand.parse(parseStrictJson(await readBoundedBody(context.req.raw.body, 4096)));
    const queued = options.database.write(sql => {
      if (!sql.prepare(`SELECT 1 FROM epay_merchant_bindings b JOIN epay_merchant_accounts m ON m.merchant_id=b.epay_merchant_id
        WHERE b.main_merchant_id=? AND b.main_api_id=? AND b.epay_merchant_id=? AND m.enabled=1`).get(access.merchantId, access.mainApiId, access.epayMerchantId)) throw new MerchantAccessError("invalid_binding");
      return retryMerchantCallback(sql, { ...input, merchantId: access.epayMerchantId, actor: access.userId! }, clock());
    });
    return context.json({ ok: true, data: queued });
  });
  return app;
}
