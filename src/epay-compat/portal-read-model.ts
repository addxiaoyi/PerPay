import type { DatabaseSync } from "node:sqlite";
import type { RuntimeSecretCipher } from "../settings/crypto.ts";
import { readCurrentMainPayment } from "./main-delta-store.ts";
import { readLiveBalance } from "./live-balance.ts";
import { orderReadSource } from "./order-read-source.ts";

type Row = Record<string, unknown>;
export type PortalScope = { epayMerchantId: number; merchantId: string; mainApiId: string; all: boolean };
export type PortalRecord = { id: string; merchantId: string | null; merchantName: string; epayMerchantId: number; source: string; status: string; createdAt: number; amountCents: number | null; name: string; orderId?: string; merchantOrderId?: string; attempts?: number; frozenDeltaCents?: number };
export function portalInteger(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("portal stored integer is invalid");
  return number;
}
const count = (sql: DatabaseSync, query: string, ids: readonly number[]) => portalInteger(sql.prepare(query).get(...ids)?.n);
const sum = (values: readonly number[]) => portalInteger(values.reduce((total, value) => total + BigInt(value), 0n));

export function portalMerchants(sql: DatabaseSync, scope: PortalScope) {
  return sql.prepare(`SELECT m.merchant_id,m.name,m.enabled,m.fee_rate_bps,b.main_merchant_id FROM epay_merchant_accounts m
    LEFT JOIN epay_merchant_bindings b ON b.epay_merchant_id=m.merchant_id WHERE ?=1 OR m.merchant_id=? ORDER BY m.merchant_id`)
    .all(scope.all ? 1 : 0, scope.epayMerchantId).map(row => {
      const merchantId = portalInteger(row.merchant_id);
      const opening = sql.prepare("SELECT 1 FROM epay_balance_openings WHERE merchant_id=?").get(merchantId);
      const balance = opening ? readLiveBalance(sql, merchantId) : null;
      return { epayMerchantId: merchantId, merchantId: row.main_merchant_id === null ? null : String(row.main_merchant_id), name: String(row.name), enabled: Number(row.enabled) === 1,
        feeBps: portalInteger(row.fee_rate_bps), availableCents: balance?.availableCents ?? null, frozenCents: balance?.frozenCents ?? null, reconciled: Boolean(balance) };
    });
}

export function portalRecords(sql: DatabaseSync, cipher: RuntimeSecretCipher, scope: PortalScope, kind: "orders" | "notifications" | "ledger" | "refunds" | "settlements") {
  const merchants = portalMerchants(sql, scope), byId = new Map(merchants.map(merchant => [merchant.epayMerchantId, merchant]));
  const byMain = new Map(merchants.filter(merchant => merchant.merchantId).map(merchant => [merchant.merchantId, merchant]));
  const merchantFields = (id: unknown) => {
    const merchant = byId.get(portalInteger(id));
    if (!merchant) throw new Error("portal record is outside authorized scope");
    return { merchantId: merchant.merchantId, merchantName: merchant.name, epayMerchantId: merchant.epayMerchantId };
  };
  let rows: PortalRecord[];
  const where = " WHERE (?=1 OR merchant_id=?)", args = [scope.all ? 1 : 0, scope.epayMerchantId];
  if (kind === "orders") {
    rows = sql.prepare(`SELECT trade_no,out_trade_no,merchant_id,name,money_cents,status,created_at FROM ${orderReadSource(sql)}${where}`).all(...args).map(row => ({
      ...merchantFields(row.merchant_id), id: String(row.trade_no), orderId: String(row.trade_no), merchantOrderId: String(row.out_trade_no), name: String(row.name),
      amountCents: portalInteger(row.money_cents), status: String(row.status).toLowerCase(), createdAt: portalInteger(row.created_at), source: "epay" }));
  } else if (kind === "notifications") {
    rows = sql.prepare(`SELECT trade_no,merchant_id,status,attempts,updated_at FROM epay_callback_jobs${where}`).all(...args).map(row => ({
      ...merchantFields(row.merchant_id), id: String(row.trade_no), orderId: String(row.trade_no), name: "收款结果通知", amountCents: null,
      status: String(row.status).toLowerCase(), attempts: portalInteger(row.attempts), createdAt: portalInteger(row.updated_at), source: "native" }));
    const history = sql.prepare(`SELECT n.notify_id id,n.trade_no,o.merchant_id,n.status,n.created_at FROM epay_notify_logs n JOIN epay_orders o ON o.trade_no=n.trade_no
      WHERE ?=1 OR o.merchant_id=?`).all(...args);
    rows.push(...history.map(row => ({ ...merchantFields(row.merchant_id), id: String(row.id), orderId: String(row.trade_no), name: "历史收款通知", amountCents: null,
      status: String(row.status).toLowerCase(), createdAt: portalInteger(row.created_at), source: "legacy" })));
  } else if (kind === "ledger") {
    rows = sql.prepare(`SELECT entry_id,merchant_id,entry_type,available_delta_cents,frozen_delta_cents,occurred_at,source FROM epay_balance_ledger${where}`).all(...args).map(row => ({
      ...merchantFields(row.merchant_id), id: String(row.entry_id), name: String(row.entry_type), amountCents: portalInteger(row.available_delta_cents), frozenDeltaCents: portalInteger(row.frozen_delta_cents),
      status: "posted", createdAt: portalInteger(row.occurred_at), source: String(row.source) }));
  } else {
    const table = kind === "refunds" ? "epay_native_refunds" : "epay_native_settlements", id = kind === "refunds" ? "refund_no" : "settlement_id";
    rows = sql.prepare(`SELECT ${id} id,merchant_id,amount_cents,status,created_at,${kind === "refunds" ? "reason,trade_no" : "note"} FROM ${table}${where}`).all(...args).map(row => ({
      ...merchantFields(row.merchant_id), id: String(row.id), name: String(row.reason ?? row.note ?? ""), amountCents: portalInteger(row.amount_cents),
      status: String(row.status).toLowerCase(), createdAt: portalInteger(row.created_at), source: "native", ...(row.trade_no ? { orderId: String(row.trade_no) } : {}) }));
  }
  if (kind !== "ledger") {
    const payment = readCurrentMainPayment(sql, cipher).payment;
    const history = payment[kind === "notifications" ? "callbacks" : kind];
    if (!Array.isArray(history)) throw new Error("portal historical collection is unavailable");
    for (const row of history as Row[]) {
      const merchant = byMain.get(String(row.merchantId));
      if (!merchant) continue;
      const createdAt = typeof row.createdAt === "string" ? Date.parse(row.createdAt) : 0;
      rows.push({ ...merchantFields(merchant.epayMerchantId), id: String(row.id), name: String(row.subject ?? row.name ?? row.reason ?? row.note ?? ""),
        amountCents: row.amountCents === undefined ? null : portalInteger(row.amountCents), status: String(row.status ?? "unknown"), createdAt: portalInteger(createdAt), source: "main_site",
        ...(row.orderId ? { orderId: String(row.orderId) } : {}), ...(row.merchantOrderId ? { merchantOrderId: String(row.merchantOrderId) } : {}) });
    }
  }
  return rows.sort((a, b) => b.createdAt - a.createdAt || b.source.localeCompare(a.source) || b.id.localeCompare(a.id));
}

