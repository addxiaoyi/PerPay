import { Hono } from "hono";
import { z } from "zod";
import type { AppDatabase } from "../database/database.ts";
import { merchantMutationAuth, type MerchantMutationOptions } from "./merchant-mutation-auth.ts";
import { authorizeMainAdmin, MerchantAccessError } from "./merchant-access.ts";
import { parseStrictJson } from "../http/strict-json.ts";
import { readBoundedBody } from "./main-order-auth.ts";

type Options = MerchantMutationOptions & { database: Pick<AppDatabase, "read" | "write" | "instanceId">; enabled: boolean };
const statusInput = z.object({ targetMerchantId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/), enabled: z.boolean() }).strict();
export function createMerchantManagementRoutes(options: Options) {
  const app = new Hono(), auth = merchantMutationAuth(options, "merchant-management");
  const origin = new URL(options.identityOrigin);
  if (origin.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(origin.hostname) || origin.pathname !== "/" || origin.username || origin.password || origin.search || origin.hash) throw new Error("invalid merchant authority");
  async function mainRequest(cookie: string, path: string, body?: { enabled: boolean }) {
    const response = await (options.identityFetch ?? fetch)(new URL(path, origin), { method: body ? "PATCH" : "GET",
      headers: { cookie, accept: "application/json", ...(body ? { "content-type": "application/json", origin: options.publicOrigin, host: new URL(options.publicOrigin).host } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (response.status === 401) throw new MerchantAccessError("unauthenticated");
    if ([403, 404].includes(response.status)) throw new MerchantAccessError("forbidden");
    const value = parseStrictJson(await readBoundedBody(response.body, 512 * 1024)) as Record<string, unknown>;
    if (!response.ok || value.ok !== true) throw new MerchantAccessError("unavailable");
    return value;
  }
  app.use("*", async (context, next) => { context.header("Cache-Control", "no-store"); await next(); });
  app.onError((error, context) => {
    if (error instanceof MerchantAccessError) return context.json({ ok: false, error: error.code }, error.code === "unauthenticated" ? 401 : error.code === "unavailable" ? 503 : 403);
    return context.json({ ok: false, code: "merchant_status_invalid", error: "商户状态未修改，请检查权限与当前记录。" }, 409);
  });
  app.get("/", async context => {
    const { access, cookie } = await auth.authenticate(context.req.raw, false);
    if (access.role !== "admin") throw new MerchantAccessError("forbidden");
    const response = await mainRequest(cookie, "/api/admin/merchants");
    const rows = z.array(z.object({ id: z.string(), displayName: z.string().optional(), username: z.string().optional(), apiId: z.string(), enabled: z.boolean() })).max(100).parse(response.merchants);
    const checked = await authorizeMainAdmin({ database: options.database, origin: options.identityOrigin, cookie, merchantId: access.merchantId, ...(options.identityFetch ? { fetch: options.identityFetch } : {}) });
    if (checked.userId !== access.userId) throw new MerchantAccessError("forbidden");
    const merchants = options.database.read(sql => rows.map(row => {
      const binding = sql.prepare("SELECT epay_merchant_id FROM epay_merchant_bindings WHERE main_merchant_id=? AND main_api_id=?").get(row.id, row.apiId);
      return binding ? { merchantId: row.id, name: row.displayName || row.username || row.id, enabled: row.enabled, epayMerchantId: Number(binding.epay_merchant_id) } : null;
    }).filter(row => row !== null));
    return context.json({ ok: true, data: { merchants, canEdit: options.enabled, csrfToken: auth.issue(cookie, access) } });
  });
  app.post("/status", async context => {
    if (!options.enabled) return context.json({ ok: false, error: "maintenance_read_only" }, 503);
    const { access, cookie } = await auth.authenticate(context.req.raw, true);
    if (access.role !== "admin" || !access.userId) throw new MerchantAccessError("forbidden");
    if (!/^application\/json(?:;|$)/i.test(context.req.header("content-type") ?? "")) return context.json({ ok: false, error: "invalid_content_type" }, 415);
    const input = statusInput.parse(parseStrictJson(await readBoundedBody(context.req.raw.body, 4096)));
    const binding = options.database.read(sql => sql.prepare("SELECT epay_merchant_id,main_api_id FROM epay_merchant_bindings WHERE main_merchant_id=?").get(input.targetMerchantId));
    if (!binding) throw new MerchantAccessError("invalid_binding");
    if (!input.enabled && input.targetMerchantId === access.merchantId) throw new Error("select another active reference merchant before disabling this merchant");
    const response = await mainRequest(cookie, `/api/admin/merchants/${encodeURIComponent(input.targetMerchantId)}/status`, { enabled: input.enabled });
    const merchant = response.merchant as Record<string, unknown> | undefined;
    if (!merchant || merchant.id !== input.targetMerchantId || merchant.apiId !== binding.main_api_id || merchant.enabled !== input.enabled) throw new MerchantAccessError("unavailable");
    const current = await authorizeMainAdmin({ database: options.database, origin: options.identityOrigin, cookie, merchantId: access.merchantId, ...(options.identityFetch ? { fetch: options.identityFetch } : {}) });
    if (current.userId !== access.userId) throw new MerchantAccessError("forbidden");
    options.database.write(sql => {
      const updated = sql.prepare(`UPDATE epay_merchant_accounts SET enabled=? WHERE merchant_id=? AND EXISTS(
        SELECT 1 FROM epay_merchant_bindings b WHERE b.epay_merchant_id=epay_merchant_accounts.merchant_id AND b.main_merchant_id=? AND b.main_api_id=?)`)
        .run(input.enabled ? 1 : 0, binding.epay_merchant_id!, input.targetMerchantId, String(binding.main_api_id));
      if (Number(updated.changes) !== 1) throw new MerchantAccessError("invalid_binding");
    });
    return context.json({ ok: true, data: { targetMerchantId: input.targetMerchantId, enabled: input.enabled } });
  });
  return app;
}
