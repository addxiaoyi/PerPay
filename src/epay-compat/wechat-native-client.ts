import { randomBytes } from "node:crypto";
import type { AppDatabase } from "../database/database.ts";
import { parseStrictJson } from "../http/strict-json.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { verifyWechatSignature } from "./wechat-evidence.ts";
import { verifyWechatMasterKeyGuard } from "./wechat-master-key.ts";
import { activeWechatSigningKey, signWechatRequest } from "./wechat-signing-keys.ts";
import { markWechatSubmissionUncertain, reserveWechatSubmission } from "./wechat-submission.ts";
import { validateWechatNativeFields } from "./wechat-native-fields.ts";

const PATH = "/v3/pay/transactions/native";
const ORIGIN = "https://api.mch.weixin.qq.com";
const MAX_RESPONSE_BYTES = 64 * 1024;
const LEASE_MS = 30_000;

type Database = Pick<AppDatabase, "read" | "write" | "instanceId">;

// The caller supplies trusted transport and the gateway's own callback URL, never EPay request fields.
export async function submitWechatNative(options: {
  database: Database;
  masterKey: Uint8Array;
  tradeNo: string;
  signingKeyId: string;
  notifyUrl: string;
  transport: typeof fetch;
  clock?: () => number;
}): Promise<void> {
  const clock = options.clock ?? Date.now;
  const now = clock();
  let notify: URL;
  try { notify = new URL(options.notifyUrl); } catch { throw new Error("invalid gateway notification URL"); }
  if (notify.protocol !== "https:" || !notify.hostname || notify.username || notify.password || notify.hash || options.notifyUrl.length > 255 || /[\x00-\x20\x7f]/.test(options.notifyUrl)) throw new Error("invalid gateway notification URL");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.signingKeyId) || typeof options.transport !== "function") throw new Error("invalid WeChat native configuration");
  const cipher = new RuntimeSecretCipher(options.masterKey, options.database.instanceId());
  options.database.read((db) => verifyWechatMasterKeyGuard(db, cipher));
  const reservation = reserveWechatSubmission(options.database, cipher, options.tradeNo, now, LEASE_MS, clock);
  try {
    validateWechatNativeFields(reservation);
    const body = JSON.stringify({ appid: reservation.appId, mchid: reservation.providerMerchantId, description: reservation.name, out_trade_no: reservation.tradeNo, notify_url: options.notifyUrl,
      time_expire: new Date(reservation.expiresAt).toISOString().replace(/\.\d{3}Z$/, "+00:00"), amount: { total: reservation.amountCents, currency: "CNY" } });
    const timestamp = String(Math.floor(reservation.startedAt / 1000));
    const nonce = randomBytes(16).toString("hex");
    const message = `POST\n${PATH}\n${timestamp}\n${nonce}\n${body}\n`;
    const signed = options.database.read((db) => {
      verifyWechatMasterKeyGuard(db, cipher);
      return signWechatRequest(db, cipher, options.signingKeyId, reservation.appId, reservation.providerMerchantId, reservation.startedAt, message);
    });
    const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${reservation.providerMerchantId}",nonce_str="${nonce}",signature="${signed.signature}",timestamp="${timestamp}",serial_no="${signed.serial}"`;
    const response = await options.transport(new URL(PATH, ORIGIN), { method: "POST", headers: { accept: "application/json", "content-type": "application/json", authorization }, body, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (response.status !== 200 || !(response.headers.get("content-type") ?? "").toLowerCase().includes("application/json") || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("WeChat native response requires reconciliation");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new Error("WeChat native response too large");
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const raw = Buffer.concat(chunks);
    const verifiedAt = clock();
    const serial = response.headers.get("wechatpay-serial") ?? "";
    if (!Number.isSafeInteger(verifiedAt) || verifiedAt < reservation.startedAt || !serial || serial.length > 128 || /[\x00-\x20\x7f]/.test(serial)) throw new Error("invalid WeChat native response metadata");
    options.database.write((db) => {
      verifyWechatMasterKeyGuard(db, cipher);
      activeWechatSigningKey(db, options.signingKeyId, reservation.appId, reservation.providerMerchantId, verifiedAt);
      const credentials = db.prepare(`SELECT c.platform_key,c.platform_key_id FROM epay_wechat_credentials c
        LEFT JOIN epay_wechat_credential_revocations r ON r.credential_id=c.credential_id
        WHERE c.platform_key_id=? AND c.app_id=? AND c.provider_merchant_id=? AND c.valid_from<=? AND c.valid_until>? AND c.created_at<=? AND r.credential_id IS NULL LIMIT 2`)
        .all(serial, reservation.appId, reservation.providerMerchantId, verifiedAt, verifiedAt, verifiedAt) as Array<{ platform_key: string; platform_key_id: string }>;
      if (credentials.length !== 1) throw new Error("WeChat response credential unavailable or ambiguous");
      verifyWechatSignature(raw, response.headers, { platformKey: credentials[0]!.platform_key, platformKeyId: credentials[0]!.platform_key_id }, verifiedAt);
      const parsed = parseStrictJson(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as Record<string, unknown>).code_url !== "string") throw new Error("invalid WeChat native response");
      const codeUrl = (parsed as { code_url: string }).code_url;
      if (codeUrl.length > 2048 || /[\x00-\x20\x7f]/.test(codeUrl)) throw new Error("invalid WeChat native code URL");
      const target = new URL(codeUrl);
      if (target.protocol !== "weixin:" || target.hostname !== "wxpay" || target.username || target.password || target.port || target.hash ||
          !["/bizpayurl", "/bizpayurl/up"].includes(target.pathname) || target.searchParams.getAll("pr").length !== 1 || !target.searchParams.get("pr")) throw new Error("invalid WeChat native code URL");
      const submission = db.prepare(`SELECT s.attempt_id FROM epay_wechat_submissions s JOIN epay_orders o ON o.trade_no=s.trade_no
        WHERE s.trade_no=? AND s.state='IN_FLIGHT' AND s.lease_token=? AND s.lease_until>? AND o.status='PENDING'`).get(reservation.tradeNo, reservation.leaseToken, verifiedAt) as { attempt_id: string } | undefined;
      if (!submission || submission.attempt_id !== reservation.attemptId) throw new Error("WeChat native submission lease is stale");
      const sealed = cipher.encrypt(`epay:config:wechat-prepay:${reservation.tradeNo}`, 1, codeUrl);
      db.prepare("INSERT INTO epay_wechat_prepay_results(trade_no,attempt_id,nonce,ciphertext,authentication_tag,received_at) VALUES (?,?,?,?,?,?)")
        .run(reservation.tradeNo, reservation.attemptId, sealed.nonce, sealed.ciphertext, sealed.authenticationTag, verifiedAt);
      const changed = db.prepare("UPDATE epay_wechat_submissions SET state='UNCERTAIN',lease_token=NULL,lease_until=NULL,updated_at=? WHERE trade_no=? AND state='IN_FLIGHT' AND lease_token=?")
        .run(verifiedAt, reservation.tradeNo, reservation.leaseToken);
      if (Number(changed.changes) !== 1) throw new Error("WeChat native submission changed");
    });
  } catch (cause) {
    const failedAt = clock();
    try { markWechatSubmissionUncertain(options.database, reservation.tradeNo, reservation.leaseToken, failedAt); }
    catch (error) {
      const state = options.database.read((db) => db.prepare("SELECT state FROM epay_wechat_submissions WHERE trade_no=?").get(reservation.tradeNo));
      if (state?.state !== "UNCERTAIN" && state?.state !== "SETTLED") throw new AggregateError([cause, error], "WeChat native submission state could not be preserved");
    }
    throw new Error("WeChat native submission requires reconciliation", { cause });
  }
}
