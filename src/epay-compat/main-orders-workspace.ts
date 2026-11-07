import { orderReadSource } from "./order-read-source.ts";
import { Hono } from "hono";
import type { AppDatabase } from "../database/database.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { authorizeMerchant, MerchantAccessError } from "./merchant-access.ts";
import { readEncryptedMainOrder } from "./main-order-source.ts";
import { readEncryptedMainRefund } from "./main-refund-source.ts";
import { readMainActivity } from "./main-activity-source.ts";
import { verifyWechatMasterKeyGuard } from "./wechat-master-key.ts";
import type { DatabaseSync } from "node:sqlite";
import { readSynchronizedOrders, readSynchronizedActivity } from "./main-current-workspace.ts";

function verifyHistoricalImport(db: DatabaseSync, cipher: RuntimeSecretCipher, kind: "order" | "refund") {
  verifyWechatMasterKeyGuard(db, cipher);
  const query = kind === "order"
    ? "SELECT r.order_count AS expected, (SELECT count(*) FROM epay_main_order_sources) AS actual FROM epay_main_order_import_runs r WHERE r.singleton_key=1"
    : "SELECT r.refund_count AS expected, (SELECT count(*) FROM epay_main_refund_sources) AS actual FROM epay_main_refund_import_runs r WHERE r.singleton_key=1";
  const row = db.prepare(query).get() as { expected: number | bigint; actual: number | bigint } | undefined;
  if (!row || BigInt(row.expected) !== BigInt(row.actual)) throw new Error(`main ${kind} import is incomplete`);
}