export function portalOverview(sql: DatabaseSync, scope: PortalScope, now: number, days: number) {
  const merchants = portalMerchants(sql, scope), ids = [scope.all ? 1 : 0, scope.epayMerchantId];
  const today = Math.floor((now + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000;
  const start = today - (days - 1) * 86400000;
  const trend = Array.from({ length: days }, (_, index) => ({ date: new Date(start + index * 86400000 + 8 * 3600000).toISOString().slice(0, 10), amountCents: 0, confirmed: 0, created: 0 }));
  const orders = sql.prepare("SELECT merchant_id,money_cents,status,paid_at,created_at FROM epay_orders WHERE (?=1 OR merchant_id=?)").all(...ids);
  let missingPaidAt = 0;
  for (const order of orders) {
    const created = Math.floor((portalInteger(order.created_at) - start) / 86400000);
    if (created >= 0 && created < days) trend[created]!.created++;
    if (!["PAID", "REFUNDED"].includes(String(order.status))) continue;
    if (order.paid_at === null) { missingPaidAt++; continue; }
    const paid = Math.floor((portalInteger(order.paid_at) - start) / 86400000);
    if (paid >= 0 && paid < days) { trend[paid]!.confirmed++; trend[paid]!.amountCents = sum([trend[paid]!.amountCents, portalInteger(order.money_cents)]); }
  }
  const pending = orders.filter(order => order.status === "PENDING").length;
  const callbacks = count(sql, "SELECT count(*) n FROM epay_callback_jobs WHERE (?=1 OR merchant_id=?) AND status IN ('PENDING','LEASED','FAILED')", ids);
  const refunds = count(sql, "SELECT count(*) n FROM epay_native_refunds WHERE (?=1 OR merchant_id=?) AND status IN ('REQUESTED','UNKNOWN')", ids);
  const settlements = count(sql, "SELECT count(*) n FROM epay_native_settlements WHERE (?=1 OR merchant_id=?) AND status='PENDING'", ids);
  return { observedAt: now, days, trend, today: trend[days - 1]!, periodCents: sum(trend.map(day => day.amountCents)), pending,
    tasks: { callbacks, refunds, settlements }, missingPaidAt, merchants,
    balances: { availableCents: sum(merchants.map(row => row.availableCents ?? 0)), frozenCents: sum(merchants.map(row => row.frozenCents ?? 0)) }, statisticsScope: "epay" as const };
}
