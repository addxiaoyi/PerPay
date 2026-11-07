import { epaySign } from "./sign.ts";
import type { WebhookTransport } from "../notifications/transport.ts";

const CALLBACK_FIELDS = new Set(["pid", "trade_no", "out_trade_no", "type", "name", "money", "trade_status", "param", "sign", "sign_type"]);

export function assertCallbackQueryIsUnambiguous(target: URL): void {
  for (const key of target.searchParams.keys()) {
    if (CALLBACK_FIELDS.has(key)) throw new Error("callback target contains a reserved payment parameter");
  }
}

export interface EPayPaidNotification {
  readonly merchantId: number;
  readonly tradeNo: string;
  readonly merchantOrderNo: string;
  readonly type: string;
  readonly name: string;
  readonly amountCents: number;
  readonly receivedAmountCents: number;
  readonly paymentStatus: string;
  readonly param: string;
}

export function buildEPayPaidNotification(order: EPayPaidNotification, signingKey: string): Record<string, string> {
  if (order.paymentStatus !== "CONFIRMED" || !Number.isSafeInteger(order.amountCents) || order.amountCents <= 0 || order.receivedAmountCents !== order.amountCents) {
    throw new Error("payment is not confirmed for the exact legacy amount");
  }
  if (!Number.isSafeInteger(order.merchantId) || order.merchantId < 1 || !order.tradeNo || !order.merchantOrderNo || !order.name) throw new Error("payment notification is incomplete");
  const money = `${Math.floor(order.amountCents / 100)}.${String(order.amountCents % 100).padStart(2, "0")}`;
  const params = { pid: String(order.merchantId), trade_no: order.tradeNo, out_trade_no: order.merchantOrderNo, type: order.type, name: order.name, money, trade_status: "TRADE_SUCCESS", param: order.param };
  return { ...params, sign: epaySign(params, signingKey), sign_type: "MD5" };
}

export function buildEPayReturnUrl(order: EPayPaidNotification, signingKey: string, returnUrl: string): string {
  const target = new URL(returnUrl);
  if (target.protocol !== "https:" || !target.hostname || target.username || target.password || target.hash || returnUrl.length > 2048) throw new Error("invalid merchant return URL");
  assertCallbackQueryIsUnambiguous(target);
  const params = buildEPayPaidNotification(order, signingKey);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  const url = target.toString();
  if (url.length > 8192) throw new Error("merchant return URL is too long");
  return url;
}

export async function deliverEPayPaidNotification(input: {
  readonly order: EPayPaidNotification;
  readonly signingKey: string;
  readonly targetUrl: string;
  readonly transport: WebhookTransport;
  readonly timeoutMilliseconds: number;
  readonly method?: "POST" | "GET";
  readonly signal?: AbortSignal | undefined;
}): Promise<{ readonly acknowledged: boolean; readonly status: number }> {
  const params = buildEPayPaidNotification(input.order, input.signingKey);
  const target = new URL(input.targetUrl);
  assertCallbackQueryIsUnambiguous(target);
  let response;
  if (input.method === "GET") {
    if (!input.transport.get) throw new Error("callback transport does not support GET");
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
    response = await input.transport.get({ targetUrl: target.toString(), timeoutMilliseconds: input.timeoutMilliseconds, signal: input.signal });
  } else response = await input.transport.post({
    targetUrl: input.targetUrl,
    body: Buffer.from(new URLSearchParams(params).toString(), "utf8"),
    headers: {},
    contentType: "application/x-www-form-urlencoded",
    timeoutMilliseconds: input.timeoutMilliseconds,
    signal: input.signal,
  });
  return { acknowledged: response.status >= 200 && response.status < 300 && response.body.toString("utf8").trim().toLowerCase() === "success", status: response.status };
}
