import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { createPortalRoutes } from "./portal-routes.ts";
import { z } from "zod";
import type { AppDatabase } from "../database/database.ts";
import type { DatabaseSync } from "node:sqlite";
import { parseStrictJson } from "../http/strict-json.ts";
import { authorizeMainAdmin, authorizeMerchant, MerchantAccessError } from "./merchant-access.ts";
import { changeMerchantFee, MerchantFeeConflict, readMerchantFee, readMerchantFeeHistory } from "./merchant-fee-admin.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { projectCombinedMerchantBalance } from "./combined-balance.ts";
import { adjustMerchantBalance, BalanceConflict, BalanceUnavailable, InsufficientBalance, readLiveBalance } from "./live-balance.ts";
import { readMerchantSecret } from "./merchant-secret.ts";
import { changeMainMember, readMainMembers, memberCommand, MemberChangeError } from "./main-members.ts";
import { createRefundRoutes } from "./refund-routes.ts";
import { createSettlementRoutes } from "./settlement-routes.ts";
import { createMerchantKeyRoutes } from "./merchant-key-routes.ts";
import { createEnrollmentRoutes } from "./merchant-enrollment-routes.ts";
import { createCallbackRetryRoutes } from "./callback-retry-routes.ts";
import { createMerchantProfileRoutes } from "./merchant-profile-routes.ts";
import { createMerchantManagementRoutes } from "./merchant-management-routes.ts";
import { createPayoutRoutes, type PayoutServices } from "./payout-routes.ts";

type Database = Pick<AppDatabase, "read" | "write" | "instanceId">;
type Options = {
  readonly database: Database;
  readonly masterKey: Uint8Array;
  readonly identityOrigin: string;
  readonly publicOrigin: string;
  readonly allowAdministration: boolean;
  readonly identityFetch?: typeof fetch;
  readonly clock?: () => number;
  readonly payouts?: PayoutServices;
};
const TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 4096;
const MAX_DIRECTORY_MERCHANTS = 100;
const feeInput = z.object({
  expectedFeeBps: z.number().int().min(0).max(5000), expectedVersion: z.number().int().nonnegative(),
  feeBps: z.number().int().min(0).max(5000), reason: z.string().trim().min(1).max(512).regex(/^[^\x00-\x1f\x7f]+$/),
}).strict();
const adjustmentInput = z.object({
  requestId: z.string().regex(/^[a-zA-Z0-9_-]{16,80}$/),
  deltaCents: z.number().int().safe().refine(value => value !== 0),
  expectedVersion: z.number().int().nonnegative().safe(),
  reason: z.string().trim().min(1).max(512).regex(/^[^\x00-\x1f\x7f]+$/),
}).strict();

function requireCurrentBinding(sql: DatabaseSync, access: Awaited<ReturnType<typeof authorizeMerchant>>) {
  if (!sql.prepare(`SELECT 1 FROM epay_merchant_bindings b JOIN epay_merchant_accounts m ON m.merchant_id=b.epay_merchant_id
    WHERE b.main_merchant_id=? AND b.main_api_id=? AND b.epay_merchant_id=? AND m.enabled=1`).get(access.merchantId, access.mainApiId, access.epayMerchantId)) throw new MerchantAccessError("invalid_binding");
}

function merchantQuery(url: string, history = false) {
  const query = new URL(url).searchParams;
  const ids = query.getAll("merchantId"), cursors = query.getAll("before");
  if (ids.length !== 1 || !ids[0] || ids[0].length > 128 || ids[0] !== ids[0].trim() || cursors.length > (history ? 1 : 0) || [...query.keys()].some(key => key !== "merchantId" && !(history && key === "before"))) throw new MerchantAccessError("forbidden");
  const before = cursors.length ? Number(cursors[0]) : null;
  if (before !== null && (!/^[1-9]\d{0,14}$/.test(cursors[0]!) || !Number.isSafeInteger(before))) throw new MerchantAccessError("forbidden");
  return { merchantId: ids[0], before };
}

async function readConsoleBody(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json") || !request.body) throw new Error("invalid request body");
  const reader = request.body.getReader(), parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_BODY_BYTES) throw new Error("request body is too large");
      parts.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return parseStrictJson(Buffer.concat(parts));
}

