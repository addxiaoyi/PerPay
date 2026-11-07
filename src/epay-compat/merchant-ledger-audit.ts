import { Hono } from "hono";
import type { AppDatabase } from "../database/database.ts";
import { authorizeMainAdmin, MerchantAccessError } from "./merchant-access.ts";

type AdjustmentRow = {
  entry_id: string; entry_type: string; available_delta_cents: number | bigint; frozen_delta_cents: number | bigint;
  occurred_at: number | bigint; reason: string | null; actor_id: string | null; source: string;
};

export function createMerchantLedgerAudit(options: {
  database: Pick<AppDatabase, "read">;
  identityOrigin: string;
  identityFetch?: typeof fetch;
}) {
  const app = new Hono();
  app.get("/ledger-adjustments", async context => {
    context.header("Cache-Control", "no-store");
    const query = new URL(context.req.url).searchParams;
    const ids = query.getAll("merchantId"), pages = query.getAll("page");
    if (ids.length !== 1 || pages.length > 1 || [...query.keys()].some(key => key !== "merchantId" && key !== "page")) return context.json({ ok: false, error: "invalid_query" }, 400);
    const pageText = pages[0] ?? "1";
    if (!/^[1-9]\d{0,4}$/.test(pageText)) return context.json({ ok: false, error: "invalid_query" }, 400);
    const page = Number(pageText), pageSize = 20;
    try {
      const access = await authorizeMainAdmin({
        origin: options.identityOrigin, cookie: context.req.header("cookie") ?? "", merchantId: ids[0]!,
        database: options.database, ...(options.identityFetch ? { fetch: options.identityFetch } : {}),
      });
      const entries = options.database.read(sql => {
        const binding = sql.prepare(`SELECT 1 FROM epay_merchant_bindings b JOIN epay_merchant_accounts m ON m.merchant_id=b.epay_merchant_id
          WHERE b.main_merchant_id=? AND b.main_api_id=? AND b.epay_merchant_id=? AND m.enabled=1`)
          .get(access.merchantId, access.mainApiId, access.epayMerchantId);
        if (!binding) throw new MerchantAccessError("invalid_binding");
        // Keep audit details out of the ordinary merchant ledger response.
        return sql.prepare(`SELECT l.entry_id,l.entry_type,l.available_delta_cents,l.frozen_delta_cents,l.occurred_at,l.reason,l.actor_id,l.source
          FROM epay_balance_ledger l JOIN epay_merchant_bindings b ON b.epay_merchant_id=l.merchant_id
          JOIN epay_merchant_accounts m ON m.merchant_id=b.epay_merchant_id AND m.enabled=1
          WHERE b.main_merchant_id=? AND b.main_api_id=? AND b.epay_merchant_id=?
          AND l.entry_type IN ('manual_adjustment','payment_manual_adjustment')
          ORDER BY l.occurred_at DESC,l.entry_id DESC LIMIT ? OFFSET ?`)
          .all(access.merchantId, access.mainApiId, access.epayMerchantId, pageSize + 1, (page - 1) * pageSize) as AdjustmentRow[];
      });
      const adjustments = entries.slice(0, pageSize).map(entry => {
        const availableDeltaCents = Number(entry.available_delta_cents), frozenDeltaCents = Number(entry.frozen_delta_cents), occurredAt = Number(entry.occurred_at);
        if (![availableDeltaCents, frozenDeltaCents, occurredAt].every(Number.isSafeInteger) || occurredAt < 0) throw new Error("invalid adjustment values");
        return {
          id: entry.entry_id, type: entry.entry_type, availableDeltaCents, frozenDeltaCents, occurredAt,
          reason: entry.reason, actorId: entry.actor_id, source: entry.source,
        };
      });
      return context.json({ ok: true, data: { merchantId: access.merchantId, adjustments, page, pageSize, hasNext: entries.length > pageSize } });
    } catch (error) {
      if (error instanceof MerchantAccessError) return context.json({ ok: false, error: error.code }, error.code === "unauthenticated" ? 401 : error.code === "unavailable" ? 503 : 403);
      return context.json({ ok: false, error: "service_unavailable" }, 503);
    }
  });
  return app;
}
