import { randomBytes } from "node:crypto";
import type { AppDatabase } from "../database/database.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { confirmRegisteredWechatQuery, observeAndConfirmRegisteredWechatQuery, verifyWechatMasterKeyGuard } from "./wechat-credentials.ts";
import { signWechatRequest } from "./wechat-signing-keys.ts";

type Database = Pick<AppDatabase, "read" | "write" | "instanceId">;
const QUERY_ORIGIN = "https://api.mch.weixin.qq.com";
const RESPONSE_LIMIT = 64 * 1024;

// The signing credential and transport are internal configuration, never merchant request fields.
type QueryOptions = {
  database: Database;
  masterKey: Uint8Array;
  tradeNo: string;
  signingKeyId: string;
  transport: typeof fetch;
  clock?: () => number;
};

export async function queryWechatSubmission(options: QueryOptions) {
  const confirmation = await queryWechat(options, false);
  if (!confirmation.paymentConfirmed) throw new Error("WeChat payment is not successful");
  return { duplicate: confirmation.duplicate };
}

export async function queryWechatSubmissionState(options: QueryOptions) {
  return queryWechat(options, true);
}

async function queryWechat(options: QueryOptions, allowPending: boolean) {
  const clock = options.clock ?? Date.now;
  const now = clock();
  if (!/^[a-f0-9]{32}$/.test(options.tradeNo) || !/^[A-Za-z0-9_-]{1,64}$/.test(options.signingKeyId) || !Number.isSafeInteger(now) || now < 0 || typeof options.transport !== "function") throw new Error("invalid WeChat query configuration");
  const cipher = new RuntimeSecretCipher(options.masterKey, options.database.instanceId());
  const intent = options.database.read((db) => {
    verifyWechatMasterKeyGuard(db, cipher);
    return db.prepare(`SELECT i.app_id,i.provider_merchant_id FROM epay_wechat_intents i
      JOIN epay_exact_order_requests r ON r.trade_no=i.trade_no
      JOIN epay_wechat_submissions s ON s.trade_no=i.trade_no
      JOIN epay_orders o ON o.trade_no=i.trade_no AND o.merchant_id=i.merchant_id AND o.money_cents=i.amount_cents
      WHERE i.trade_no=? AND s.state IN ('IN_FLIGHT','UNCERTAIN','SETTLED')`).get(options.tradeNo) as { app_id: string; provider_merchant_id: string } | undefined;
  });
  if (!intent) throw new Error("WeChat query order identity mismatch");
  const target = new URL(`/v3/pay/transactions/out-trade-no/${options.tradeNo}`, QUERY_ORIGIN);
  target.searchParams.set("mchid", intent.provider_merchant_id);
  const timestamp = String(Math.floor(now / 1000));
  const nonce = randomBytes(16).toString("hex");
  const message = `GET\n${target.pathname}${target.search}\n${timestamp}\n${nonce}\n\n`;
  const signed = options.database.read((db) => {
    verifyWechatMasterKeyGuard(db, cipher);
    return signWechatRequest(db, cipher, options.signingKeyId, intent.app_id, intent.provider_merchant_id, now, message);
  });
  const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${intent.provider_merchant_id}",nonce_str="${nonce}",signature="${signed.signature}",timestamp="${timestamp}",serial_no="${signed.serial}"`;
  let response: Response;
  try {
    response = await options.transport(target, { method: "GET", headers: { accept: "application/json", authorization }, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000) });
  } catch { throw new Error("WeChat query transport failed; submission remains unresolved"); }
  if (response.status !== 200 || !(response.headers.get("content-type") ?? "").toLowerCase().includes("application/json") || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("WeChat query did not return a successful response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > RESPONSE_LIMIT) throw new Error("response too large");
      chunks.push(part.value);
    }
  } catch { throw new Error("WeChat query response could not be read"); }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const verifiedAt = clock();
  const serial = response.headers.get("wechatpay-serial") ?? "";
  if (!Number.isSafeInteger(verifiedAt) || verifiedAt < now || !serial || serial.length > 128 || /[\x00-\x20\x7f]/.test(serial)) throw new Error("invalid WeChat query response metadata");
  const credentials = options.database.read((db) => db.prepare(`SELECT c.credential_id FROM epay_wechat_credentials c
    LEFT JOIN epay_wechat_credential_revocations r ON r.credential_id=c.credential_id
    WHERE c.platform_key_id=? AND c.app_id=? AND c.provider_merchant_id=? AND c.valid_from<=? AND c.valid_until>? AND c.created_at<=? AND r.credential_id IS NULL LIMIT 2`)
    .all(serial, intent.app_id, intent.provider_merchant_id, verifiedAt, verifiedAt, verifiedAt) as Array<{ credential_id: string }>);
  if (credentials.length !== 1) throw new Error("WeChat query verification credential unavailable or ambiguous");
  const body = Buffer.concat(chunks);
  if (allowPending) return observeAndConfirmRegisteredWechatQuery(options.database, options.masterKey, options.tradeNo, credentials[0]!.credential_id, body, response.headers, verifiedAt, options.signingKeyId);
  return { paymentConfirmed: true as const, ...confirmRegisteredWechatQuery(options.database, options.masterKey, options.tradeNo, credentials[0]!.credential_id, response.status, body, response.headers, verifiedAt, options.signingKeyId), tradeStatus: "SUCCESS" };
}