export function createMainMerchantConsole(options: Options) {
  const app = new Hono();
  app.route("/portal", createPortalRoutes(options));
  app.route("/refunds", createRefundRoutes({ ...options, enabled: options.allowAdministration }));
  app.route("/settlements", createSettlementRoutes({ ...options, enabled: options.allowAdministration }));
  app.route("/payouts", createPayoutRoutes({ ...options, ...options.payouts, enabled: options.allowAdministration }));
  app.route("/keys", createMerchantKeyRoutes({ ...options, enabled: options.allowAdministration }));
  app.route("/merchants", createEnrollmentRoutes({ ...options, enabled: options.allowAdministration }));
  app.route("/callbacks", createCallbackRetryRoutes({ ...options, enabled: options.allowAdministration }));
  app.route("/profile", createMerchantProfileRoutes({ ...options, enabled: options.allowAdministration }));
  app.route("/management", createMerchantManagementRoutes({ ...options, enabled: options.allowAdministration }));
  const tokenKey = Buffer.from(hkdfSync("sha256", options.masterKey, Buffer.from(options.database.instanceId()), Buffer.from("perpay:main-merchant-csrf:v1"), 32));
  const now = () => {
    const value = (options.clock ?? Date.now)();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid console clock");
    return value;
  };
  const authOptions = (cookie: string, merchantId: string) => ({ origin: options.identityOrigin, cookie, merchantId, database: options.database, ...(options.identityFetch ? { fetch: options.identityFetch } : {}) });
  const signature = (cookie: string, merchantId: string, userId: string, expiry: number) => createHmac("sha256", tokenKey).update(JSON.stringify([cookie, merchantId, userId, expiry])).digest("base64url");
  const validCsrf = (token: string, cookie: string, merchantId: string, userId: string, currentTime: number) => {
    const parts = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(token);
    const expiry = Number(parts?.[1]);
    return Boolean(parts && expiry > currentTime && expiry - currentTime <= TOKEN_TTL_MS && timingSafeEqual(Buffer.from(parts[2]!), Buffer.from(signature(cookie, merchantId, userId, expiry))));
  };
  app.use("*", async (context, next) => { context.header("Cache-Control", "no-store"); await next(); });
  app.onError((error, context) => {
    if (error instanceof MemberChangeError) return context.json({ ok: false, error: "member_change_rejected" }, error.status);
    if (error instanceof MerchantAccessError) return context.json({ ok: false, error: error.code }, error.code === "unauthenticated" ? 401 : error.code === "unavailable" ? 503 : 403);
    if (error instanceof MerchantFeeConflict) return context.json({ ok: false, error: "fee_conflict" }, 409);
    if (error instanceof BalanceConflict) return context.json({ ok: false, error: "balance_conflict" }, 409);
    if (error instanceof InsufficientBalance) return context.json({ ok: false, error: "insufficient_balance" }, 409);
    if (error instanceof BalanceUnavailable) return context.json({ ok: false, error: "balance_unavailable" }, 503);
    return context.json({ ok: false, error: "service_unavailable" }, 503);
  });

  app.get("/access", async context => {
    if (new URL(context.req.url).search) return context.json({ ok: false, error: "invalid_query" }, 400);
    const cookie = context.req.header("cookie") ?? "";
    if (!cookie || cookie.length > 8192 || /[\r\n]/.test(cookie)) throw new MerchantAccessError("unauthenticated");
    const candidates = options.database.read(sql => sql.prepare(`SELECT b.main_merchant_id,b.main_api_id,m.merchant_id,m.name,m.fee_rate_bps,m.updated_at
      FROM epay_merchant_bindings b JOIN epay_merchant_accounts m ON m.merchant_id=b.epay_merchant_id
      WHERE m.enabled=1 ORDER BY m.merchant_id LIMIT ?`).all(MAX_DIRECTORY_MERCHANTS + 1));
    if (candidates.length > MAX_DIRECTORY_MERCHANTS) throw new MerchantAccessError("unavailable");
    const merchants = [];
    for (let offset = 0; offset < candidates.length; offset += 4) {
      const batch = await Promise.all(candidates.slice(offset, offset + 4).map(async row => {
        try {
          const access = await authorizeMerchant(authOptions(cookie, String(row.main_merchant_id)));
          if (access.epayMerchantId !== Number(row.merchant_id) || access.mainApiId !== row.main_api_id) throw new MerchantAccessError("invalid_binding");
          if (!access.userId) throw new MerchantAccessError("unauthenticated");
          return { userId: access.userId, merchantId: access.merchantId, epayMerchantId: access.epayMerchantId, name: String(row.name), role: access.role, feeBps: Number(row.fee_rate_bps), version: Number(row.updated_at) };
        } catch (error) {
          if (error instanceof MerchantAccessError && error.code === "forbidden") return null;
          throw error;
        }
      }));
      merchants.push(...batch.filter(value => value !== null));
    }
    const subjects = new Set(merchants.map(merchant => merchant.userId));
    if (subjects.size > 1 || merchants.some(merchant => merchant.role === "admin") && merchants.some(merchant => merchant.role !== "admin")) throw new MerchantAccessError("unavailable");
    const collectionChannels = options.database.read(sql => {
      const marker = sql.prepare("SELECT value FROM system_metadata WHERE key='epay_configured_channels'").get();
      if (!marker) return [];
      const ids = JSON.parse(String(marker.value)) as { alipayChannelId: number; wechatChannelId: number };
      const alipay = sql.prepare("SELECT enabled,product FROM epay_channels WHERE channel_id=? AND provider='ALIPAY'").get(ids.alipayChannelId);
      const wechat = sql.prepare("SELECT enabled FROM epay_channels WHERE channel_id=? AND provider='WECHAT'").get(ids.wechatChannelId);
      return [...(Number(alipay?.enabled) === 1 ? [["pc", "wap"].includes(String(alipay?.product)) ? "alipay_web" : "alipay_scan"] : []), ...(Number(wechat?.enabled) === 1 ? ["wechat_native"] : [])];
    });
    return context.json({ ok: true, data: { userId: merchants[0]?.userId ?? null, merchants: merchants.map(({ userId: _userId, ...merchant }) => merchant), administrationEnabled: options.allowAdministration, collectionChannels } });
  });

  app.get("/session", async context => {
    const { merchantId } = merchantQuery(context.req.url);
    const cookie = context.req.header("cookie") ?? "";
    const access = await authorizeMerchant(authOptions(cookie, merchantId));
    const expiresAt = now() + TOKEN_TTL_MS;
    const canAdminister = access.role === "admin" && Boolean(access.userId) && options.allowAdministration;
    return context.json({ ok: true, data: { merchantId, role: access.role, canAdminister, csrfToken: canAdminister ? `${expiresAt}.${signature(cookie, merchantId, access.userId!, expiresAt)}` : null, expiresAt } });
  });

  for (const path of ["/keys/meta", "/keys"] as const) app.get(path, async context => {
    if (context.req.header("sec-fetch-site") === "cross-site" || (context.req.header("origin") && context.req.header("origin") !== options.publicOrigin)) return context.json({ ok: false, error: "forbidden" }, 403);
    const { merchantId } = merchantQuery(context.req.url);
    const access = await authorizeMerchant(authOptions(context.req.header("cookie") ?? "", merchantId));
    const keys = options.database.read(sql => {
      requireCurrentBinding(sql, access);
      const configured = sql.prepare("SELECT secret_version FROM epay_merchant_secrets WHERE merchant_id=?").get(access.epayMerchantId);
      const metadata = { merchantId, epayPid: String(access.epayMerchantId), apiId: access.mainApiId, keyConfigured: Boolean(configured) };
      if (path === "/keys/meta") return metadata;
      return { ...metadata, md5Key: readMerchantSecret(sql, new RuntimeSecretCipher(options.masterKey, options.database.instanceId()), access.epayMerchantId) };
    });
    return context.json({ ok: true, data: keys });
  });

  app.get("/fee", async context => {
    const { merchantId } = merchantQuery(context.req.url);
    const access = await authorizeMerchant(authOptions(context.req.header("cookie") ?? "", merchantId));
    const fee = options.database.read(sql => {
      requireCurrentBinding(sql, access);
      return readMerchantFee({ read: operation => operation(sql) }, access.epayMerchantId);
    });
    return context.json({ ok: true, data: fee });
  });
  app.get("/members", async context => {
    const { merchantId } = merchantQuery(context.req.url), cookie = context.req.header("cookie") ?? "";
    const access = await authorizeMainAdmin(authOptions(cookie, merchantId));
    const members = await readMainMembers({ identityOrigin: options.identityOrigin, publicOrigin: options.publicOrigin, cookie, merchantId, ...(options.identityFetch ? { send: options.identityFetch } : {}) });
    options.database.read(sql => requireCurrentBinding(sql, access));
    return context.json({ ok: true, data: members });
  });
  app.post("/members", async context => {
    if (!options.allowAdministration) return context.json({ ok: false, error: "maintenance_read_only" }, 503);
    if (context.req.header("origin") !== options.publicOrigin || context.req.header("sec-fetch-site") === "cross-site") return context.json({ ok: false, error: "forbidden" }, 403);
    const { merchantId } = merchantQuery(context.req.url), cookie = context.req.header("cookie") ?? "";
    const access = await authorizeMainAdmin(authOptions(cookie, merchantId));
    if (!validCsrf(context.req.header("x-csrf-token") ?? "", cookie, merchantId, access.userId, now())) return context.json({ ok: false, error: "csrf_invalid" }, 403);
    let input: z.infer<typeof memberCommand>;
    try { input = memberCommand.parse(await readConsoleBody(context.req.raw)); }
    catch { return context.json({ ok: false, error: "invalid_member_change" }, 400); }
    options.database.read(sql => requireCurrentBinding(sql, access));
    const confirmed = await changeMainMember({ identityOrigin: options.identityOrigin, publicOrigin: options.publicOrigin, cookie, merchantId, ...(options.identityFetch ? { send: options.identityFetch } : {}) }, input);
    options.database.read(sql => requireCurrentBinding(sql, access));
    return context.json({ ok: true, data: confirmed });
  });
  app.get("/balance", async context => {
    const { merchantId } = merchantQuery(context.req.url);
    const access = await authorizeMerchant(authOptions(context.req.header("cookie") ?? "", merchantId));
    const balance = options.database.read(sql => {
      if (sql.isTransaction) throw new Error("nested merchant balance read");
      sql.exec("BEGIN");
      try {
        requireCurrentBinding(sql, access);
        const opened = Boolean(sql.prepare("SELECT 1 FROM epay_balance_openings WHERE merchant_id=?").get(access.epayMerchantId));
        const value = opened ? readLiveBalance(sql, access.epayMerchantId) : {
          ...projectCombinedMerchantBalance(sql, new RuntimeSecretCipher(options.masterKey, options.database.instanceId()), access.epayMerchantId), version: null, migrationBaselineVerified: false,
        };
        sql.exec("COMMIT");
        return value;
      } catch (error) { sql.exec("ROLLBACK"); throw error; }
    });
    return context.json({ ok: true, data: { ...balance, merchantId } });
  });
  app.post("/balance/adjust", async context => {
    if (!options.allowAdministration) return context.json({ ok: false, error: "maintenance_read_only" }, 503);
    if (context.req.header("origin") !== options.publicOrigin || context.req.header("sec-fetch-site") === "cross-site") return context.json({ ok: false, error: "forbidden" }, 403);
    const { merchantId } = merchantQuery(context.req.url), cookie = context.req.header("cookie") ?? "";
    const access = await authorizeMainAdmin(authOptions(cookie, merchantId));
    const currentTime = now();
    if (!validCsrf(context.req.header("x-csrf-token") ?? "", cookie, merchantId, access.userId, currentTime)) return context.json({ ok: false, error: "csrf_invalid" }, 403);
    let input: z.infer<typeof adjustmentInput>;
    try { input = adjustmentInput.parse(await readConsoleBody(context.req.raw)); }
    catch { return context.json({ ok: false, error: "invalid_balance_adjustment" }, 400); }
    const balance = options.database.write(sql => {
      requireCurrentBinding(sql, access);
      return adjustMerchantBalance({ write: operation => operation(sql) }, { ...input, merchantId: access.epayMerchantId, actor: access.userId }, currentTime);
    });
    return context.json({ ok: true, data: { ...balance, merchantId } });
  });
  app.get("/fee/history", async context => {
    const { merchantId, before } = merchantQuery(context.req.url, true);
    const access = await authorizeMainAdmin(authOptions(context.req.header("cookie") ?? "", merchantId));
    const history = options.database.read(sql => {
      requireCurrentBinding(sql, access);
      return readMerchantFeeHistory({ read: operation => operation(sql) }, access.epayMerchantId, before, 50);
    });
    return context.json({ ok: true, data: history });
  });
  app.post("/fee", async context => {
    if (!options.allowAdministration) return context.json({ ok: false, error: "maintenance_read_only" }, 503);
    if (context.req.header("origin") !== options.publicOrigin || context.req.header("sec-fetch-site") === "cross-site") return context.json({ ok: false, error: "forbidden" }, 403);
    const { merchantId } = merchantQuery(context.req.url);
    const cookie = context.req.header("cookie") ?? "";
    let input: z.infer<typeof feeInput>;
    try { input = feeInput.parse(await readConsoleBody(context.req.raw)); } catch { return context.json({ ok: false, error: "invalid_fee_change" }, 400); }
    const access = await authorizeMainAdmin(authOptions(cookie, merchantId));
    const currentTime = now();
    if (!validCsrf(context.req.header("x-csrf-token") ?? "", cookie, merchantId, access.userId, currentTime)) return context.json({ ok: false, error: "csrf_invalid" }, 403);
    if (input.feeBps === input.expectedFeeBps || currentTime <= input.expectedVersion) return context.json({ ok: false, error: "invalid_fee_change" }, 400);
    const changed = options.database.write(sql => {
      requireCurrentBinding(sql, access);
      return changeMerchantFee({ write: operation => operation(sql) }, { ...input, merchantId: access.epayMerchantId, actor: access.userId }, currentTime);
    });
    return context.json({ ok: true, data: changed });
  });
  return app;
}
