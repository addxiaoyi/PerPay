import type { KeyLike } from "node:crypto";
import { parseStrictJson } from "../http/strict-json.ts";
import type { RawV3Response, SignedV3Request } from "../infrastructure/alipay/types.ts";
import { signV3Request, verifyV3Response, type V3SignerOptions } from "../infrastructure/alipay/v3.ts";
import { parseLegacyCents } from "./money.ts";

const QUERY_PATH = "/v3/alipay/trade/query";

function validateTradeNo(tradeNo: string): void {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(tradeNo)) throw new Error("invalid Alipay query order number");
}

export function buildAlipayTradeQuery(tradeNo: string, signer: V3SignerOptions): SignedV3Request {
  validateTradeNo(tradeNo);
  return signV3Request({ method: "POST", path: QUERY_PATH, body: JSON.stringify({ out_trade_no: tradeNo }) }, signer);
}

// Signed observations still require channel-account and financial reconciliation.
export function verifyAlipayTradeObservation(response: RawV3Response, input: { tradeNo: string; platformKey: KeyLike | string; expectedAmountCents: number; expectedSellerId: string; expectedCertSn?: string }) {
  validateTradeNo(input.tradeNo);
  if (!Number.isSafeInteger(input.expectedAmountCents) || input.expectedAmountCents < 1 || !input.expectedSellerId) throw new Error("invalid Alipay query expectation");
  const verified = verifyV3Response(response, input.platformKey, { expectedAlipayCertSn: input.expectedCertSn });
  if (verified.status !== 200) throw new Error("Alipay query requires reconciliation");
  const parsed = parseStrictJson(verified.bodyBytes);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid Alipay query response");
  const record = parsed as Record<string, unknown>;
  if (record.out_trade_no !== input.tradeNo || typeof record.trade_status !== "string" || !/^[A-Z_]{1,64}$/.test(record.trade_status)) throw new Error("Alipay query response does not match the order");
  let amountMatch: "match" | "mismatch" | "unavailable" = "unavailable";
  if (record.total_amount !== undefined && record.total_amount !== null) {
    if (typeof record.total_amount !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(record.total_amount)) throw new Error("invalid Alipay query amount");
    const cents = parseLegacyCents(record.total_amount.replace(/^0+(?=\d)/, ""));
    amountMatch = cents === input.expectedAmountCents ? "match" : "mismatch";
  }
  let sellerMatch: "match" | "mismatch" | "unavailable" = "unavailable";
  if (record.seller_id !== undefined && record.seller_id !== null) {
    if (typeof record.seller_id !== "string" || !record.seller_id || record.seller_id.length > 128 || /[\x00-\x20\x7f]/.test(record.seller_id)) throw new Error("invalid Alipay query seller");
    sellerMatch = record.seller_id === input.expectedSellerId ? "match" : "mismatch";
  }
  return { tradeNo: input.tradeNo, tradeStatus: record.trade_status, amountMatch, sellerMatch, paymentConfirmed: false as const };
}
