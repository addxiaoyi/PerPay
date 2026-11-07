import { createHash } from "node:crypto";
import { parseStrictJson } from "../http/strict-json.ts";
import { getHeader } from "../infrastructure/alipay/errors.ts";
import type { RawV3Response } from "../infrastructure/alipay/types.ts";
import { verifyV3Response } from "../infrastructure/alipay/v3.ts";
import { requireAlipayQueryAccount, type AlipayQueryAccount } from "./alipay-query-account.ts";
import { verifyWechatSignature } from "./wechat-evidence.ts";
import { parseLegacyCents } from "./money.ts";
import type { PayoutDestination, PayoutLease, PayoutProof } from "./payout-model.ts";

const verified = new WeakSet<PayoutProof>();
function fields(bytes: Uint8Array): Record<string, unknown> {
  const value = parseStrictJson(bytes);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid payout response");
  return value as Record<string, unknown>;
}
function proof(lease: PayoutLease, state: PayoutProof["state"], id: unknown, bytes: Uint8Array, now: number): PayoutProof {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("payout channel reference is missing");
  const value = Object.freeze({ outNo: lease.outNo, channel: lease.channel, payer: lease.payer, accountId: lease.accountId, amountCents: lease.amountCents,
    state, providerId: id, observedAt: now, responseSha256: createHash("sha256").update(bytes).digest("hex") });
  verified.add(value);
  return value;
}
export function requirePayoutProof(value: PayoutProof): void {
  if (!verified.has(value)) throw new Error("payout evidence is unverified");
}

export function verifyAlipayPayoutQuery(lease: PayoutLease, destination: PayoutDestination, response: RawV3Response, account: AlipayQueryAccount, platformKey: string, now: number): PayoutProof {
  if (lease.channel !== "alipay" || destination.kind !== "alipay") throw new Error("payout channel mismatch");
  requireAlipayQueryAccount(account, { appId: account.appId, sellerId: lease.payer, platformPublicKey: platformKey }, now);
  const signed = verifyV3Response(response, platformKey), timestamp = getHeader(signed.headers, "alipay-timestamp") ?? "";
  const signedAt = /^\d{10}$/.test(timestamp) ? Number(timestamp) * 1000 : /^\d{13}$/.test(timestamp) ? Number(timestamp) : NaN;
  if (signed.status !== 200 || !Number.isSafeInteger(signedAt) || Math.abs(now - signedAt) > 300_000) throw new Error("payout query is unsuccessful or stale");
  const value = fields(signed.bodyBytes);
  if (value.out_biz_no !== lease.outNo || (value.app_id !== undefined && value.app_id !== account.appId) ||
      (value.payer_user_id !== undefined && value.payer_user_id !== lease.payer) || (value.payee_logon_id !== undefined && value.payee_logon_id !== destination.account)) throw new Error("payout query identity mismatch");
  const returned = value.status === "REFUND" || (value.status === "SUCCESS" && value.sub_status === "REFUNDED");
  const state = returned ? "RETURNED" : value.status === "SUCCESS" ? "SUCCEEDED" : ["CLOSED", "FAIL"].includes(String(value.status)) ? "FAILED" : ["WAIT_PAY", "DEALING"].includes(String(value.status)) ? "PROCESSING" : null;
  if (!state) throw new Error("payout query state requires reconciliation");
  // Some failure responses omit amount; retain the hold until a complete authoritative result is available.
  if (typeof value.trans_amount !== "string" || parseLegacyCents(value.trans_amount) !== lease.amountCents) throw new Error("payout query amount mismatch");
  if (returned && value.refund_amount !== undefined && (typeof value.refund_amount !== "string" || parseLegacyCents(value.refund_amount) !== lease.amountCents)) throw new Error("partial payout return requires separate reconciliation");
  return proof(lease, state, value.order_id, signed.bodyBytes, now);
}

export function verifyWechatPayoutQuery(lease: PayoutLease, destination: PayoutDestination, bytes: Uint8Array, headers: Headers, key: { platformKey: string; platformKeyId: string }, now: number): PayoutProof {
  if (lease.channel !== "wechat" || destination.kind !== "wechat") throw new Error("payout channel mismatch");
  verifyWechatSignature(bytes, headers, key, now);
  const value = fields(bytes);
  if (value.out_bill_no !== lease.outNo || value.mch_id !== lease.payer || value.appid !== destination.appId || value.openid !== destination.account || value.transfer_amount !== lease.amountCents) throw new Error("payout query identity or amount mismatch");
  const state = value.state === "SUCCESS" ? "SUCCEEDED" : ["FAIL", "CANCELLED"].includes(String(value.state)) ? "FAILED" : value.state === "WAIT_USER_CONFIRM" ? "WAIT_USER_CONFIRM" : ["ACCEPTED", "PROCESSING", "TRANSFERING", "CANCELING"].includes(String(value.state)) ? "PROCESSING" : null;
  if (!state) throw new Error("payout query state is unknown");
  return proof(lease, state, value.transfer_bill_no, bytes, now);
}
