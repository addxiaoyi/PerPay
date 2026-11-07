import { Hono } from "hono";
import { z } from "zod";
import type { AppDatabase } from "../database/database.ts";
import { merchantMutationAuth, type MerchantMutationOptions } from "./merchant-mutation-auth.ts";
import { authorizeMerchant, MerchantAccessError } from "./merchant-access.ts";
import { readBoundedBody } from "./main-order-auth.ts";
import { parseStrictJson } from "../http/strict-json.ts";
import { NodeWebhookTransport } from "../notifications/transport.ts";

type Options = MerchantMutationOptions & { database: Pick<AppDatabase, "read" | "write" | "instanceId">; enabled: boolean };
const profileInput = z.object({ displayName: z.string().trim().min(1).max(80).regex(/^[^\x00-\x1f\x7f]+$/), callbackUrl: z.string().max(2048).url() }).strict();
export function createMerchantProfileRoutes(options: Options) {
  const app = new Hono(), auth = merchantMutationAuth(options, "merchant-profile");
  const origin = new URL(options.identityOrigin);
  if (origin.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(origin.hostname) || origin.pathname !== "/" || origin.username || origin.password || origin.search || origin.hash) throw new Error("invalid main identity origin");
  async function request(path: string, cookie: string, body?: z.infer<typeof profileInput>) {
    const response = await (options.identityFetch ?? fetch)(new URL(path, origin), { method: body ? "PATCH" : "GET",
      headers: { cookie, accept: "application/json", ...(body ? { "content-type": "application/json", origin: options.publicOrigin, host: new URL(options.publicOrigin).host } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (response.status === 401) throw new MerchantAccessError("unauthenticated");
    if ([403, 404].includes(response.status)) throw new MerchantAccessError("forbidden");
    if (!response.ok) throw new MerchantAccessError("unavailable");
    const value = parseStrictJson(await readBoundedBody(response.body, 65536)) as Record<string, unknown>;
    if (!value || value.ok !== true) throw new MerchantAccessError("unavailable");
    return value;
  }
  const recheck = (cookie: string, merchantId: string) => authorizeMerchant({ database: options.database, origin: options.identityOrigin, cookie, merchantId, ...(options.identityFetch ? { fetch: options.identityFetch } : {}) });
  app.use("*", async (context, next) => { context.header("Cache-Control", "no-store"); await next(); });
  app.onError((error, context) => {
    if (error instanceof MerchantAccessError) return context.json({ ok: false, error: error.code }, error.code === "unauthenticated" ? 401 : error.code === "unavailable" ? 503 : 403);
    return context.json({ ok: false, code: "merchant_profile_invalid", error: "资料无效或暂未保存，请核对商户名称和 HTTPS 回调地址。" }, 400);
  });
  app.get("/", async context => {
    const { access, cookie } = await auth.authenticate(context.req.raw, false);
    const reply = await request(`/api/merchant/profile?merchantId=${encodeURIComponent(access.merchantId)}`, cookie);
    const merchant = reply.merchant as Record<string, unknown> | undefined;
    if (!merchant || merchant.id !== access.merchantId || merchant.apiId !== access.mainApiId || typeof merchant.displayName !== "string" || typeof merchant.callbackUrl !== "string") throw new MerchantAccessError("invalid_binding");
    const current = await recheck(cookie, access.merchantId);
    if (current.mainApiId !== access.mainApiId || current.userId !== access.userId) throw new MerchantAccessError("forbidden");
    const canEdit = options.enabled && ["admin", "owner"].includes(current.role);
    return context.json({ ok: true, data: { merchantId: access.merchantId, displayName: merchant.displayName, callbackUrl: merchant.callbackUrl,
      apiId: access.mainApiId, canEdit, csrfToken: canEdit ? auth.issue(cookie, current) : null } });
  });
  app.get("/main-key", async context => {
    const { access, cookie } = await auth.authenticate(context.req.raw, false);
    if (context.req.header("sec-fetch-site") === "cross-site" || (context.req.header("origin") && context.req.header("origin") !== options.publicOrigin)) throw new MerchantAccessError("forbidden");
    const keys = await request(`/api/merchant/keys?merchantId=${encodeURIComponent(access.merchantId)}`, cookie);
    const current = await recheck(cookie, access.merchantId);
    if (keys.apiId !== current.mainApiId || current.userId !== access.userId || typeof keys.apiSecret !== "string" || !keys.apiSecret || keys.apiSecret.length > 4096) throw new MerchantAccessError("forbidden");
    return context.json({ ok: true, data: { merchantId: access.merchantId, apiId: current.mainApiId, apiSecret: keys.apiSecret } });
  });
  app.post("/", async context => {
    if (!options.enabled) return context.json({ ok: false, error: "maintenance_read_only" }, 503);
    const { access, cookie } = await auth.authenticate(context.req.raw, true);
    if (!["owner", "admin"].includes(access.role)) throw new MerchantAccessError("forbidden");
    if (!/^application\/json(?:;|$)/i.test(context.req.header("content-type") ?? "")) return context.json({ ok: false, error: "invalid_content_type" }, 415);
    const body = profileInput.parse(parseStrictJson(await readBoundedBody(context.req.raw.body, 4096)));
    new NodeWebhookTransport(new URL(body.callbackUrl).origin).validateTarget(body.callbackUrl);
    await request(`/api/merchant/profile?merchantId=${encodeURIComponent(access.merchantId)}`, cookie, body);
    const confirmed = await request(`/api/merchant/profile?merchantId=${encodeURIComponent(access.merchantId)}`, cookie);
    const merchant = confirmed.merchant as Record<string, unknown> | undefined;
    const current = await recheck(cookie, access.merchantId);
    if (!merchant || merchant.id !== access.merchantId || merchant.apiId !== access.mainApiId || merchant.displayName !== body.displayName || merchant.callbackUrl !== body.callbackUrl || current.userId !== access.userId) throw new MerchantAccessError("unavailable");
    options.database.write(sql => {
      const saved = sql.prepare(`UPDATE epay_merchant_accounts SET name=? WHERE merchant_id=? AND enabled=1 AND EXISTS(
        SELECT 1 FROM epay_merchant_bindings b WHERE b.epay_merchant_id=epay_merchant_accounts.merchant_id AND b.main_merchant_id=? AND b.main_api_id=?)`)
        .run(body.displayName, access.epayMerchantId, access.merchantId, access.mainApiId);
      if (Number(saved.changes) !== 1) throw new MerchantAccessError("invalid_binding");
    });
    return context.json({ ok: true, data: { merchantId: access.merchantId, ...body } });
  });
  return app;
}
