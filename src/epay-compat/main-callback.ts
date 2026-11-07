import { createHmac } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { RuntimeSecretCipher } from "../settings/crypto.ts";
import type { WebhookTransport } from "../notifications/transport.ts";
import { readMainOrderContract } from "./main-native-order.ts";
import type { ConfirmedOrder } from "./confirmed-order.ts";
import { assertCallbackQueryIsUnambiguous } from "./notification.ts";
import { epaySign } from "./sign.ts";
import { parseStrictJson } from "../http/strict-json.ts";

const money = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
export function readMainCallback(sql: DatabaseSync, cipher: RuntimeSecretCipher, order: ConfirmedOrder) {
  const contract = readMainOrderContract(sql, cipher, order.trade_no, Number(order.merchant_id));
  if (!contract) return null;
  const paid = sql.prepare(`SELECT api_trade_no,paid_at,money_cents,real_money_cents,
    COALESCE((SELECT fee_cents FROM epay_alipay_confirmations WHERE trade_no=o.trade_no),
             (SELECT fee_cents FROM epay_wechat_confirmations WHERE trade_no=o.trade_no)) AS fee_cents
    FROM epay_orders o WHERE trade_no=? AND merchant_id=? AND status='PAID'`).get(order.trade_no, order.merchant_id);
  const amount = Number(paid?.money_cents), fee = Number(paid?.fee_cents), paidAt = Number(paid?.paid_at);
  if (!paid || !paid.api_trade_no || paid.paid_at === null || paid.fee_cents === null || !Number.isSafeInteger(amount) || amount < 1 || Number(paid.real_money_cents) !== amount || !Number.isSafeInteger(fee) || fee < 0 || fee > amount || !Number.isSafeInteger(paidAt) || paidAt < 0) throw new Error("main callback payment evidence is incomplete");
  const fields = { pid: contract.apiId, trade_no: String(paid.api_trade_no), out_trade_no: order.out_trade_no, type: order.type_code ?? "", name: order.name, money: money(amount), trade_status: "TRADE_SUCCESS" };
  const payload = { event: "payment.paid", orderId: contract.orderId, merchantOrderId: order.out_trade_no, amount: money(amount), platformFee: money(fee), merchantNet: money(amount - fee), tradeNo: String(paid.api_trade_no), paidAt: new Date(paidAt).toISOString(), ...fields };
  return { contract, fields, payload, targetUrl: order.notify_url };
}
export type MainCallback = NonNullable<ReturnType<typeof readMainCallback>>;

export function mainReturnUrl(callback: MainCallback, returnUrl: string) {
  const url = new URL(returnUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || returnUrl.length > 2048) throw new Error("invalid main merchant return URL");
  assertCallbackQueryIsUnambiguous(url);
  for (const [key, value] of Object.entries({ ...callback.fields, sign: epaySign(callback.fields, callback.contract.secret), sign_type: "MD5" })) url.searchParams.set(key, value);
  return url.toString();
}

// Use the existing queue's POST/GET phases for form/JSON respectively. Each lease
// owns one network call, so fallback cannot outlive the queue's timeout budget.
export async function deliverMainCallback(input: { callback: MainCallback; transport: WebhookTransport; phase: "POST" | "GET"; now: number; timeoutMilliseconds: number; signal?: AbortSignal | undefined }) {
  const { callback, transport } = input;
  assertCallbackQueryIsUnambiguous(new URL(callback.targetUrl));
  const headers: Record<string, string> = { "x-idempotency-key": callback.contract.callbackId };
  let body: string;
  const jsonPhase = input.phase === "GET";
  if (jsonPhase) {
    body = JSON.stringify(callback.payload);
    const timestamp = String(Math.floor(input.now / 1000));
    headers["x-lightpay-timestamp"] = timestamp;
    headers["x-lightpay-signature"] = `sha256=${createHmac("sha256", callback.contract.secret).update(`${timestamp}\n${body}`).digest("hex")}`;
    headers["x-lightpay-event"] = "payment.paid";
  } else body = new URLSearchParams({ ...callback.fields, sign: epaySign(callback.fields, callback.contract.secret), sign_type: "MD5" }).toString();
  const response = await transport.post({ targetUrl: callback.targetUrl, body: Buffer.from(body), headers, contentType: jsonPhase ? "application/json" : "application/x-www-form-urlencoded", timeoutMilliseconds: input.timeoutMilliseconds, signal: input.signal });
  const accepted = response.status >= 200 && response.status < 300 && merchantAcknowledged(response.body);
  return { acknowledged: accepted, status: response.status };
}

function merchantAcknowledged(body: Uint8Array): boolean {
  const text = Buffer.from(body).toString("utf8").trim();
  if (text.toLowerCase() === "success") return true;
  let value: unknown;
  try { value = parseStrictJson(body); }
  catch { return false; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const reply = value as Record<string, unknown>;
  if (reply.error || (Object.hasOwn(reply, "ok") && reply.ok !== true) ||
      (Object.hasOwn(reply, "success") && reply.success !== true)) return false;
  return reply.ok === true || reply.success === true;
}
