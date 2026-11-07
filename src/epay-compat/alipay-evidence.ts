import { createPublicKey, verify } from "node:crypto";
import { parseLegacyCents } from "./money.ts";

export interface AlipayOrderExpectation {
  readonly appId: string;
  readonly sellerId: string;
  readonly tradeNo: string;
  readonly amountCents: number;
  readonly platformPublicKey: string;
}

export interface VerifiedAlipayEvidence {
  readonly provider: "alipay";
  readonly appId: string;
  readonly sellerId: string;
  readonly tradeNo: string;
  readonly providerTradeNo: string;
  readonly amountCents: number;
}

export function verifyAlipayEvidence(params: Readonly<Record<string, string>>, expected: AlipayOrderExpectation): VerifiedAlipayEvidence {
  if (!expected.appId || !expected.sellerId || !expected.tradeNo || !expected.platformPublicKey || !Number.isSafeInteger(expected.amountCents) || expected.amountCents < 1) throw new Error("invalid expected Alipay order");
  if (params.sign_type !== "RSA2" || !params.sign || !/^[A-Za-z0-9+/]+={0,2}$/.test(params.sign)) throw new Error("invalid Alipay signature format");
  const content = Object.keys(params).filter((key) => key !== "sign" && key !== "sign_type" && params[key] !== "").sort().map((key) => `${key}=${params[key]}`).join("&");
  let valid = false;
  try {
    valid = verify("RSA-SHA256", Buffer.from(content, "utf8"), createPublicKey(expected.platformPublicKey), Buffer.from(params.sign, "base64"));
  } catch (cause) {
    throw new Error("invalid Alipay verification key or signature", { cause });
  }
  if (!valid) throw new Error("Alipay signature verification failed");
  if (params.app_id !== expected.appId || params.seller_id !== expected.sellerId || params.out_trade_no !== expected.tradeNo) throw new Error("Alipay order identity mismatch");
  if (!params.trade_no || !/^[A-Za-z0-9_-]{1,128}$/.test(params.trade_no)) throw new Error("invalid Alipay provider trade number");
  if (params.trade_status !== "TRADE_SUCCESS" && params.trade_status !== "TRADE_FINISHED") throw new Error("Alipay payment is not successful");
  if (!params.total_amount || !/^\d+(?:\.\d{1,2})?$/.test(params.total_amount)) throw new Error("invalid Alipay amount");
  const cents = parseLegacyCents(params.total_amount.replace(/^0+(?=\d)/, ""));
  if (cents !== expected.amountCents) throw new Error("Alipay amount mismatch");
  return { provider: "alipay", appId: expected.appId, sellerId: expected.sellerId, tradeNo: expected.tradeNo, providerTradeNo: params.trade_no, amountCents: cents };
}
