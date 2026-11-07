import { createHash, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { readMerchantSecret } from "./merchant-secret.ts";
import { retryMerchantCallback } from "./callback-retry.ts";
import { requestRefund } from "./refund-workflow.ts";
import { parseLegacyCents } from "./money.ts";

export function authenticateEPayQuery(sql: DatabaseSync, cipher: RuntimeSecretCipher, params: Readonly<Record<string, string>>) {
  if (!/^[1-9]\d{0,14}$/.test(params.pid ?? "") || !params.key || params.key.length > 512) throw new Error("authentication failed");
  const merchantId = Number(params.pid);
  if (!Number.isSafeInteger(merchantId) || !sql.prepare("SELECT 1 FROM epay_merchant_accounts WHERE merchant_id=? AND enabled=1").get(merchantId)) throw new Error("authentication failed");
  const secret = readMerchantSecret(sql, cipher, merchantId);
  if (!timingSafeEqual(createHash("sha256").update(secret).digest(), createHash("sha256").update(params.key).digest())) throw new Error("authentication failed");
  return { merchantId, secret };
}

export function executeEPayAction(sql: DatabaseSync, params: Readonly<Record<string, string>>, merchantId: number, now: number) {
  if (!sql.isTransaction) throw new Error("EPay action requires a transaction");
  const tradeNo = params.trade_no ?? "", external = params.out_trade_no ?? "";
  if ((!tradeNo && !external) || (tradeNo && external) || tradeNo.length > 64 || external.length > 150 || /[\x00-\x1f\x7f]/.test(tradeNo + external)) throw new Error("invalid order reference");
  const order = sql.prepare(`SELECT trade_no,money_cents FROM epay_orders WHERE merchant_id=? AND ${tradeNo ? "trade_no" : "out_trade_no"}=?`).get(merchantId, tradeNo || external);
  if (!order) throw new Error("order not found");
  if (params.act === "notify") {
    const job = sql.prepare("SELECT attempts,status FROM epay_callback_jobs WHERE trade_no=? AND merchant_id=?").get(String(order.trade_no), merchantId);
    if (!job) return { code: -1, msg: "历史订单由原支付系统处理，请联系管理员重试通知。" };
    const requestId = params.request_id || `api-notify-${createHash("sha256").update(`${order.trade_no}:${job.attempts}`).digest("hex").slice(0, 32)}`;
    const queued = retryMerchantCallback(sql, { tradeNo: String(order.trade_no), merchantId, requestId, actor: `epay-api:${merchantId}` }, now);
    return { code: 1, msg: queued.queued ? "通知任务已排队，送达结果请查询回调记录。" : "商户已确认收到通知。", ...queued };
  }
  if (params.act !== "refund") throw new Error("unsupported action");
  const native = sql.prepare("SELECT 1 FROM epay_alipay_intents WHERE trade_no=? UNION ALL SELECT 1 FROM epay_wechat_intents WHERE trade_no=?").get(String(order.trade_no), String(order.trade_no));
  if (!native) return { code: -1, msg: "历史订单由原支付系统处理，请联系管理员申请退款。" };
  const binding = sql.prepare("SELECT main_merchant_id,main_api_id FROM epay_merchant_bindings WHERE epay_merchant_id=?").get(merchantId);
  if (!binding) throw new Error("merchant binding unavailable");
  const amountCents = params.money ? parseLegacyCents(params.money) : Number(order.money_cents);
  const requestId = params.request_id || `api-refund-${createHash("sha256").update(`${order.trade_no}:${amountCents}`).digest("hex").slice(0, 32)}`;
  const refund = requestRefund({ read: action => action(sql), write: action => action(sql) },
    { merchantId: String(binding.main_merchant_id), mainApiId: String(binding.main_api_id), epayMerchantId: merchantId, role: "owner", userId: `epay-api:${merchantId}` },
    { requestId, tradeNo: String(order.trade_no), amountCents, reason: params.reason?.trim() || "商户 API 退款申请" }, now);
  return { code: 1, msg: "退款申请已保存，等待管理员审核；尚未完成渠道退款。", refund_no: refund.refundNo, status: refund.status };
}
