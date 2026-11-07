import { createDecipheriv, createPublicKey, verify, X509Certificate } from "node:crypto";
import { parseStrictJson } from "../http/strict-json.ts";

export interface WechatCredential {
  readonly appId: string;
  readonly merchantId: string;
  readonly platformKey: string;
  readonly platformKeyId: string;
  readonly apiV3Key: string;
}

export interface WechatOrderExpectation extends WechatCredential {
  readonly tradeNo: string;
  readonly amountCents: number;
  readonly now: number;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid WeChat notification object");
  return value as Record<string, unknown>;
}

export function verifyWechatSignature(rawBody: Uint8Array, headers: Headers, expected: Pick<WechatCredential, "platformKey" | "platformKeyId">, now: number): void {
  if (!expected.platformKey || !expected.platformKeyId || !Number.isSafeInteger(now) || now < 0) throw new Error("invalid WeChat credential");
  if (rawBody.byteLength > 1024 * 1024) throw new Error("WeChat response too large");
  const timestamp = headers.get("wechatpay-timestamp") ?? "";
  const nonce = headers.get("wechatpay-nonce") ?? "";
  const serial = headers.get("wechatpay-serial") ?? "";
  const signature = headers.get("wechatpay-signature") ?? "";
  if (!/^\d{10}$/.test(timestamp) || Math.abs(now - Number(timestamp) * 1000) > 300_000 || !nonce || nonce.length > 128 || /[\r\n]/.test(nonce) || serial !== expected.platformKeyId || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) throw new Error("invalid WeChat signature headers");
  const message = Buffer.concat([Buffer.from(`${timestamp}\n${nonce}\n`), Buffer.from(rawBody), Buffer.from("\n")]);
  const key = expected.platformKey.includes("BEGIN CERTIFICATE") ? new X509Certificate(expected.platformKey).publicKey : createPublicKey(expected.platformKey);
  if (!verify("RSA-SHA256", message, key, Buffer.from(signature, "base64"))) throw new Error("WeChat signature verification failed");
}

function decryptWechatTransaction(rawBody: Uint8Array, headers: Headers, expected: WechatCredential, now: number) {
  if (!expected.appId || !expected.merchantId || Buffer.byteLength(expected.apiV3Key) !== 32) throw new Error("invalid WeChat credential");
  verifyWechatSignature(rawBody, headers, expected, now);
  const envelope = record(parseStrictJson(rawBody));
  const resource = record(envelope.resource);
  if (envelope.event_type !== "TRANSACTION.SUCCESS" || resource.algorithm !== "AEAD_AES_256_GCM" || typeof resource.ciphertext !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(resource.ciphertext) || typeof resource.nonce !== "string" || typeof resource.associated_data !== "string") throw new Error("invalid WeChat encrypted resource");
  const ciphertext = Buffer.from(resource.ciphertext, "base64");
  const iv = Buffer.from(resource.nonce, "utf8");
  if (iv.length !== 12 || ciphertext.length <= 16) throw new Error("invalid WeChat encrypted payload");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(expected.apiV3Key, "utf8"), iv);
  decipher.setAAD(Buffer.from(resource.associated_data, "utf8"));
  decipher.setAuthTag(ciphertext.subarray(-16));
  const transaction = record(parseStrictJson(Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()])));
  if (transaction.appid !== expected.appId || transaction.mchid !== expected.merchantId) throw new Error("WeChat order identity mismatch");
  return transaction;
}

// Credentials must come from trusted server configuration, never notification fields.
export function resolveWechatNotification<T extends WechatCredential>(rawBody: Uint8Array, headers: Headers, credentials: readonly T[], now: number): { tradeNo: string; credential: T } {
  if (!Number.isSafeInteger(now) || now < 0 || credentials.length < 1 || credentials.length > 16 || rawBody.byteLength > 1024 * 1024) throw new Error("invalid WeChat notification or credentials");
  const serial = headers.get("wechatpay-serial");
  let match: { tradeNo: string; credential: T } | undefined;
  for (const credential of credentials) {
    if (!credential.appId || !credential.merchantId || !credential.platformKey || !credential.platformKeyId || Buffer.byteLength(credential.apiV3Key) !== 32) throw new Error("invalid WeChat credential");
    if (credential.platformKeyId !== serial) continue;
    let transaction: Record<string, unknown>;
    try {
      transaction = decryptWechatTransaction(rawBody, headers, credential, now);
    } catch {
      continue;
    }
    if (typeof transaction.out_trade_no !== "string" || transaction.out_trade_no.length < 1 || transaction.out_trade_no.length > 64) throw new Error("invalid WeChat order identity");
    if (match !== undefined) throw new Error("ambiguous WeChat credentials");
    match = { tradeNo: transaction.out_trade_no, credential };
  }
  if (match === undefined) throw new Error("WeChat notification could not be authenticated");
  return match;
}

export function resolveWechatTradeNo(rawBody: Uint8Array, headers: Headers, credentials: readonly WechatCredential[], now: number): string {
  return resolveWechatNotification(rawBody, headers, credentials, now).tradeNo;
}

export function verifyWechatEvidence(rawBody: Uint8Array, headers: Headers, expected: WechatOrderExpectation) {
  if (!expected.tradeNo || !Number.isSafeInteger(expected.amountCents) || expected.amountCents < 1) throw new Error("invalid expected WeChat order");
  const transaction = decryptWechatTransaction(rawBody, headers, expected, expected.now);
  return verifyWechatTransaction(transaction, expected);
}

