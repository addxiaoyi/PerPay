import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import type { AppDatabase } from "../database/database.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { readEPayParams } from "./shadow-gateway.ts";
import { expirationMinutes, orderAcceptsPayment } from "./order-expiration.ts";
import { PublicCheckoutRateLimiter } from "../http/public-checkout-rate-limit.ts";
import { orderReadSource } from "./order-read-source.ts";
import { readAlipayWebUrl } from "./alipay-web.ts";
import { authenticateEPayQuery, executeEPayAction } from "./api-actions.ts";
import { readLiveBalance } from "./live-balance.ts";

type Database = Pick<AppDatabase, "read" | "instanceId">;
type Order = {
  trade_no: string; out_trade_no: string; api_trade_no: string | null; type_code: string | null;
  merchant_id: number | bigint; name: string; money_cents: number | bigint; status: string;
  created_at: number | bigint; paid_at: number | bigint | null; param: string | null;
  buyer: string | null; pay_url: string | null; qr_code: string | null; url_scheme: string | null;
};

const STATUS_TEXT: Readonly<Record<string, string>> = { PENDING: "待支付", PAID: "已支付", PARTIAL_REFUND: "部分退款", REFUND_PROCESSING: "退款处理中", REFUNDED: "已退款", FROZEN: "已冻结", CLOSED: "已关闭" };

function prepayUrl(db: DatabaseSync, cipher: RuntimeSecretCipher, row: Order, now: number, minutes: number): string {
  if (row.status !== "PENDING" || !Number.isSafeInteger(now) || now < 0) return "";
  if (!orderAcceptsPayment(row.created_at, now, minutes)) return "";
  if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='epay_alipay_web_orders'").get() &&
      db.prepare("SELECT 1 FROM epay_alipay_web_orders WHERE trade_no=?").get(row.trade_no)) return readAlipayWebUrl(db, cipher, row.trade_no) ?? "";
  const channel = row.type_code === "alipay"
    ? { submissions: "epay_alipay_submissions", prepay: "epay_alipay_prepay", secret: "alipay-prepay" }
    : row.type_code === "wxpay"
      ? { submissions: "epay_wechat_submissions", prepay: "epay_wechat_prepay_results", secret: "wechat-prepay" }
      : null;
  if (!channel) return "";
  const exists = db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name IN (?,?)").get(channel.submissions, channel.prepay);
  if (Number(exists?.count) !== 2) return "";
  const saved = db.prepare(`SELECT s.started_at,p.nonce,p.ciphertext,p.authentication_tag
    FROM ${channel.submissions} s JOIN ${channel.prepay} p ON p.trade_no=s.trade_no AND p.attempt_id=s.attempt_id
    WHERE s.trade_no=? AND s.state='UNCERTAIN'`).get(row.trade_no);
  if (!saved) return "";
  const started = Number(saved.started_at);
  if (!Number.isSafeInteger(started) || started > now || now - started >= 2 * 60 * 60 * 1000) return "";
  const plain = cipher.decrypt(`epay:config:${channel.secret}:${row.trade_no}`, 1, { cipherVersion: 1, nonce: Buffer.from(saved.nonce as Uint8Array), ciphertext: Buffer.from(saved.ciphertext as Uint8Array), authenticationTag: Buffer.from(saved.authentication_tag as Uint8Array) });
  try { return new TextDecoder("utf-8", { fatal: true }).decode(plain); } finally { plain.fill(0); }
}

function legacyOrder(row: Order, minutes: number, currentPrepay = "") {
  const cents = Number(row.money_cents), created = Number(row.created_at);
  const paid = row.paid_at === null ? null : Number(row.paid_at);
  if (!Number.isSafeInteger(cents) || cents < 0 || !Number.isSafeInteger(created) || created < 0 || (paid !== null && (!Number.isSafeInteger(paid) || paid < 0))) throw new Error("invalid stored order");
  return {
    trade_no: row.trade_no, out_trade_no: row.out_trade_no, api_trade_no: row.api_trade_no ?? "",
    type: row.type_code ?? "", pid: Number(row.merchant_id), name: row.name,
    money: `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`,
    status: ["PAID", "PARTIAL_REFUND", "REFUND_PROCESSING"].includes(row.status) ? 1 : row.status === "REFUNDED" ? 2 : 0,
    status_text: STATUS_TEXT[row.status] ?? row.status, addtime: new Date(created).toISOString(),
    endtime: paid === null ? null : new Date(paid).toISOString(), expiretime: new Date(created + minutes * 60_000).toISOString(),
    param: row.param ?? "", buyer: row.buyer ?? "", payurl: row.pay_url || row.qr_code || row.url_scheme || currentPrepay,
  };
}

