import { createHash } from "node:crypto";

import { MAX_REQUESTED_AMOUNT_CENTS } from "../orders/model.ts";
import { parseLegacyCents } from "./money.ts";
import { verifyEPaySign } from "./sign.ts";

export interface EPayMerchantIdentity {
  readonly merchantId: number;
  readonly enabled: boolean;
  readonly signingKey: string;
  readonly siteClientId: string;
}

export interface EPayOrderRequest {
  readonly merchantId: number;
  readonly siteClientId: string;
  readonly merchantOrderNo: string;
  readonly amountCents: number;
  readonly name: string;
  readonly type: string;
  readonly notifyUrl: string;
  readonly returnUrl: string;
  readonly param: string;
  readonly device: string;
  readonly openid: string;
  readonly idempotencyKey: string;
}

export function validateEPayOrder(params: Readonly<Record<string, string>>, merchant: EPayMerchantIdentity, mode: "page" | "api"): EPayOrderRequest {
  if (!Number.isSafeInteger(merchant.merchantId) || merchant.merchantId < 1 || params.pid !== String(merchant.merchantId) || !merchant.enabled || !merchant.siteClientId || !verifyEPaySign(params, merchant.signingKey)) {
    throw new Error("merchant authentication failed");
  }
  if (params.sign_type && params.sign_type.toUpperCase() !== "MD5") throw new Error("unsupported signature type");
  const orderNo = params.out_trade_no ?? "";
  if (!orderNo || orderNo.length > 150 || !/^[a-zA-Z0-9._\-|]+$/.test(orderNo)) throw new Error("invalid merchant order number");
  const amount = params.money ?? "";
  if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) throw new Error("invalid order amount");
  const normalizedAmount = amount.replace(/^0+(?=\d)/, "");
  const amountCents = parseLegacyCents(normalizedAmount);
  if (amountCents < 1 || amountCents > MAX_REQUESTED_AMOUNT_CENTS) throw new Error("order amount is outside the supported range");
  if (!params.name || params.name.length > 127 || !params.notify_url || (mode === "page" && !params.return_url)) throw new Error("missing or invalid order details");
  if (mode === "api" && (!params.type || !params.clientip)) throw new Error("missing payment type or client IP");
  const device = params.device || "pc";
  const openid = params.openid || "";
  if ((device === "miniprogram" && !/^[A-Za-z0-9_-]{1,128}$/.test(openid)) || (openid && device !== "miniprogram")) throw new Error("invalid payer identity");
  const idempotencyKey = createHash("sha256").update(JSON.stringify(["legacy-epay-order-v1", merchant.merchantId, orderNo]), "utf8").digest("hex");
  return { merchantId: merchant.merchantId, siteClientId: merchant.siteClientId, merchantOrderNo: orderNo, amountCents, name: params.name, type: params.type || "", notifyUrl: params.notify_url, returnUrl: params.return_url || "", param: params.param || "", device, openid, idempotencyKey };
}
