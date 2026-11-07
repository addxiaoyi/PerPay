import type { DatabaseSync } from "node:sqlite";
import type { RuntimeSecretCipher } from "../settings/crypto.ts";
import type { authorizeMerchant } from "./merchant-access.ts";
import { readCurrentMainPayment } from "./main-delta-store.ts";
import { verifyWechatMasterKeyGuard } from "./wechat-master-key.ts";
import { orderReadSource } from "./order-read-source.ts";

type Row = Record<string, unknown>;
type Access = Awaited<ReturnType<typeof authorizeMerchant>>;
type Query = { page: number; pageSize: number; search?: string; status?: string };
type OrderSummary = { id: string; merchantOrderId: string; amountCents: number; status: string; createdAt: string; source: "main_site" | "epay" };

function synchronizedSource(db: DatabaseSync, cipher: RuntimeSecretCipher, access: Access) {
  const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='epay_main_sync_runs'").get();
  if (!exists || !db.prepare("SELECT 1 FROM epay_main_sync_runs LIMIT 1").get()) return null;
  verifyWechatMasterKeyGuard(db, cipher);
  const binding = db.prepare(`SELECT 1 FROM epay_merchant_bindings b JOIN epay_merchant_accounts m ON m.merchant_id=b.epay_merchant_id
    WHERE b.main_merchant_id=? AND b.main_api_id=? AND b.epay_merchant_id=? AND m.enabled=1`).get(access.merchantId, access.mainApiId, access.epayMerchantId);
  // An access grant is rechecked inside the same database read as the records.
  if (!binding) return { orders: [], refunds: [], callbacks: [], settlements: [] } as Record<string, Row[]>;
  const source = readCurrentMainPayment(db, cipher).payment;
  if (!source.merchants.some(row => row.id === access.merchantId && row.apiId === access.mainApiId)) throw new Error("synchronized main merchant identity differs");
  return source;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 150 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("synchronized main record identity is invalid");
  return value;
}

function amount(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("synchronized main amount is invalid");
  return Number(value);
}

function status(value: unknown): string | null {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/i.test(value) ? value : null;
}

function createdAt(value: unknown): string | null {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null;
}

function collection(source: Record<string, unknown>, kind: string): Row[] {
  const rows = source[kind];
  if (!Array.isArray(rows)) throw new Error("synchronized main collection is missing");
  return rows as Row[];
}

function paginate<T>(rows: T[], query: Query) {
  const start = (query.page - 1) * query.pageSize;
  return { rows: rows.slice(start, start + query.pageSize), hasNext: rows.length > start + query.pageSize };
}

export function readSynchronizedOrders(db: DatabaseSync, cipher: RuntimeSecretCipher, access: Access, query: Query, combined = false) {
  const source = synchronizedSource(db, cipher, access);
  if (!source) return null;
  const orders: OrderSummary[] = collection(source, "orders").filter(row => row.merchantId === access.merchantId).map(row => {
    const state = status(row.status), created = createdAt(row.createdAt);
    if (!state || !created) throw new Error("synchronized main order state is invalid");
    return { id: identifier(row.id), merchantOrderId: identifier(row.merchantOrderId), amountCents: amount(row.amountCents), status: state, createdAt: created, source: "main_site" };
  });
  if (combined) {
    const rows = db.prepare(`SELECT o.trade_no,o.out_trade_no,o.money_cents,o.status,o.created_at FROM ${orderReadSource(db)} o
      JOIN epay_merchant_bindings b ON b.epay_merchant_id=o.merchant_id JOIN epay_merchant_accounts m ON m.merchant_id=o.merchant_id
      WHERE b.main_merchant_id=? AND b.main_api_id=? AND o.merchant_id=? AND m.enabled=1`).all(access.merchantId, access.mainApiId, access.epayMerchantId);
    for (const row of rows) orders.push({ id: identifier(row.trade_no), merchantOrderId: identifier(row.out_trade_no), amountCents: amount(Number(row.money_cents)), status: row.status === "PENDING" ? "pending_payment" : String(row.status).toLowerCase(), createdAt: new Date(Number(row.created_at)).toISOString(), source: "epay" });
  }
  const search = (query.search ?? "").toLowerCase();
  const selected = orders.filter(row => (!query.status || row.status === query.status) && (!search || row.id.toLowerCase().includes(search) || row.merchantOrderId.toLowerCase().includes(search)))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || compareDescending(a.source, b.source) || compareDescending(a.id, b.id));
  const page = paginate(selected, query);
  return { orders: page.rows, hasNext: page.hasNext };
}

function compareDescending(a: string, b: string): number { return a < b ? 1 : a > b ? -1 : 0; }

export function readSynchronizedActivity(db: DatabaseSync, cipher: RuntimeSecretCipher, access: Access, query: Query, kind: "refunds" | "callbacks" | "settlements") {
  const source = synchronizedSource(db, cipher, access);
  if (!source) return null;
  const selected = collection(source, kind).filter(row => row.merchantId === access.merchantId)
    .map((row): Row & { id: string } => ({ ...row, id: identifier(row.id) })).sort((a, b) => -compareDescending(a.id, b.id));
  const page = paginate(selected, query);
  const summaries = page.rows.map(row => {
    const id = identifier(row.id), state = status(row.status);
    if (kind === "refunds") return { id, orderId: row.orderId == null ? null : identifier(row.orderId), amountCents: amount(row.amountCents), status: state };
    return { id, status: state, createdAt: createdAt(row.createdAt), ...(kind === "settlements" ? { amountCents: row.amountCents == null ? null : amount(row.amountCents) } : { orderId: row.orderId == null ? null : identifier(row.orderId) }) };
  });
  return kind === "refunds" ? { refunds: summaries, hasNext: page.hasNext } : { records: summaries, hasNext: page.hasNext };
}
