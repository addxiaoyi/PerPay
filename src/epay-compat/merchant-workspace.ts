import { orderReadSource } from "./order-read-source.ts";
import { Hono } from "hono";
import type { AppDatabase } from "../database/database.ts";
import { authorizeMerchant, MerchantAccessError } from "./merchant-access.ts";
import { createMerchantLedgerAudit } from "./merchant-ledger-audit.ts";

type Database = Pick<AppDatabase, "read">;
type OrderRow = {
  trade_no: string; out_trade_no: string; name: string; money_cents: bigint | number;
  status: string; notify_status: string; created_at: bigint | number; paid_at: bigint | number | null;
};
type InvoiceRow = { id: string; trade_no: string; title: string; amount_cents: bigint | number; status: string; created_at: bigint | number; updated_at: bigint | number };

function callbackFailureReason(code: string | null): string | null {
  if (code === null) return null;
  switch (code) {
    case "invalid_acknowledgement": return "商户接口未确认收到通知";
    case "transport_timeout": return "商户接口响应超时";
    case "transport_network":
    case "dns_failed":
    case "dns_no_addresses": return "无法连接商户接口";
    case "tls_verification_failed": return "商户接口证书验证失败";
    case "transport_cancelled": return "通知被中断，稍后将按策略处理";
    case "webhook_target_invalid":
    case "target_address_forbidden":
    case "target_address_limit": return "商户通知地址不符合安全要求";
    default: return "通知处理失败，请联系管理员";
  }
}

function safeInteger(value: bigint | number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("invalid stored order value");
  return result;
}

function signedInteger(value: bigint | number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error("invalid stored ledger value");
  return result;
}