type QueryExpectation = Omit<WechatOrderExpectation, "apiV3Key">;

const QUERY_STATES = new Set(["SUCCESS", "REFUND", "NOTPAY", "CLOSED", "REVOKED", "USERPAYING", "PAYERROR"]);

// An observation never changes local order or accounting state.
export function observeWechatQuery(rawBody: Uint8Array, headers: Headers, expected: QueryExpectation) {
  if (!expected.appId || !expected.merchantId || !expected.tradeNo || !Number.isSafeInteger(expected.amountCents) || expected.amountCents < 1) throw new Error("invalid expected WeChat order");
  verifyWechatSignature(rawBody, headers, expected, expected.now);
  const transaction = record(parseStrictJson(rawBody));
  if (transaction.appid !== expected.appId || transaction.mchid !== expected.merchantId || transaction.out_trade_no !== expected.tradeNo) throw new Error("WeChat order identity mismatch");
  if (typeof transaction.trade_state !== "string" || !QUERY_STATES.has(transaction.trade_state)) throw new Error("unrecognized WeChat payment state");
  // WeChat omits amount after closure; this observation cannot authorize a payment posting.
  if (transaction.trade_state === "CLOSED" && transaction.amount === undefined) return { state: transaction.trade_state, amountCents: null };
  const amount = record(transaction.amount);
  if (amount.currency !== "CNY" || amount.total !== expected.amountCents) throw new Error("WeChat payment amount mismatch");
  if (transaction.trade_state === "SUCCESS") verifyWechatTransaction(transaction, expected);
  return { state: transaction.trade_state, amountCents: expected.amountCents };
}

export function verifyWechatQueryEvidence(rawBody: Uint8Array, headers: Headers, expected: QueryExpectation) {
  if (!expected.appId || !expected.merchantId || !expected.tradeNo || !Number.isSafeInteger(expected.amountCents) || expected.amountCents < 1) throw new Error("invalid expected WeChat order");
  verifyWechatSignature(rawBody, headers, expected, expected.now);
  const transaction = record(parseStrictJson(rawBody));
  if (transaction.appid !== expected.appId || transaction.mchid !== expected.merchantId) throw new Error("WeChat order identity mismatch");
  return verifyWechatTransaction(transaction, expected);
}

export type RefundExpectation = Pick<WechatCredential, "platformKey" | "platformKeyId"> & {
  readonly tradeNo: string;
  readonly providerTradeNo: string;
  readonly refundNo: string;
  readonly totalCents: number;
  readonly refundCents: number;
  readonly now: number;
};

const REFUND_STATES = new Set(["SUCCESS", "CLOSED", "PROCESSING", "ABNORMAL"]);

export function validateWechatRefundExpectation(expected: RefundExpectation): void {
  if (typeof expected.tradeNo !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(expected.tradeNo) || typeof expected.providerTradeNo !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(expected.providerTradeNo) || typeof expected.refundNo !== "string" || !/^[A-Za-z0-9_|*@-]{1,64}$/.test(expected.refundNo) || !Number.isSafeInteger(expected.totalCents) || expected.totalCents < 1 || !Number.isSafeInteger(expected.refundCents) || expected.refundCents < 1 || expected.refundCents > expected.totalCents || typeof expected.platformKey !== "string" || !expected.platformKey || typeof expected.platformKeyId !== "string" || !expected.platformKeyId || !Number.isSafeInteger(expected.now) || expected.now < 0) throw new Error("invalid expected WeChat refund");
}

// This authenticates an observation only; it does not change orders or balances.
export function observeWechatRefund(rawBody: Uint8Array, headers: Headers, expected: RefundExpectation) {
  validateWechatRefundExpectation(expected);
  verifyWechatSignature(rawBody, headers, expected, expected.now);
  const refund = record(parseStrictJson(rawBody));
  const amount = record(refund.amount);
  if (refund.out_trade_no !== expected.tradeNo || refund.transaction_id !== expected.providerTradeNo || refund.out_refund_no !== expected.refundNo) throw new Error("WeChat refund identity mismatch");
  if (amount.currency !== "CNY" || amount.total !== expected.totalCents || amount.refund !== expected.refundCents) throw new Error("WeChat refund amount mismatch");
  if (typeof refund.status !== "string" || !REFUND_STATES.has(refund.status)) throw new Error("unrecognized WeChat refund state");
  if (typeof refund.refund_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(refund.refund_id)) throw new Error("invalid WeChat refund ID");
  return { state: refund.status, providerRefundNo: refund.refund_id, refundCents: expected.refundCents };
}

function verifyWechatTransaction(transaction: Record<string, unknown>, expected: QueryExpectation) {
  const amount = record(transaction.amount);
  if (transaction.out_trade_no !== expected.tradeNo) throw new Error("WeChat order identity mismatch");
  if (transaction.trade_state !== "SUCCESS" || amount.currency !== "CNY" || amount.total !== expected.amountCents) throw new Error("WeChat payment status or amount mismatch");
  if (typeof transaction.transaction_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(transaction.transaction_id)) throw new Error("invalid WeChat transaction ID");
  return { provider: "wechat" as const, tradeNo: expected.tradeNo, providerTradeNo: transaction.transaction_id, amountCents: expected.amountCents, appId: expected.appId, merchantId: expected.merchantId };
}