// Read-only compatibility candidate. Never mount this on production ingress without cutover validation.
export function createIsolatedEPayQuery(options: { database: Database & Partial<Pick<AppDatabase, "write">>; masterKey: Uint8Array; clock?: () => number; limiter?: PublicCheckoutRateLimiter; allowActions?: () => boolean }) {
  const app = new Hono();
  const cipher = new RuntimeSecretCipher(options.masterKey, options.database.instanceId());
  const limiter = options.limiter ?? new PublicCheckoutRateLimiter();
  app.on(["GET", "POST"], "/api.php", async (context) => {
    context.header("Cache-Control", "no-store");
    if (!limiter.take("unknown")) {
      context.header("Retry-After", "1");
      return context.json({ code: -1, msg: "请求过于频繁，请稍后再试" }, 429);
    }
    try {
      const params = await readEPayParams(context.req.raw);
      if (["refund", "notify"].includes(params.act ?? "")) {
        if (!options.allowActions?.() || !options.database.write) return context.json({ code: -1, msg: "当前暂不处理退款或通知操作。" }, 503);
        const action = options.database.write(sql => {
          const { merchantId } = authenticateEPayQuery(sql, cipher, params);
          return executeEPayAction(sql, params, merchantId, (options.clock ?? Date.now)());
        });
        return context.json(action);
      }
      const result = options.database.read((db) => {
        const { merchantId } = authenticateEPayQuery(db, cipher, params);
        if (params.act === "query") {
          const balance = readLiveBalance(db, merchantId);
          const money = `${Math.floor(Math.abs(balance.availableCents) / 100)}.${String(Math.abs(balance.availableCents) % 100).padStart(2, "0")}`;
          return { code: 1, msg: "查询商户信息成功", pid: merchantId, key: params.key, money: `${balance.availableCents < 0 ? "-" : ""}${money}`, status: 1 };
        }
        if (params.act === "orders") {
          const limitText = params.limit ?? "20", offsetText = params.offset ?? "0", statusText = params.status ?? "";
          if (!/^[1-9]\d?$/.test(limitText) || Number(limitText) > 50 || !/^(0|[1-9]\d{0,5})$/.test(offsetText) || !["", "0", "1", "2"].includes(statusText)) return { code: -1, msg: "invalid pagination or status" };
          const status = statusText === "0" ? "PENDING" : statusText === "1" ? "PAID" : statusText === "2" ? "REFUNDED" : "";
          const scope = `FROM ${orderReadSource(db)} WHERE merchant_id=? AND (?='' OR status=?)`;
          const countRow = db.prepare(`SELECT count(*) AS count ${scope}`).get(merchantId, status, status);
          const count = Number(countRow?.count);
          if (!Number.isSafeInteger(count) || count < 0) throw new Error("invalid order count");
          const rows = db.prepare(`SELECT trade_no,out_trade_no,api_trade_no,type_code,merchant_id,name,money_cents,status,created_at,paid_at,param,buyer,pay_url,qr_code,url_scheme
            ${scope} ORDER BY created_at DESC,trade_no DESC LIMIT ? OFFSET ?`).all(merchantId, status, status, Number(limitText), Number(offsetText)) as Order[];
          const minutes = expirationMinutes(db, cipher);
          return { code: 1, msg: "查询订单列表成功", count, data: rows.map((row) => legacyOrder(row, minutes)) };
        }
        if (params.act !== "order") return { code: -1, msg: "unsupported action" };
        const tradeNo = params.trade_no ?? "", external = params.out_trade_no ?? "";
        if ((!tradeNo && !external) || (tradeNo && external) || tradeNo.length > 64 || external.length > 150 || /[\x00-\x1f\x7f]/.test(tradeNo + external)) return { code: -1, msg: "invalid order reference" };
        const row = db.prepare(`SELECT trade_no,out_trade_no,api_trade_no,type_code,merchant_id,name,money_cents,status,created_at,paid_at,param,buyer,pay_url,qr_code,url_scheme
          FROM ${orderReadSource(db)} WHERE merchant_id=? AND ${tradeNo ? "trade_no" : "out_trade_no"}=?`).get(merchantId, tradeNo || external) as Order | undefined;
        if (!row) return { code: -1, msg: "order not found" };
        const minutes = expirationMinutes(db, cipher);
        return { code: 1, msg: "查询订单号成功", ...legacyOrder(row, minutes, prepayUrl(db, cipher, row, (options.clock ?? Date.now)(), minutes)) };
      });
      return context.json(result);
    } catch {
      return context.json({ code: -2, msg: "invalid or unavailable request" }, 400);
    }
  });
  return app;
}