export function createMerchantWorkspace(options: { database: Database; identityOrigin: string; identityFetch?: typeof fetch }) {
  const app = new Hono();
  app.use("*", async (context, next) => { context.header("Cache-Control", "no-store"); await next(); });
  app.route("/", createMerchantLedgerAudit(options));
  app.get("/orders", async (context) => {
    const query = new URL(context.req.url).searchParams;
    const merchantIds = query.getAll("merchantId");
    const pages = query.getAll("page");
    const sizes = query.getAll("pageSize");
    const statuses = query.getAll("status");
    const searches = query.getAll("search");
    const formats = query.getAll("format");
    if (merchantIds.length !== 1 || pages.length > 1 || sizes.length > 1 || statuses.length > 1 || searches.length > 1 || formats.length > 1 || (formats.length === 1 && formats[0] !== "legacy") || [...query.keys()].some((key) => !["merchantId", "page", "pageSize", "status", "search", "format"].includes(key))) return context.json({ ok: false, error: "invalid_query" }, 400);
    const pageText = pages[0] ?? "1";
    const sizeText = sizes[0] ?? "20";
    if (!/^[1-9]\d{0,4}$/.test(pageText) || !/^[1-9]\d{0,2}$/.test(sizeText)) return context.json({ ok: false, error: "invalid_query" }, 400);
    const page = Number(pageText), pageSize = Number(sizeText);
    if (pageSize > 100) return context.json({ ok: false, error: "invalid_query" }, 400);
    const status = statuses[0] ?? "";
    const search = (searches[0] ?? "").trim();
    if ((status && !["PENDING", "PAID", "PARTIAL_REFUND", "REFUND_PROCESSING", "REFUNDED", "FROZEN", "CLOSED"].includes(status)) || search.length > 150 || /[\x00-\x1f\x7f]/.test(search)) return context.json({ ok: false, error: "invalid_query" }, 400);
    try {
      const access = await authorizeMerchant({ origin: options.identityOrigin, cookie: context.req.header("cookie") ?? "", merchantId: merchantIds[0]!, database: options.database, ...(options.identityFetch ? { fetch: options.identityFetch } : {}) });
      const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
      const result = options.database.read((db) => {
        const scope = `
        FROM ${orderReadSource(db)} o JOIN epay_merchant_bindings b ON b.epay_merchant_id = o.merchant_id
        JOIN epay_merchant_accounts m ON m.merchant_id = b.epay_merchant_id AND m.enabled = 1
        WHERE b.main_merchant_id = ? AND b.epay_merchant_id = ? AND b.main_api_id = ? AND (? = '' OR o.status = ?)
        AND (? = '' OR o.trade_no LIKE ? ESCAPE '\\' OR o.out_trade_no LIKE ? ESCAPE '\\' OR o.name LIKE ? ESCAPE '\\')`;
        const values = [access.merchantId, access.epayMerchantId, access.mainApiId, status, status, search, pattern, pattern, pattern] as const;
        const count = db.prepare(`SELECT count(*) AS total ${scope}`).get(...values) as { total: bigint | number };
        const rows = db.prepare(`SELECT o.trade_no, o.out_trade_no, o.name, o.money_cents, o.status, o.notify_status, o.created_at, o.paid_at ${scope}
          ORDER BY o.created_at DESC, o.trade_no DESC LIMIT ? OFFSET ?`).all(...values, pageSize + 1, (page - 1) * pageSize) as OrderRow[];
        return { total: safeInteger(count.total), rows };
      });
      const { rows, total } = result;
      const hasNext = rows.length > pageSize;
      const orders = rows.slice(0, pageSize).map((row) => ({ tradeNo: row.trade_no, merchantOrderNo: row.out_trade_no, name: row.name, amountCents: safeInteger(row.money_cents), status: row.status, notifyStatus: row.notify_status, createdAt: safeInteger(row.created_at), paidAt: row.paid_at === null ? null : safeInteger(row.paid_at) }));
      if (formats[0] === "legacy") {
        const statusLabels: Record<string, string> = { PENDING: "pending_payment", PAID: "paid", REFUNDED: "refunded", FROZEN: "frozen", CLOSED: "closed" };
        const projected = orders.map((order) => ({
          id: `epay_${order.tradeNo}`, merchantOrderId: order.merchantOrderNo, name: order.name,
          amount: `${Math.floor(order.amountCents / 100)}.${String(order.amountCents % 100).padStart(2, "0")}`,
          status: statusLabels[order.status] ?? "unknown", createdAt: new Date(order.createdAt).toISOString(),
          paidAt: order.paidAt === null ? null : new Date(order.paidAt).toISOString(), source: "epay", canInvoice: false,
        }));
        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        return context.json({ ok: true, data: { merchantId: access.merchantId, orders: projected, pageInfo: { page, pageSize, total, totalPages, hasNext, hasPrevious: page > 1 }, scope: "epay_only", invoiceAvailable: false } });
      }
      return context.json({ ok: true, data: { merchantId: access.merchantId, role: access.role, orders, page, pageSize, total, hasNext } });
    } catch (error) {
      if (error instanceof MerchantAccessError) {
        if (error.code === "unauthenticated") return context.json({ ok: false, error: "unauthenticated" }, 401);
        if (error.code === "forbidden" || error.code === "invalid_binding") return context.json({ ok: false, error: "merchant_not_found" }, 404);
      }
      return context.json({ ok: false, error: "service_unavailable" }, 503);
    }
  });
  app.get("/ledger-entries", async (context) => {
    const query = new URL(context.req.url).searchParams;
    const merchantIds = query.getAll("merchantId"), pages = query.getAll("page"), sizes = query.getAll("pageSize");
    if (merchantIds.length !== 1 || pages.length > 1 || sizes.length > 1 || [...query.keys()].some((key) => !["merchantId", "page", "pageSize"].includes(key))) return context.json({ ok: false, error: "invalid_query" }, 400);
    const pageText = pages[0] ?? "1", sizeText = sizes[0] ?? "20";
    if (!/^[1-9]\d{0,4}$/.test(pageText) || !/^[1-9]\d{0,2}$/.test(sizeText) || Number(sizeText) > 100) return context.json({ ok: false, error: "invalid_query" }, 400);
    const page = Number(pageText), pageSize = Number(sizeText);
    try {
      const access = await authorizeMerchant({ origin: options.identityOrigin, cookie: context.req.header("cookie") ?? "", merchantId: merchantIds[0]!, database: options.database, ...(options.identityFetch ? { fetch: options.identityFetch } : {}) });
      const rows = options.database.read((db) => db.prepare(`SELECT l.entry_id,l.entry_type,l.available_delta_cents,l.frozen_delta_cents,l.occurred_at,l.source
        FROM epay_balance_ledger l JOIN epay_merchant_bindings b ON b.epay_merchant_id=l.merchant_id
        JOIN epay_merchant_accounts m ON m.merchant_id=b.epay_merchant_id AND m.enabled=1
        WHERE b.main_merchant_id=? AND b.epay_merchant_id=? AND b.main_api_id=? ORDER BY l.occurred_at DESC,l.entry_id DESC LIMIT ? OFFSET ?`)
        .all(access.merchantId, access.epayMerchantId, access.mainApiId, pageSize + 1, (page - 1) * pageSize) as Array<{ entry_id: string; entry_type: string; available_delta_cents: bigint | number; frozen_delta_cents: bigint | number; occurred_at: bigint | number; source: string }>);
      const entries = rows.slice(0, pageSize).map((row) => ({ id: row.entry_id, type: row.entry_type, availableDeltaCents: signedInteger(row.available_delta_cents), frozenDeltaCents: signedInteger(row.frozen_delta_cents), occurredAt: safeInteger(row.occurred_at), source: row.source }));
      return context.json({ ok: true, data: { merchantId: access.merchantId, entries, page, pageSize, hasNext: rows.length > pageSize, reconciled: false } });
    } catch (error) {
      if (error instanceof MerchantAccessError) {
        if (error.code === "unauthenticated") return context.json({ ok: false, error: "unauthenticated" }, 401);
        if (error.code === "forbidden" || error.code === "invalid_binding") return context.json({ ok: false, error: "merchant_not_found" }, 404);
      }
      return context.json({ ok: false, error: "service_unavailable" }, 503);
    }
  });
  app.get("/invoices", async (context) => {
    const query = new URL(context.req.url).searchParams;
    const merchantIds = query.getAll("merchantId"), pages = query.getAll("page"), sizes = query.getAll("pageSize"), invoicePages = query.getAll("invoicePage"), applicationPages = query.getAll("applicationPage");
    if (merchantIds.length !== 1 || pages.length > 1 || sizes.length > 1 || invoicePages.length > 1 || applicationPages.length > 1 || [...query.keys()].some((key) => !["merchantId", "page", "pageSize", "invoicePage", "applicationPage"].includes(key))) return context.json({ ok: false, error: "invalid_query" }, 400);
    const pageText = pages[0] ?? "1", sizeText = sizes[0] ?? "20";
    const invoicePageText = invoicePages[0] ?? pageText, applicationPageText = applicationPages[0] ?? pageText;
    if (![pageText, invoicePageText, applicationPageText].every((value) => /^[1-9]\d{0,4}$/.test(value)) || !/^[1-9]\d{0,2}$/.test(sizeText) || Number(sizeText) > 100) return context.json({ ok: false, error: "invalid_query" }, 400);
    const page = Number(pageText), pageSize = Number(sizeText), invoicePage = Number(invoicePageText), applicationPage = Number(applicationPageText);
    try {
      const access = await authorizeMerchant({ origin: options.identityOrigin, cookie: context.req.header("cookie") ?? "", merchantId: merchantIds[0]!, database: options.database, ...(options.identityFetch ? { fetch: options.identityFetch } : {}) });
      const rows = options.database.read((db) => {
        const invalid = db.prepare(`SELECT EXISTS(
          SELECT 1 FROM epay_invoices i LEFT JOIN epay_orders o ON o.trade_no=i.trade_no AND o.merchant_id=i.merchant_id
          WHERE i.merchant_id=? AND o.trade_no IS NULL
          UNION ALL
          SELECT 1 FROM epay_invoice_applications i LEFT JOIN epay_orders o ON o.trade_no=i.trade_no AND o.merchant_id=i.merchant_id AND o.out_trade_no=i.out_trade_no
          WHERE i.merchant_id=? AND o.trade_no IS NULL
        ) AS invalid`).get(access.epayMerchantId, access.epayMerchantId) as { invalid: number | bigint };
        if (Number(invalid.invalid) !== 0) throw new Error("invoice order ownership mismatch");
        const scope = `JOIN epay_merchant_bindings b ON b.epay_merchant_id = i.merchant_id
          JOIN epay_merchant_accounts m ON m.merchant_id = b.epay_merchant_id AND m.enabled = 1
          WHERE b.main_merchant_id = ? AND b.epay_merchant_id = ? AND b.main_api_id = ?`;
        const values = [access.merchantId, access.epayMerchantId, access.mainApiId] as const;
        const invoices = db.prepare(`SELECT i.invoice_id AS id, i.trade_no, i.title, i.amount_cents, i.status, i.created_at, i.updated_at FROM epay_invoices i ${scope} ORDER BY i.created_at DESC, i.invoice_id DESC LIMIT ? OFFSET ?`).all(...values, pageSize + 1, (invoicePage - 1) * pageSize) as InvoiceRow[];
        const applications = db.prepare(`SELECT i.application_id AS id, i.trade_no, i.title, i.fee_cents AS amount_cents, i.status, i.created_at, i.updated_at FROM epay_invoice_applications i ${scope} ORDER BY i.created_at DESC, i.application_id DESC LIMIT ? OFFSET ?`).all(...values, pageSize + 1, (applicationPage - 1) * pageSize) as InvoiceRow[];
        return { invoices, applications };
      });
      const mapRows = (records: InvoiceRow[]) => records.slice(0, pageSize).map((row) => ({ id: row.id, tradeNo: row.trade_no, title: row.title, cents: safeInteger(row.amount_cents), status: row.status, createdAt: safeInteger(row.created_at), updatedAt: safeInteger(row.updated_at) }));
      const invoices = mapRows(rows.invoices).map(({ cents, ...row }) => ({ ...row, amountCents: cents }));
      const applications = mapRows(rows.applications).map(({ cents, ...row }) => ({ ...row, feeCents: cents }));
      return context.json({ ok: true, data: { merchantId: access.merchantId, role: access.role, invoices, applications, page, pageSize, invoicePage, applicationPage, invoicesHaveNext: rows.invoices.length > pageSize, applicationsHaveNext: rows.applications.length > pageSize } });
    } catch (error) {
      if (error instanceof MerchantAccessError) {
        if (error.code === "unauthenticated") return context.json({ ok: false, error: "unauthenticated" }, 401);
        if (error.code === "forbidden" || error.code === "invalid_binding") return context.json({ ok: false, error: "merchant_not_found" }, 404);
      }
      return context.json({ ok: false, error: "service_unavailable" }, 503);
    }
  });
  app.get("/notifications", async (context) => {
    const query = new URL(context.req.url).searchParams;
    const merchantIds = query.getAll("merchantId"), tradeNos = query.getAll("tradeNo"), pages = query.getAll("page"), sizes = query.getAll("pageSize");
    if (merchantIds.length !== 1 || tradeNos.length !== 1 || pages.length > 1 || sizes.length > 1 || [...query.keys()].some((key) => !["merchantId", "tradeNo", "page", "pageSize"].includes(key))) return context.json({ ok: false, error: "invalid_query" }, 400);
    const tradeNo = tradeNos[0]!, pageText = pages[0] ?? "1", sizeText = sizes[0] ?? "20";
    if (!tradeNo || tradeNo.length > 64 || /[\x00-\x1f\x7f]/.test(tradeNo) || !/^[1-9]\d{0,4}$/.test(pageText) || !/^[1-9]\d{0,2}$/.test(sizeText) || Number(sizeText) > 100) return context.json({ ok: false, error: "invalid_query" }, 400);
    const page = Number(pageText), pageSize = Number(sizeText);
    try {
      const access = await authorizeMerchant({ origin: options.identityOrigin, cookie: context.req.header("cookie") ?? "", merchantId: merchantIds[0]!, database: options.database, ...(options.identityFetch ? { fetch: options.identityFetch } : {}) });
      const rows = options.database.read((db) => {
        const order = db.prepare(`SELECT o.trade_no FROM ${orderReadSource(db)} o JOIN epay_merchant_bindings b ON b.epay_merchant_id=o.merchant_id
          JOIN epay_merchant_accounts m ON m.merchant_id=b.epay_merchant_id AND m.enabled=1
          WHERE b.main_merchant_id=? AND b.epay_merchant_id=? AND b.main_api_id=? AND o.trade_no=?`).get(access.merchantId, access.epayMerchantId, access.mainApiId, tradeNo);
        if (!order) return null;
        return db.prepare(`SELECT n.notify_id, n.status, n.response_code, n.created_at FROM epay_notify_logs n
          JOIN epay_orders o ON o.trade_no=n.trade_no JOIN epay_merchant_bindings b ON b.epay_merchant_id=o.merchant_id
          JOIN epay_merchant_accounts m ON m.merchant_id=b.epay_merchant_id AND m.enabled=1
          WHERE b.main_merchant_id=? AND b.epay_merchant_id=? AND b.main_api_id=? AND o.trade_no=?
          ORDER BY n.created_at DESC, n.notify_id DESC LIMIT ? OFFSET ?`).all(access.merchantId, access.epayMerchantId, access.mainApiId, tradeNo, pageSize + 1, (page - 1) * pageSize) as Array<{ notify_id: bigint | number; status: string; response_code: bigint | number | null; created_at: bigint | number }>;
      });
      if (!rows) return context.json({ ok: false, error: "order_not_found" }, 404);
      const notifications = rows.slice(0, pageSize).map((row) => ({ id: safeInteger(row.notify_id), status: row.status, httpStatus: row.response_code === null ? null : safeInteger(row.response_code), createdAt: safeInteger(row.created_at) }));
      return context.json({ ok: true, data: { tradeNo, notifications, page, pageSize, hasNext: rows.length > pageSize } });
    } catch (error) {
      if (error instanceof MerchantAccessError) {
        if (error.code === "unauthenticated") return context.json({ ok: false, error: "unauthenticated" }, 401);
        if (error.code === "forbidden" || error.code === "invalid_binding") return context.json({ ok: false, error: "merchant_not_found" }, 404);
      }
      return context.json({ ok: false, error: "service_unavailable" }, 503);
    }
  });
  app.get("/callback-attempts", async (context) => {
    const query = new URL(context.req.url).searchParams;
    const merchantIds = query.getAll("merchantId"), tradeNos = query.getAll("tradeNo"), pages = query.getAll("page"), sizes = query.getAll("pageSize");
    if (merchantIds.length !== 1 || tradeNos.length !== 1 || pages.length > 1 || sizes.length > 1 || [...query.keys()].some((key) => !["merchantId", "tradeNo", "page", "pageSize"].includes(key))) return context.json({ ok: false, error: "invalid_query" }, 400);
    const tradeNo = tradeNos[0]!, pageText = pages[0] ?? "1", sizeText = sizes[0] ?? "20";
    if (!tradeNo || tradeNo.length > 64 || /[\x00-\x1f\x7f]/.test(tradeNo) || !/^[1-9]\d{0,4}$/.test(pageText) || !/^[1-9]\d{0,2}$/.test(sizeText) || Number(sizeText) > 100) return context.json({ ok: false, error: "invalid_query" }, 400);
    const page = Number(pageText), pageSize = Number(sizeText);
    try {
      const access = await authorizeMerchant({ origin: options.identityOrigin, cookie: context.req.header("cookie") ?? "", merchantId: merchantIds[0]!, database: options.database, ...(options.identityFetch ? { fetch: options.identityFetch } : {}) });
      const result = options.database.read((db) => {
        const order = db.prepare(`SELECT o.trade_no FROM ${orderReadSource(db)} o JOIN epay_merchant_bindings b ON b.epay_merchant_id=o.merchant_id
          JOIN epay_merchant_accounts m ON m.merchant_id=b.epay_merchant_id AND m.enabled=1
          WHERE b.main_merchant_id=? AND b.epay_merchant_id=? AND b.main_api_id=? AND o.trade_no=?`).get(access.merchantId, access.epayMerchantId, access.mainApiId, tradeNo);
        if (!order) return null;
        const job = db.prepare(`SELECT j.merchant_id,j.status,j.attempts,j.updated_at FROM epay_callback_jobs j
          JOIN epay_orders o ON o.trade_no=j.trade_no
          JOIN epay_merchant_bindings b ON b.epay_merchant_id=o.merchant_id
          JOIN epay_merchant_accounts m ON m.merchant_id=b.epay_merchant_id AND m.enabled=1
          WHERE b.main_merchant_id=? AND b.epay_merchant_id=? AND b.main_api_id=? AND j.trade_no=?`)
          .get(access.merchantId, access.epayMerchantId, access.mainApiId, tradeNo) as { merchant_id: bigint | number; status: string; attempts: bigint | number; updated_at: bigint | number } | undefined;
        if (!job) return { job: null, attempts: [] };
        if (safeInteger(job.merchant_id) !== access.epayMerchantId) throw new Error("callback job merchant mismatch");
        const attempts = db.prepare(`SELECT a.attempt_id,a.attempt_number,CASE WHEN a.wire_format='main_json' THEN 'POST' ELSE a.method END AS method,a.wire_format,a.outcome,a.http_status,a.started_at,a.finished_at,a.error_code
          FROM epay_callback_attempts a JOIN epay_callback_jobs j ON j.trade_no=a.trade_no
          JOIN epay_orders o ON o.trade_no=j.trade_no AND o.merchant_id=j.merchant_id
          JOIN epay_merchant_bindings b ON b.epay_merchant_id=o.merchant_id
          JOIN epay_merchant_accounts m ON m.merchant_id=b.epay_merchant_id AND m.enabled=1
          WHERE b.main_merchant_id=? AND b.epay_merchant_id=? AND b.main_api_id=? AND j.trade_no=?
          ORDER BY a.attempt_number DESC LIMIT ? OFFSET ?`).all(access.merchantId, access.epayMerchantId, access.mainApiId, tradeNo, pageSize + 1, (page - 1) * pageSize) as Array<{ attempt_id: string; attempt_number: bigint | number; method: string; outcome: string; http_status: bigint | number | null; started_at: bigint | number; finished_at: bigint | number | null; error_code: string | null }>;
        return { job, attempts };
      });
      if (!result) return context.json({ ok: false, error: "order_not_found" }, 404);
      const job = result.job ? { status: result.job.status, attempts: safeInteger(result.job.attempts), updatedAt: safeInteger(result.job.updated_at) } : null;
      const attempts = result.attempts.slice(0, pageSize).map((row) => ({ id: row.attempt_id, number: safeInteger(row.attempt_number), method: row.method, outcome: row.outcome, httpStatus: row.http_status === null ? null : safeInteger(row.http_status), startedAt: safeInteger(row.started_at), finishedAt: row.finished_at === null ? null : safeInteger(row.finished_at), failureReason: callbackFailureReason(row.error_code) }));
      return context.json({ ok: true, data: { tradeNo, job, attempts, page, pageSize, hasNext: result.attempts.length > pageSize } });
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