// Historical data remains isolated and is not a reconciled production balance.
export function createMainOrdersWorkspace(options: { database: Pick<AppDatabase, "read" | "instanceId">; masterKey: Uint8Array; identityOrigin: string; identityFetch?: typeof fetch }) {
  const app = new Hono();
  app.get("/combined-orders", async (context) => {
    context.header("Cache-Control", "no-store");
    const query = new URL(context.req.url).searchParams;
    const ids = query.getAll("merchantId"), pages = query.getAll("page"), sizes = query.getAll("pageSize"), searches = query.getAll("search"), statuses = query.getAll("status");
    if (ids.length !== 1 || pages.length > 1 || sizes.length > 1 || searches.length > 1 || statuses.length > 1 || [...query.keys()].some(key => !["merchantId", "page", "pageSize", "search", "status"].includes(key))) return context.json({ ok: false, error: "invalid_query" }, 400);
    const pageText = pages[0] ?? "1", sizeText = sizes[0] ?? "20", search = (searches[0] ?? "").trim(), status = statuses[0] ?? "";
    if (!/^[1-9]\d{0,4}$/.test(pageText) || !/^[1-9]\d{0,2}$/.test(sizeText) || Number(sizeText) > 100 || search.length > 128 || /[\x00-\x1f\x7f]/.test(search) || (status !== "" && !/^[a-z][a-z0-9_]{0,63}$/.test(status))) return context.json({ ok: false, error: "invalid_query" }, 400);
    const page = Number(pageText), pageSize = Number(sizeText), pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
    try {
      const access = await authorizeMerchant({ origin: options.identityOrigin, cookie: context.req.header("cookie") ?? "", merchantId: ids[0]!, database: options.database, ...(options.identityFetch ? { fetch: options.identityFetch } : {}) });
      const cipher = new RuntimeSecretCipher(options.masterKey, options.database.instanceId());
      const result = options.database.read((db) => {
        db.exec("SAVEPOINT combined_order_read");
        try {
          const synced = readSynchronizedOrders(db, cipher, access, { page, pageSize, search, status }, true);
          if (synced) { db.exec("RELEASE SAVEPOINT combined_order_read"); return synced; }
          verifyHistoricalImport(db, cipher, "order");
          const scope = { mainMerchantId: access.merchantId, mainApiId: access.mainApiId, epayMerchantId: access.epayMerchantId };
          const rows = db.prepare(`SELECT * FROM (
            SELECT 'main_site' AS source,o.order_id AS id,o.merchant_order_id,o.amount_cents,o.status,o.created_at
            FROM epay_main_order_sources o JOIN epay_merchant_bindings b ON b.epay_merchant_id=o.merchant_id
            JOIN epay_merchant_accounts m ON m.merchant_id=o.merchant_id AND m.enabled=1
            WHERE b.main_merchant_id=? AND b.main_api_id=? AND o.merchant_id=?
            UNION ALL
            SELECT 'epay' AS source,o.trade_no AS id,o.out_trade_no AS merchant_order_id,o.money_cents AS amount_cents,
              CASE o.status WHEN 'PENDING' THEN 'pending_payment' ELSE lower(o.status) END AS status,o.created_at
            FROM ${orderReadSource(db)} o JOIN epay_merchant_bindings b ON b.epay_merchant_id=o.merchant_id
            JOIN epay_merchant_accounts m ON m.merchant_id=o.merchant_id AND m.enabled=1
            WHERE b.main_merchant_id=? AND b.main_api_id=? AND o.merchant_id=?
          ) WHERE (?='' OR status=?) AND (?='' OR id LIKE ? ESCAPE '\\' OR merchant_order_id LIKE ? ESCAPE '\\')
          ORDER BY created_at DESC,source DESC,id DESC LIMIT ? OFFSET ?`)
            .all(access.merchantId, access.mainApiId, access.epayMerchantId, access.merchantId, access.mainApiId, access.epayMerchantId, status, status, search, pattern, pattern, pageSize + 1, (page - 1) * pageSize) as Array<{ source: "main_site" | "epay"; id: string; merchant_order_id: string; amount_cents: number | bigint; status: string; created_at: number | bigint }>;
          const orders = rows.slice(0, pageSize).map(row => {
            if (row.source === "main_site") {
              const raw = readEncryptedMainOrder(db, cipher, row.id, scope);
              if (raw === null) throw new Error("main order access changed");
              const order = JSON.parse(raw) as { id: string; merchantOrderId: string; amountCents: number; status: string; createdAt: string };
              return { id: order.id, merchantOrderId: order.merchantOrderId, amountCents: order.amountCents, status: order.status, createdAt: order.createdAt, source: row.source };
            }
            const cents = Number(row.amount_cents), createdAt = Number(row.created_at);
            if (!Number.isSafeInteger(cents) || cents < 0 || !Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error("invalid EPay order values");
            return { id: row.id, merchantOrderId: row.merchant_order_id, amountCents: cents, status: row.status, createdAt: new Date(createdAt).toISOString(), source: row.source };
          });
          db.exec("RELEASE SAVEPOINT combined_order_read");
          return { orders, hasNext: rows.length > pageSize };
        } catch (error) {
          db.exec("ROLLBACK TO SAVEPOINT combined_order_read; RELEASE SAVEPOINT combined_order_read");
          throw error;
        }
      });
      return context.json({ ok: true, data: { merchantId: access.merchantId, ...result, page, pageSize, scope: "unreconciled_sources", deduplicated: false, reconciled: false } });
    } catch (error) {
      if (error instanceof MerchantAccessError) {
        if (error.code === "unauthenticated") return context.json({ ok: false, error: "unauthenticated" }, 401);
        if (error.code === "forbidden" || error.code === "invalid_binding") return context.json({ ok: false, error: "merchant_not_found" }, 404);
      }
      return context.json({ ok: false, error: "service_unavailable" }, 503);
    }
  });
  app.get("/main-activity", async (context) => {
    context.header("Cache-Control", "no-store");
    const query = new URL(context.req.url).searchParams;
    const ids = query.getAll("merchantId"), kinds = query.getAll("kind"), pages = query.getAll("page"), sizes = query.getAll("pageSize");
    if (ids.length !== 1 || kinds.length !== 1 || pages.length > 1 || sizes.length > 1 || [...query.keys()].some(key => !["merchantId", "kind", "page", "pageSize"].includes(key))) return context.json({ ok: false, error: "invalid_query" }, 400);
    const kind = kinds[0], pageText = pages[0] ?? "1", sizeText = sizes[0] ?? "20";
    if ((kind !== "settlements" && kind !== "callbacks") || !/^[1-9]\d{0,4}$/.test(pageText) || !/^[1-9]\d{0,2}$/.test(sizeText) || Number(sizeText) > 100) return context.json({ ok: false, error: "invalid_query" }, 400);
    const page = Number(pageText), pageSize = Number(sizeText);
    try {
      const access = await authorizeMerchant({ origin: options.identityOrigin, cookie: context.req.header("cookie") ?? "", merchantId: ids[0]!, database: options.database, ...(options.identityFetch ? { fetch: options.identityFetch } : {}) });
      const cipher = new RuntimeSecretCipher(options.masterKey, options.database.instanceId());
      const result = options.database.read((db) => {
        const synced = readSynchronizedActivity(db, cipher, access, { page, pageSize }, kind);
        if (synced) return synced;
        verifyWechatMasterKeyGuard(db, cipher);
        const counts = db.prepare(`SELECT r.settlement_count,r.callback_count,r.sync_job_count,
          (SELECT count(*) FROM epay_main_activity_sources WHERE kind='settlements') AS settlements,
          (SELECT count(*) FROM epay_main_activity_sources WHERE kind='callbacks') AS callbacks,
          (SELECT count(*) FROM epay_main_activity_sources WHERE kind='syncJobs') AS jobs
          FROM epay_main_activity_import_runs r WHERE r.singleton_key=1`).get() as Record<string, number | bigint> | undefined;
        if (!counts || BigInt(counts.settlement_count!) !== BigInt(counts.settlements!) || BigInt(counts.callback_count!) !== BigInt(counts.callbacks!) || BigInt(counts.sync_job_count!) !== BigInt(counts.jobs!)) throw new Error("main activity import is incomplete");
        const selected = db.prepare(`SELECT s.source_id FROM epay_main_activity_sources s
          JOIN epay_merchant_bindings b ON b.epay_merchant_id=s.merchant_id
          JOIN epay_merchant_accounts m ON m.merchant_id=s.merchant_id AND m.enabled=1
          WHERE b.main_merchant_id=? AND b.main_api_id=? AND s.merchant_id=? AND s.kind=?
          ORDER BY s.source_id LIMIT ? OFFSET ?`).all(access.merchantId, access.mainApiId, access.epayMerchantId, kind, pageSize + 1, (page - 1) * pageSize) as Array<{ source_id: string }>;
        const scope = { mainMerchantId: access.merchantId, mainApiId: access.mainApiId, epayMerchantId: access.epayMerchantId };
        const records = selected.slice(0, pageSize).map(({ source_id }) => {
          const raw = readMainActivity(db, cipher, kind, source_id, scope);
          if (raw === null) throw new Error("main activity access changed");
          const row = JSON.parse(raw) as Record<string, unknown>;
          const status = typeof row.status === "string" && /^[a-z][a-z0-9_]{0,63}$/i.test(row.status) ? row.status : null;
          const createdAt = typeof row.createdAt === "string" && row.createdAt.length <= 40 && Number.isFinite(Date.parse(row.createdAt)) ? row.createdAt : null;
          const amountCents = Number.isSafeInteger(row.amountCents) && Number(row.amountCents) >= 0 ? Number(row.amountCents) : null;
          return { id: source_id, status, createdAt, ...(kind === "settlements" ? { amountCents } : { orderId: row.orderId }) };
        });
        return { records, hasNext: selected.length > pageSize };
      });
      return context.json({ ok: true, data: { merchantId: access.merchantId, kind, ...result, page, pageSize, scope: "main_site_only", reconciled: false } });
    } catch (error) {
      if (error instanceof MerchantAccessError) {
        if (error.code === "unauthenticated") return context.json({ ok: false, error: "unauthenticated" }, 401);
        if (error.code === "forbidden" || error.code === "invalid_binding") return context.json({ ok: false, error: "merchant_not_found" }, 404);
      }
      return context.json({ ok: false, error: "service_unavailable" }, 503);
    }
  });
  app.get("/main-refunds", async (context) => {
    context.header("Cache-Control", "no-store");
    const query = new URL(context.req.url).searchParams;
    const ids = query.getAll("merchantId"), pages = query.getAll("page"), sizes = query.getAll("pageSize");
    if (ids.length !== 1 || pages.length > 1 || sizes.length > 1 || [...query.keys()].some((key) => !["merchantId", "page", "pageSize"].includes(key))) return context.json({ ok: false, error: "invalid_query" }, 400);
    const pageText = pages[0] ?? "1", sizeText = sizes[0] ?? "20";
    if (!/^[1-9]\d{0,4}$/.test(pageText) || !/^[1-9]\d{0,2}$/.test(sizeText) || Number(sizeText) > 100) return context.json({ ok: false, error: "invalid_query" }, 400);
    const page = Number(pageText), pageSize = Number(sizeText);
    try {
      const access = await authorizeMerchant({ origin: options.identityOrigin, cookie: context.req.header("cookie") ?? "", merchantId: ids[0]!, database: options.database, ...(options.identityFetch ? { fetch: options.identityFetch } : {}) });
      const cipher = new RuntimeSecretCipher(options.masterKey, options.database.instanceId());
      const result = options.database.read((db) => {
        const synced = readSynchronizedActivity(db, cipher, access, { page, pageSize }, "refunds");
        if (synced) return synced;
        verifyHistoricalImport(db, cipher, "refund");
        const selected = db.prepare(`SELECT r.refund_id FROM epay_main_refund_sources r
          JOIN epay_merchant_bindings b ON b.epay_merchant_id=r.merchant_id
          JOIN epay_merchant_accounts m ON m.merchant_id=r.merchant_id AND m.enabled=1
          WHERE b.main_merchant_id=? AND b.main_api_id=? AND r.merchant_id=?
          ORDER BY r.refund_id LIMIT ? OFFSET ?`).all(access.merchantId, access.mainApiId, access.epayMerchantId, pageSize + 1, (page - 1) * pageSize) as Array<{ refund_id: string }>;
        const scope = { mainMerchantId: access.merchantId, mainApiId: access.mainApiId, epayMerchantId: access.epayMerchantId };
        const refunds = selected.slice(0, pageSize).map(({ refund_id }) => {
          const raw = readEncryptedMainRefund(db, cipher, refund_id, scope);
          if (raw === null) throw new Error("main refund access changed");
          const refund = JSON.parse(raw) as { id: string; orderId?: string | null; amountCents: number; status: string };
          return { id: refund.id, orderId: refund.orderId ?? null, amountCents: refund.amountCents, status: refund.status };
        });
        return { refunds, hasNext: selected.length > pageSize };
      });
      return context.json({ ok: true, data: { merchantId: access.merchantId, ...result, page, pageSize, scope: "main_site_only", reconciled: false } });
    } catch (error) {
      if (error instanceof MerchantAccessError) {
        if (error.code === "unauthenticated") return context.json({ ok: false, error: "unauthenticated" }, 401);
        if (error.code === "forbidden" || error.code === "invalid_binding") return context.json({ ok: false, error: "merchant_not_found" }, 404);
      }
      return context.json({ ok: false, error: "service_unavailable" }, 503);
    }
  });
  app.get("/main-orders", async (context) => {
    context.header("Cache-Control", "no-store");
    const query = new URL(context.req.url).searchParams;
    const ids = query.getAll("merchantId"), pages = query.getAll("page"), sizes = query.getAll("pageSize"), searches = query.getAll("search"), statuses = query.getAll("status");
    if (ids.length !== 1 || pages.length > 1 || sizes.length > 1 || searches.length > 1 || statuses.length > 1 || [...query.keys()].some((key) => !["merchantId", "page", "pageSize", "search", "status"].includes(key))) return context.json({ ok: false, error: "invalid_query" }, 400);
    const pageText = pages[0] ?? "1", sizeText = sizes[0] ?? "20", search = (searches[0] ?? "").trim(), status = statuses[0] ?? "";
    if (!/^[1-9]\d{0,4}$/.test(pageText) || !/^[1-9]\d{0,2}$/.test(sizeText) || Number(sizeText) > 100 || search.length > 128 || /[\x00-\x1f\x7f]/.test(search) || (status !== "" && !/^[a-z][a-z0-9_]{0,63}$/.test(status))) return context.json({ ok: false, error: "invalid_query" }, 400);
    const page = Number(pageText), pageSize = Number(sizeText), pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
    try {
      const access = await authorizeMerchant({ origin: options.identityOrigin, cookie: context.req.header("cookie") ?? "", merchantId: ids[0]!, database: options.database, ...(options.identityFetch ? { fetch: options.identityFetch } : {}) });
      const cipher = new RuntimeSecretCipher(options.masterKey, options.database.instanceId());
      const rows = options.database.read((db) => {
        const synced = readSynchronizedOrders(db, cipher, access, { page, pageSize, search, status });
        if (synced) return synced;
        verifyHistoricalImport(db, cipher, "order");
        const selected = db.prepare(`SELECT o.order_id FROM epay_main_order_sources o
          JOIN epay_merchant_bindings b ON b.epay_merchant_id=o.merchant_id
          JOIN epay_merchant_accounts m ON m.merchant_id=o.merchant_id AND m.enabled=1
          WHERE b.main_merchant_id=? AND b.main_api_id=? AND o.merchant_id=?
          AND (?='' OR o.status=?)
          AND (?='' OR o.order_id LIKE ? ESCAPE '\\' OR o.merchant_order_id LIKE ? ESCAPE '\\')
          ORDER BY o.created_at DESC,o.order_id DESC LIMIT ? OFFSET ?`)
          .all(access.merchantId, access.mainApiId, access.epayMerchantId, status, status, search, pattern, pattern, pageSize + 1, (page - 1) * pageSize) as Array<{ order_id: string }>;
        const scope = { mainMerchantId: access.merchantId, mainApiId: access.mainApiId, epayMerchantId: access.epayMerchantId };
        const orders = selected.slice(0, pageSize).map(({ order_id }) => {
          const raw = readEncryptedMainOrder(db, cipher, order_id, scope);
          if (raw === null) throw new Error("main order access changed");
          const order = JSON.parse(raw) as { id: string; merchantOrderId: string; amountCents: number; status: string; createdAt: string };
          return { id: order.id, merchantOrderId: order.merchantOrderId, amountCents: order.amountCents, status: order.status, createdAt: order.createdAt, source: "main_site" };
        });
        return { orders, hasNext: selected.length > pageSize };
      });
      return context.json({ ok: true, data: { merchantId: access.merchantId, orders: rows.orders, page, pageSize, hasNext: rows.hasNext, scope: "main_site_only", reconciled: false } });
    } catch (error) {
      if (error instanceof MerchantAccessError) {
        if (error.code === "unauthenticated") return context.json({ ok: false, error: "unauthenticated" }, 401);
        if (error.code === "forbidden" || error.code === "invalid_binding") return context.json({ ok: false, error: "merchant_not_found" }, 404);
      }
      return context.json({ ok: false, error: "service_unavailable" }, 503);
    }
  });
  return app;
}
