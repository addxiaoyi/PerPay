import { Hono } from "hono";
import { z } from "zod";
import type { AppDatabase } from "../database/database.ts";
import { merchantMutationAuth, type MerchantMutationOptions } from "./merchant-mutation-auth.ts";
import { MerchantAccessError } from "./merchant-access.ts";
import { readBoundedBody } from "./main-order-auth.ts";
import { parseStrictJson } from "../http/strict-json.ts";
import { rotateMerchantKey, MerchantKeyConflict } from "./merchant-key-rotation.ts";

type Options = MerchantMutationOptions & { database: Pick<AppDatabase, "read" | "write" | "instanceId">; enabled: boolean };
export function createMerchantKeyRoutes(options: Options) {
  const app = new Hono(), auth = merchantMutationAuth(options, "merchant-key"), clock = options.clock ?? Date.now;
  app.use("*", async (context, next) => { context.header("Cache-Control", "no-store"); await next(); });
  app.onError((error, context) => {
    if (error instanceof MerchantAccessError) return context.json({ ok: false, error: error.code }, error.code === "unauthenticated" ? 401 : error.code === "unavailable" ? 503 : 403);
    if (error instanceof MerchantKeyConflict) return context.json({ ok: false, code: "merchant_key_conflict", error: "密钥版本已变化，请重新读取后操作。" }, 409);
    if (error instanceof z.ZodError) return context.json({ ok: false, code: "merchant_key_invalid", error: "换钥请求无效，请刷新后重试。" }, 400);
    return context.json({ ok: false, code: "merchant_key_unavailable", error: "换钥结果暂未确认，请使用原请求重试。" }, 503);
  });
  app.get("/rotation-session", async context => {
    const { access, cookie } = await auth.authenticate(context.req.raw, false);
    const version = options.database.read(sql => Number(sql.prepare(`SELECT s.secret_version FROM epay_merchant_secrets s
      JOIN epay_merchant_bindings b ON b.epay_merchant_id=s.merchant_id JOIN epay_merchant_accounts m ON m.merchant_id=s.merchant_id
      WHERE b.main_merchant_id=? AND b.main_api_id=? AND m.merchant_id=? AND m.enabled=1`).get(access.merchantId, access.mainApiId, access.epayMerchantId)?.secret_version));
    if (!Number.isSafeInteger(version) || version < 1) throw new MerchantAccessError("unavailable");
    const canRotate = options.enabled && ["admin", "owner"].includes(access.role);
    return context.json({ ok: true, data: { canRotate, version, csrfToken: canRotate ? auth.issue(cookie, access) : null } });
  });
  app.post("/rotate", async context => {
    if (!options.enabled) return context.json({ ok: false, error: "maintenance_read_only" }, 503);
    const { access } = await auth.authenticate(context.req.raw, true);
    if (!["owner", "admin"].includes(access.role)) throw new MerchantAccessError("forbidden");
    if (!/^application\/json(?:;|$)/i.test(context.req.header("content-type") ?? "")) return context.json({ ok: false, error: "请求格式应为 JSON。" }, 415);
    let body: unknown;
    try { body = parseStrictJson(await readBoundedBody(context.req.raw.body, 4096)); }
    catch { return context.json({ ok: false, error: "换钥资料格式无效。" }, 400); }
    return context.json({ ok: true, data: rotateMerchantKey(options.database, options.masterKey, access, body, clock()) });
  });
  return app;
}
