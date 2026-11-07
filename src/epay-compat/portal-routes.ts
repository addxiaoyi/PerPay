import { Hono } from "hono";
import type { AppDatabase } from "../database/database.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { authorizeMerchant, MerchantAccessError } from "./merchant-access.ts";
import { portalOverview, portalRecords, type PortalScope } from "./portal-read-model.ts";
import { auditConfirmedPayments } from "./confirmation-audit.ts";
import { auditNativeRefunds } from "./refund-audit.ts";
import { auditNativeSettlements } from "./settlement-workflow.ts";
import { auditPayouts } from "./payout-audit.ts";

type Options = { database: Pick<AppDatabase, "read" | "instanceId">; masterKey: Uint8Array; identityOrigin: string; identityFetch?: typeof fetch; clock?: () => number };
const kinds = ["orders", "notifications", "ledger", "refunds", "settlements"] as const;
export function createPortalRoutes(options: Options) {
  const app = new Hono();
  const cipher = new RuntimeSecretCipher(options.masterKey, options.database.instanceId());
  app.use("*", async (context, next) => { context.header("Cache-Control", "no-store"); await next(); });
  app.onError((error, context) => {
    if (error instanceof MerchantAccessError) return context.json({ ok: false, error: error.code }, error.code === "unauthenticated" ? 401 : error.code === "unavailable" ? 503 : 403);
    return context.json({ ok: false, error: "service_unavailable" }, 503);
  });
  app.get("/:kind", async context => {
    const kind = context.req.param("kind"), query = new URL(context.req.url).searchParams;
    if (![...kinds, "overview", "system"].includes(kind)) return context.json({ ok: false, error: "not_found" }, 404);
    const allowed = ["merchantId", "scope", "days", "page", "search", "status", "source", "targetMerchantId"];
    if ([...query.keys()].some(key => !allowed.includes(key) || query.getAll(key).length !== 1)) return context.json({ ok: false, error: "invalid_query" }, 400);
    const days = Number(query.get("days") ?? 30), page = Number(query.get("page") ?? 1), search = (query.get("search") ?? "").trim();
    if (["status", "source"].some(key => query.has(key) && !/^[A-Za-z_]{0,64}$/.test(query.get(key)!)) || (query.get("targetMerchantId") ?? "").length > 128) return context.json({ ok: false, error: "invalid_query" }, 400);
    if (![7, 30, 90].includes(days) || !Number.isSafeInteger(page) || page < 1 || page > 100000 || search.length > 150 || /[\x00-\x1f\x7f]/.test(search) || !["merchant", "admin"].includes(query.get("scope") ?? "merchant")) return context.json({ ok: false, error: "invalid_query" }, 400);
    const access = await authorizeMerchant({ database: options.database, origin: options.identityOrigin, cookie: context.req.header("cookie") ?? "", merchantId: query.get("merchantId") ?? "", ...(options.identityFetch ? { fetch: options.identityFetch } : {}) });
    const all = query.get("scope") === "admin";
    if ((all || kind === "system") && (access.role !== "admin" || !access.userId)) throw new MerchantAccessError("forbidden");
    if (!all && query.has("targetMerchantId")) throw new MerchantAccessError("forbidden");
    const scope: PortalScope = { ...access, all };
    const data = options.database.read(sql => {
      sql.exec("BEGIN");
      try {
        if (!sql.prepare(`SELECT 1 FROM epay_merchant_bindings b JOIN epay_merchant_accounts m ON m.merchant_id=b.epay_merchant_id
          WHERE b.main_merchant_id=? AND b.main_api_id=? AND b.epay_merchant_id=? AND m.enabled=1`).get(access.merchantId, access.mainApiId, access.epayMerchantId)) throw new MerchantAccessError("invalid_binding");
        if (kind === "overview") return portalOverview(sql, scope, (options.clock ?? Date.now)(), days);
        if (kind === "system") {
          const sync = sql.prepare("SELECT value FROM system_metadata WHERE key='epay_source_sync'").get();
          const source = sync ? JSON.parse(String(sync.value)) as { ok?: boolean; appliedAt?: number } : null;
          return { observedAt: (options.clock ?? Date.now)(), sourceSync: { ok: source?.ok === true, appliedAt: source?.appliedAt ?? null },
            payments: auditConfirmedPayments(sql), refunds: auditNativeRefunds(sql), settlements: auditNativeSettlements(sql), payouts: auditPayouts(sql, (options.clock ?? Date.now)()),
            channels: sql.prepare("SELECT provider,product,enabled FROM epay_channels ORDER BY channel_id").all().map(row => ({ provider: String(row.provider), product: String(row.product), enabled: Number(row.enabled) === 1 })), invoiceEnabled: false };
        }
        const rows = portalRecords(sql, cipher, scope, kind as typeof kinds[number]).filter(row =>
          (!query.get("targetMerchantId") || row.merchantId === query.get("targetMerchantId")) &&
          (!query.get("status") || row.status === query.get("status")) && (!query.get("source") || row.source === query.get("source")) &&
          (!search || [row.id, row.orderId, row.merchantOrderId, row.name, row.merchantName].some(value => value?.toLowerCase().includes(search.toLowerCase()))));
        return { records: rows.slice((page - 1) * 20, page * 20), total: rows.length, page, hasNext: rows.length > page * 20 };
      } finally { sql.exec("ROLLBACK"); }
    });
    return context.json({ ok: true, data });
  });
  return app;
}
