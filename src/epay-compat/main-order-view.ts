import type { AppDatabase } from "../database/database.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { readConfirmedOrder } from "./confirmed-order.ts";
import { expirationMinutes } from "./order-expiration.ts";
import { orderReadSource } from "./order-read-source.ts";
import { readAlipayWebUrl } from "./alipay-web.ts";

export type MainOrderReader = { database: Pick<AppDatabase, "read" | "instanceId">; masterKey: Uint8Array };

export function readMainOrder(options: MainOrderReader, orderId: string, merchantId: number, now: number) {
  return options.database.read(sql => {
    const row = sql.prepare(`SELECT o.*,n.order_id,n.main_merchant_id,n.channel,
      COALESCE(a.fee_cents,w.fee_cents) AS fee_cents, COALESCE(r.fee_rate_bps,q.fee_rate_bps) AS fee_bps
      FROM epay_main_native_orders n JOIN ${orderReadSource(sql)} o ON o.trade_no=n.trade_no
      LEFT JOIN epay_alipay_intents a ON a.trade_no=o.trade_no LEFT JOIN epay_wechat_intents w ON w.trade_no=o.trade_no
      LEFT JOIN epay_alipay_requests r ON r.trade_no=o.trade_no LEFT JOIN epay_exact_order_requests q ON q.trade_no=o.trade_no
      WHERE n.order_id=? AND n.merchant_id=?`).get(orderId, merchantId);
    if (!row) throw new Error("main order is unavailable");
    const amount = Number(row.money_cents), fee = Number(row.fee_cents), created = Number(row.created_at);
    const expires = created + expirationMinutes(sql, new RuntimeSecretCipher(options.masterKey, options.database.instanceId())) * 60_000;
    if ((row.payment_status ?? row.status) === "PAID" && !readConfirmedOrder(sql, String(row.trade_no), merchantId)) throw new Error("main order payment evidence differs");
    const qrCode = row.status === "PENDING" && now < expires ? storedMainQr(options, String(row.trade_no), merchantId) : null;
    const web = Boolean(sql.prepare("SELECT 1 FROM epay_alipay_web_orders WHERE trade_no=?").get(String(row.trade_no)));
    const paymentUrl = web && row.status === "PENDING" && now < expires ? readAlipayWebUrl(sql, new RuntimeSecretCipher(options.masterKey, options.database.instanceId()), String(row.trade_no)) : null;
    const status = row.status === "PAID" ? "paid" : row.status === "PENDING" ? now >= expires ? "expired" : qrCode || paymentUrl ? "pending_payment" : "pending_sync" : row.status === "REFUNDED" ? "refunded" : row.status === "PARTIAL_REFUND" ? "partial_refund" : row.status === "REFUND_PROCESSING" ? "refund_processing" : row.status === "FROZEN" ? "frozen" : "closed";
    return { id: String(row.order_id), merchantOrderId: String(row.out_trade_no), merchantId: String(row.main_merchant_id), name: String(row.name), subject: String(row.name), channel: web ? "alipay_web" : String(row.channel),
      amountCents: amount, amount: `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, "0")}`, feeRate: Number(row.fee_bps) / 10_000,
      platformFeeCents: fee, merchantNetCents: amount - fee, status, paymentUrl, paymentFields: null, paymentHtml: null, qrCode,
      expiresAt: new Date(expires).toISOString(), createdAt: new Date(created).toISOString(), paidAt: row.paid_at === null ? null : new Date(Number(row.paid_at)).toISOString(),
      callbackStatus: row.notify_status, callbackAttempts: Number(row.notify_count), tradeNo: row.api_trade_no, lastError: null,
      refundStatus: ["refunded", "partial_refund", "refund_processing"].includes(status) ? status : null, refundedCents: Number(row.refunded_cents ?? 0),
    };
  });
}

export function publicMainOrder(order: ReturnType<typeof readMainOrder>) {
  const { id, merchantOrderId, subject, channel, amount, status, tradeNo, paidAt, createdAt, expiresAt } = order;
  return { id, merchantOrderId, subject, channel, amount, status, tradeNo, paidAt, createdAt, expiresAt };
}

export function storedMainQr(options: MainOrderReader, tradeNo: string, merchantId: number) {
  return options.database.read(sql => {
    const order = sql.prepare("SELECT type_code,status FROM epay_orders WHERE trade_no=? AND merchant_id=?").get(tradeNo, merchantId);
    if (!order || order.status !== "PENDING") return null;
    const alipay = order.type_code === "alipay";
    const row = sql.prepare(alipay
      ? "SELECT p.nonce,p.ciphertext,p.authentication_tag FROM epay_alipay_prepay p JOIN epay_alipay_submissions s ON s.trade_no=p.trade_no AND s.attempt_id=p.attempt_id WHERE p.trade_no=? AND s.state='UNCERTAIN'"
      : "SELECT p.nonce,p.ciphertext,p.authentication_tag FROM epay_wechat_prepay_results p JOIN epay_wechat_submissions s ON s.trade_no=p.trade_no AND s.attempt_id=p.attempt_id WHERE p.trade_no=? AND s.state='UNCERTAIN'").get(tradeNo) as { nonce: Uint8Array; ciphertext: Uint8Array; authentication_tag: Uint8Array } | undefined;
    if (!row) return null;
    const cipher = new RuntimeSecretCipher(options.masterKey, options.database.instanceId());
    const plain = cipher.decrypt(`epay:config:${alipay ? "alipay" : "wechat"}-prepay:${tradeNo}`, 1, { cipherVersion: 1, nonce: Buffer.from(row.nonce), ciphertext: Buffer.from(row.ciphertext), authenticationTag: Buffer.from(row.authentication_tag) });
    try { return plain.toString("utf8"); } finally { plain.fill(0); }
  });
}
