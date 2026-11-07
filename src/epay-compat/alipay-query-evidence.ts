import { parseStrictJson } from "../http/strict-json.ts";
import { getHeader } from "../infrastructure/alipay/errors.ts";
import type { RawV3Response } from "../infrastructure/alipay/types.ts";
import { verifyV3Response } from "../infrastructure/alipay/v3.ts";
import type { AlipayOrderExpectation, VerifiedAlipayEvidence } from "./alipay-evidence.ts";
import { parseLegacyCents } from "./money.ts";
import { requireAlipayQueryAccount, type AlipayQueryAccount } from "./alipay-query-account.ts";

const QUERY_STATES = new Set(["WAIT_BUYER_PAY", "TRADE_CLOSED", "TRADE_SUCCESS", "TRADE_FINISHED"]);
const MAX_RESPONSE_AGE_MS = 300_000;

export function verifyAlipayQueryEvidence(response: RawV3Response, expected: AlipayOrderExpectation, now: number, account?: AlipayQueryAccount): { tradeStatus: string; evidence: VerifiedAlipayEvidence | null } {
  if (!expected.appId || !expected.sellerId || !expected.tradeNo || !Number.isSafeInteger(expected.amountCents) || expected.amountCents < 1 || !Number.isSafeInteger(now) || now < 0) throw new Error("invalid expected Alipay query");
  const verified = verifyV3Response(response, expected.platformPublicKey);
  const timestamp = getHeader(verified.headers, "alipay-timestamp") ?? "";
  const signedAt = /^\d{10}$/.test(timestamp) ? Number(timestamp) * 1000 : /^\d{13}$/.test(timestamp) ? Number(timestamp) : NaN;
  if (!Number.isSafeInteger(signedAt) || Math.abs(now - signedAt) > MAX_RESPONSE_AGE_MS) throw new Error("Alipay query response is stale");
  const parsed: unknown = parseStrictJson(verified.bodyBytes);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid Alipay query body");
  const fields = parsed as Record<string, unknown>;
  if (verified.status === 400 && fields.code === "ACQ.TRADE_NOT_EXIST" && fields.out_trade_no === expected.tradeNo && account) {
    requireAlipayQueryAccount(account, expected, now);
    return { tradeStatus: "TRADE_NOT_EXIST", evidence: null };
  }
  if (verified.status !== 200) throw new Error("Alipay query is not successful");
  if (fields.out_trade_no !== expected.tradeNo || (fields.app_id !== undefined && fields.app_id !== expected.appId) || typeof fields.trade_status !== "string" || !QUERY_STATES.has(fields.trade_status)) throw new Error("Alipay query order identity mismatch");
  // Official trade queries may omit seller_id; only a pinned certificate binding can replace it.
  if (fields.seller_id === undefined && account) requireAlipayQueryAccount(account, expected, now);
  else if (fields.seller_id !== expected.sellerId) throw new Error("Alipay query seller identity is missing or mismatched");
  if (typeof fields.total_amount !== "string" || !/^\d+(?:\.\d{1,2})?$/.test(fields.total_amount) || parseLegacyCents(fields.total_amount.replace(/^0+(?=\d)/, "")) !== expected.amountCents) throw new Error("Alipay query amount mismatch");
  if (fields.trade_status !== "TRADE_SUCCESS" && fields.trade_status !== "TRADE_FINISHED") return { tradeStatus: fields.trade_status, evidence: null };
  if (typeof fields.trade_no !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(fields.trade_no)) throw new Error("Alipay query transaction identity is missing");
  return { tradeStatus: fields.trade_status, evidence: { provider: "alipay", appId: expected.appId, sellerId: expected.sellerId, tradeNo: expected.tradeNo, providerTradeNo: fields.trade_no, amountCents: expected.amountCents } };
}
