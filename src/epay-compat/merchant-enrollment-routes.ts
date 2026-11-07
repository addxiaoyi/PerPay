import { Hono } from "hono";
import { z } from "zod";
import type { AppDatabase } from "../database/database.ts";
import { parseStrictJson } from "../http/strict-json.ts";
import { readBoundedBody } from "./main-order-auth.ts";
import { authorizeMainAdmin, MerchantAccessError } from "./merchant-access.ts";
import { merchantMutationAuth, type MerchantMutationOptions } from "./merchant-mutation-auth.ts";
import { reserveMerchantCreation, completeMerchantEnrollment, mainCreatedMerchant, EnrollmentConflict } from "./merchant-enrollment.ts";

type Options = MerchantMutationOptions & { database: Pick<AppDatabase, "read" | "write" | "instanceId">; enabled: boolean };
export function createEnrollmentRoutes(options: Options) {
  const app = new Hono(), auth = merchantMutationAuth(options, "merchant-management"), clock = options.clock ?? Date.now;
  const origin = new URL(options.identityOrigin);
  if (origin.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(origin.hostname) || origin.pathname !== "/" || origin.username || origin.password || origin.hash || origin.search) throw new Error("merchant identity source must be loopback");
  const readMain = async (cookie: string, input?: { userId: string; displayName: string; callbackUrl: string }) => {
    const response = await (options.identityFetch ?? fetch)(new URL("/api/admin/merchants", origin), {
      method: input ? "POST" : "GET", headers: { cookie, accept: "application/json", ...(input ? { "content-type": "application/json", origin: options.publicOrigin, host: new URL(options.publicOrigin).host } : {}) },
      ...(input ? { body: JSON.stringify(input) } : {}), redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (response.status === 401) throw new MerchantAccessError("unauthenticated");
    if (response.status === 403) throw new MerchantAccessError("forbidden");
    const body = parseStrictJson(await readBoundedBody(response.body, 512 * 1024)) as Record<string, unknown>;
    if (!response.ok || body.ok !== true) throw new EnrollmentConflict("main merchant creation was rejected");
    return body;
  };
  app.use("*", async (context, next) => { context.header("Cache-Control", "no-store"); await next(); });
  app.onError((error, context) => {
    if (error instanceof MerchantAccessError) return context.json({ ok: false, error: error.code }, error.code === "unauthenticated" ? 401 : error.code === "unavailable" ? 503 : 403);
    if (error instanceof EnrollmentConflict || error instanceof z.ZodError) return context.json({ ok: false, code: "merchant_creation_conflict", error: "账户已有商户、资料不一致或创建未确认，请核对原申请后重试。" }, 409);
    return context.json({ ok: false, code: "merchant_creation_pending", error: "商户创建结果未确认，请使用原申请重试。" }, 503);
  });
  app.get("/creation-session", async context => {
    const { access, cookie } = await auth.authenticate(context.req.raw, false), canCreate = options.enabled && access.role === "admin";
    return context.json({ ok: true, data: { canCreate, csrfToken: canCreate ? auth.issue(cookie, access) : null } });
  });
  app.post("/create", async context => {
    if (!options.enabled) return context.json({ ok: false, error: "maintenance_read_only" }, 503);
    const { access, cookie } = await auth.authenticate(context.req.raw, true);
    if (access.role !== "admin" || !access.userId) throw new MerchantAccessError("forbidden");
    if (!/^application\/json(?:;|$)/i.test(context.req.header("content-type") ?? "")) return context.json({ ok: false, error: "invalid_content_type" }, 415);
    const raw = parseStrictJson(await readBoundedBody(context.req.raw.body, 4096));
    const administrator = { ...access, role: "admin" as const, userId: access.userId };
    const command = reserveMerchantCreation(options.database, administrator, raw, clock());
    const directory = await readMain(cookie);
    if (!Array.isArray(directory.merchants)) throw new MerchantAccessError("unavailable");
    const matches = directory.merchants.filter((row: { userId?: string }) => row.userId === command.userId);
    if (matches.length > 1) throw new EnrollmentConflict("main merchant owner is ambiguous");
    const candidate = matches[0] ?? (await readMain(cookie, { userId: command.userId, displayName: command.displayName, callbackUrl: command.callbackUrl })).merchant;
    const merchant = mainCreatedMerchant.parse(candidate);
    // A revoked administrator may leave a pending main-site creation; a fresh grant is required to bind it.
    const current = await authorizeMainAdmin({ database: options.database, origin: options.identityOrigin, cookie, merchantId: access.merchantId, ...(options.identityFetch ? { fetch: options.identityFetch } : {}) });
    if (current.userId !== access.userId) throw new MerchantAccessError("forbidden");
    const enrolled = completeMerchantEnrollment(options.database, options.masterKey, current, command.requestId, merchant, clock());
    return context.json({ ok: true, data: { createdMerchantId: enrolled.merchantId, epayMerchantId: enrolled.epayMerchantId, duplicate: enrolled.duplicate } }, enrolled.duplicate ? 200 : 201);
  });
  return app;
}
