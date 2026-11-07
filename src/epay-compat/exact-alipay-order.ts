import { createHash, randomUUID } from "node:crypto";
import type { AppDatabase } from "../database/database.ts";
import { NodeWebhookTransport } from "../notifications/transport.ts";
import { withAuthenticatedOrder } from "./authenticated-order.ts";
import { validateAlipayPrecreateOrder } from "./alipay-precreate.ts";
import type { EPayOrderRequest } from "./order-request.ts";
import { assertCallbackQueryIsUnambiguous } from "./notification.ts";
import { pinOrderSigningKey } from "./merchant-secret.ts";

export function exactAlipayFingerprint(order: EPayOrderRequest): string {
  return createHash("sha256").update(JSON.stringify([order.merchantId, order.siteClientId, order.merchantOrderNo, order.amountCents, order.name, order.type, order.notifyUrl, order.returnUrl, order.param, order.device, order.openid])).digest("hex");
}

// Order identity, fee and channel binding are fixed in one transaction.
export function createExactAlipayOrder(database: Pick<AppDatabase, "write" | "instanceId">, masterKey: Uint8Array, params: Readonly<Record<string, string>>, mode: "page" | "api", now: number, product: "qr" | "web" = "qr") {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid order time");
  return withAuthenticatedOrder(database, masterKey, params, mode, (db, order) => {
    const deviceSupported = order.device === "pc" || product === "web" && order.device === "mobile";
    if (order.type !== "alipay" || !deviceSupported || order.openid || order.param.length > 1024 || /[\x00-\x1f\x7f]/.test(order.param)) throw new Error("unsupported Alipay order");
    const target = (value: string) => {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.hash || value.length > 2048) throw new Error("invalid order URL");
      return url;
    };
    try {
      const callback = target(order.notifyUrl);
      assertCallbackQueryIsUnambiguous(callback);
      new NodeWebhookTransport(callback.origin).validateTarget(order.notifyUrl);
    }
    catch (cause) { throw new Error("invalid callback URL", { cause }); }
    if (order.returnUrl) assertCallbackQueryIsUnambiguous(target(order.returnUrl));
    const fingerprint = exactAlipayFingerprint(order);
    const existing = db.prepare(`SELECT o.trade_no,o.merchant_id,o.money_cents,o.type_code,o.name,o.notify_url,o.return_url,o.param,o.device,
      r.client_id,q.request_fingerprint,q.fee_rate_bps,i.merchant_id AS intent_merchant,i.amount_cents,i.fee_cents,i.app_id,i.seller_id,i.platform_public_key,
      b.app_id AS bound_app,b.seller_id AS bound_seller,b.platform_public_key AS bound_key
      FROM epay_orders o LEFT JOIN epay_alipay_orders r ON r.trade_no=o.trade_no
      LEFT JOIN epay_alipay_requests q ON q.trade_no=o.trade_no LEFT JOIN epay_alipay_intents i ON i.trade_no=o.trade_no
      LEFT JOIN epay_alipay_bindings b ON b.client_id=r.client_id WHERE o.merchant_id=? AND o.out_trade_no=?`).get(order.merchantId, order.merchantOrderNo);
    if (existing) {
      const fee = existing.fee_rate_bps == null ? -1 : Number((BigInt(order.amountCents) * BigInt(existing.fee_rate_bps as number | bigint) + 5000n) / 10000n);
      if (existing.client_id !== order.siteClientId || existing.request_fingerprint !== fingerprint || Number(existing.merchant_id) !== order.merchantId || Number(existing.money_cents) !== order.amountCents || existing.type_code !== order.type || existing.name !== order.name || existing.notify_url !== order.notifyUrl || existing.return_url !== (order.returnUrl || null) || existing.param !== (order.param || null) || existing.device !== order.device || Number(existing.intent_merchant) !== order.merchantId || Number(existing.amount_cents) !== order.amountCents || Number(existing.fee_cents) !== fee || !existing.app_id || existing.app_id !== existing.bound_app || existing.seller_id !== existing.bound_seller || existing.platform_public_key !== existing.bound_key) throw new Error("merchant order conflict");
      return { tradeNo: String(existing.trade_no), created: false as const };
    }
    const binding = db.prepare(`SELECT b.app_id,b.seller_id,b.platform_public_key,m.fee_rate_bps FROM epay_alipay_bindings b
      JOIN epay_site_bindings s ON s.client_id=b.client_id JOIN epay_merchant_accounts m ON m.merchant_id=s.merchant_id AND m.enabled=1
      WHERE b.client_id=? AND m.merchant_id=?`).get(order.siteClientId, order.merchantId) as { app_id: string; seller_id: string; platform_public_key: string; fee_rate_bps: number | bigint } | undefined;
    if (!binding) throw new Error("Alipay channel unavailable");
    const rate = Number(binding.fee_rate_bps);
    if (!Number.isSafeInteger(rate) || rate < 0 || rate > 5000) throw new Error("invalid merchant fee");
    const tradeNo = randomUUID().replaceAll("-", "");
    validateAlipayPrecreateOrder({ tradeNo, amountCents: order.amountCents, subject: order.name });
    const fee = Number((BigInt(order.amountCents) * BigInt(rate) + 5000n) / 10000n);
    db.prepare(`INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,type_code,name,money_cents,notify_url,return_url,param,device,status,notify_status,notify_count,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'PENDING','PENDING',0,?,?)`).run(tradeNo, order.merchantOrderNo, order.merchantId, order.type, order.name, order.amountCents, order.notifyUrl, order.returnUrl || null, order.param || null, order.device, now, now);
    db.prepare("INSERT INTO epay_alipay_intents VALUES (?,?,?,?,?,?,?,?)").run(tradeNo, order.merchantId, binding.app_id, binding.seller_id, binding.platform_public_key, order.amountCents, fee, now);
    db.prepare("INSERT INTO epay_alipay_orders VALUES (?,?)").run(tradeNo, order.siteClientId);
    db.prepare("INSERT INTO epay_alipay_requests VALUES (?,?,?)").run(tradeNo, fingerprint, rate);
    pinOrderSigningKey(db, order.merchantId, tradeNo);
    return { tradeNo, created: true as const };
  });
}
