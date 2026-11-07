import { createHash } from "node:crypto";
import { parseStrictJson } from "../http/strict-json.ts";
import { getHeader } from "../infrastructure/alipay/errors.ts";
import type { RawV3Response } from "../infrastructure/alipay/types.ts";
import { verifyV3Response } from "../infrastructure/alipay/v3.ts";
import { requireAlipayQueryAccount, type AlipayQueryAccount } from "./alipay-query-account.ts";
import { observeWechatRefund } from "./wechat-evidence.ts";
import { parseLegacyCents } from "./money.ts";

export type RefundIdentity = Readonly<{
  refundNo: string; tradeNo: string; merchantId: number; provider: "alipay" | "wxpay";
  providerAccount: string; providerTradeNo: string; totalCents: number; amountCents: number;
}>;
export type RefundEvidence = Readonly<RefundIdentity & {
  state: "SUCCEEDED" | "PROCESSING" | "CLOSED" | "UNKNOWN";
  providerRefundNo: string | null; responseSha256: string; verifiedAt: number;
}>;
const verified = new WeakSet<RefundEvidence>();
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function evidence(identity: RefundIdentity, state: RefundEvidence["state"], reference: string | null, bytes: Uint8Array, now: number): RefundEvidence {
  const proof = Object.freeze({ ...identity, state, providerRefundNo: reference, responseSha256: digest(bytes), verifiedAt: now });
  verified.add(proof);
  return proof;
}
export function requireRefundEvidence(proof: RefundEvidence, identity: RefundIdentity, now: number) {
  if (!verified.has(proof) || !Number.isSafeInteger(now) || now < proof.verifiedAt || now - proof.verifiedAt > 30_000 ||
      Object.entries(identity).some(([key, value]) => proof[key as keyof RefundIdentity] !== value)) throw new Error("refund evidence is unverified, stale or mismatched");
}

export function verifyWechatRefundResponse(identity: RefundIdentity, rawBody: Uint8Array, headers: Headers,
  key: { platformKey: string; platformKeyId: string }, now: number): RefundEvidence {
  if (identity.provider !== "wxpay") throw new Error("refund provider mismatch");
  const observation = observeWechatRefund(rawBody, headers, { ...key, tradeNo: identity.tradeNo, providerTradeNo: identity.providerTradeNo,
    refundNo: identity.refundNo, totalCents: identity.totalCents, refundCents: identity.amountCents, now });
  const fields = parseStrictJson(rawBody) as Record<string, unknown>;
  if (fields.mchid !== undefined && fields.mchid !== identity.providerAccount) throw new Error("refund merchant mismatch");
  const state = observation.state === "SUCCESS" ? "SUCCEEDED" : observation.state === "PROCESSING" ? "PROCESSING" : observation.state === "CLOSED" ? "CLOSED" : "UNKNOWN";
  return evidence(identity, state, observation.providerRefundNo, rawBody, now);
}

export function verifyAlipayRefundQuery(identity: RefundIdentity, response: RawV3Response,
  account: AlipayQueryAccount, platformPublicKey: string, now: number): RefundEvidence {
  if (identity.provider !== "alipay") throw new Error("refund provider mismatch");
  requireAlipayQueryAccount(account, { appId: account.appId, sellerId: identity.providerAccount, platformPublicKey }, now);
  const signed = verifyV3Response(response, platformPublicKey);
  const timestamp = getHeader(signed.headers, "alipay-timestamp") ?? "";
  const signedAt = /^\d{10}$/.test(timestamp) ? Number(timestamp) * 1000 : /^\d{13}$/.test(timestamp) ? Number(timestamp) : NaN;
  if (signed.status !== 200 || !Number.isSafeInteger(signedAt) || Math.abs(now - signedAt) > 300_000) throw new Error("refund query is unsuccessful or stale");
  const value = parseStrictJson(signed.bodyBytes);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid refund query");
  const fields = value as Record<string, unknown>;
  if (fields.out_trade_no !== identity.tradeNo || fields.trade_no !== identity.providerTradeNo || fields.out_request_no !== identity.refundNo ||
      (fields.seller_id !== undefined && fields.seller_id !== identity.providerAccount) || (fields.app_id !== undefined && fields.app_id !== account.appId)) throw new Error("refund query identity mismatch");
  if (typeof fields.refund_amount !== "string" || parseLegacyCents(fields.refund_amount) !== identity.amountCents ||
      typeof fields.total_amount !== "string" || parseLegacyCents(fields.total_amount) !== identity.totalCents) throw new Error("refund query amount mismatch");
  // An authenticated 200 or a missing refund_status is not proof of a completed refund.
  const state = fields.refund_status === "REFUND_SUCCESS" ? "SUCCEEDED" : "UNKNOWN";
  return evidence(identity, state, `${identity.providerTradeNo}:${identity.refundNo}`, signed.bodyBytes, now);
}
