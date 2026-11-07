import { randomBytes } from "node:crypto";
import type { AppDatabase } from "../database/database.ts";
import { appendAuditEvent } from "../database/identity-store.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { expirationMinutes } from "./order-expiration.ts";
import { queryWechatSubmissionState } from "./wechat-query-client.ts";
import { activeWechatSigningKey, signWechatRequest } from "./wechat-signing-keys.ts";
import { verifyWechatSignature } from "./wechat-evidence.ts";
import { readBoundedBody } from "./main-order-auth.ts";

type Options = { database: Pick<AppDatabase, "read" | "write" | "instanceId">; masterKey: Uint8Array; tradeNo: string; signingKeyId: string; transport: typeof fetch; clock?: () => number };
function expiredIntent(options: Options, now: number) {
  const cipher = new RuntimeSecretCipher(options.masterKey, options.database.instanceId());
  return options.database.read(sql => {
    const row = sql.prepare(`SELECT i.app_id,i.provider_merchant_id,o.created_at FROM epay_wechat_intents i JOIN epay_orders o ON o.trade_no=i.trade_no
      AND o.merchant_id=i.merchant_id AND o.money_cents=i.amount_cents WHERE i.trade_no=? AND o.status='PENDING'`).get(options.tradeNo);
    if (!row || now < Number(row.created_at) + expirationMinutes(sql, cipher) * 60000) return null;
    return { appId: String(row.app_id), merchantId: String(row.provider_merchant_id) };
  });
}

export async function queryOrCloseExpiredWechat(options: Options) {
  if (expiredIntent(options, (options.clock ?? Date.now)())) return closeExpiredWechatOrder(options);
  return queryWechatSubmissionState(options);
}

// Closing is safe only after signed NOTPAY; a second signed query decides the local terminal state.
export async function closeExpiredWechatOrder(options: Options) {
  const clock = options.clock ?? Date.now, now = clock();
  if (!/^[a-f0-9]{32}$/.test(options.tradeNo) || !Number.isSafeInteger(now) || now < 0) throw new Error("invalid WeChat close request");
  const intent = expiredIntent(options, now);
  if (!intent) return { closed: false, paymentConfirmed: false };
  const before = await queryWechatSubmissionState(options);
  if (before.paymentConfirmed || !["NOTPAY", "CLOSED"].includes(before.tradeStatus)) return { ...before, closed: false };
  const cipher = new RuntimeSecretCipher(options.masterKey, options.database.instanceId());
  let verified: Awaited<ReturnType<typeof queryWechatSubmissionState>> = before;
  if (before.tradeStatus === "NOTPAY") {
    const current = expiredIntent(options, clock());
    if (!current || current.appId !== intent.appId || current.merchantId !== intent.merchantId) throw new Error("WeChat close identity changed");
    const path = `/v3/pay/transactions/out-trade-no/${options.tradeNo}/close`, body = JSON.stringify({ mchid: intent.merchantId });
    const timestamp = String(Math.floor(clock() / 1000)), nonce = randomBytes(16).toString("hex");
    const signed = options.database.read(sql => signWechatRequest(sql, cipher, options.signingKeyId, intent.appId, intent.merchantId, clock(), `POST\n${path}\n${timestamp}\n${nonce}\n${body}\n`));
    const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${intent.merchantId}",nonce_str="${nonce}",signature="${signed.signature}",timestamp="${timestamp}",serial_no="${signed.serial}"`;
    const response = await options.transport(new URL(path, "https://api.mch.weixin.qq.com"), { method: "POST", headers: { authorization, "content-type": "application/json", accept: "application/json" }, body,
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (response.status !== 204 && response.status !== 200) { await response.body?.cancel(); throw new Error("WeChat close response requires verification"); }
    const raw = response.body ? await readBoundedBody(response.body, 65536) : Buffer.alloc(0), verifiedAt = clock();
    options.database.read(sql => {
      activeWechatSigningKey(sql, options.signingKeyId, intent.appId, intent.merchantId, verifiedAt);
      const credentials = sql.prepare(`SELECT c.platform_key,c.platform_key_id FROM epay_wechat_credentials c LEFT JOIN epay_wechat_credential_revocations r ON r.credential_id=c.credential_id
        WHERE c.app_id=? AND c.provider_merchant_id=? AND c.platform_key_id=? AND c.valid_from<=? AND c.valid_until>? AND c.created_at<=? AND r.credential_id IS NULL`)
        .all(intent.appId, intent.merchantId, response.headers.get("wechatpay-serial") ?? "", verifiedAt, verifiedAt, verifiedAt);
      if (credentials.length !== 1) throw new Error("WeChat close response key is unavailable");
      verifyWechatSignature(raw, response.headers, { platformKey: String(credentials[0]!.platform_key), platformKeyId: String(credentials[0]!.platform_key_id) }, verifiedAt);
    });
    verified = await queryWechatSubmissionState(options);
  }
  if (verified.paymentConfirmed || verified.tradeStatus !== "CLOSED") return { ...verified, closed: false };
  const closed = options.database.write(sql => {
    if (sql.prepare("SELECT 1 FROM epay_wechat_confirmations WHERE trade_no=?").get(options.tradeNo)) return false;
    const changed = sql.prepare(`UPDATE epay_orders SET status='CLOSED',updated_at=? WHERE trade_no=? AND status='PENDING'
      AND EXISTS(SELECT 1 FROM epay_wechat_intents i WHERE i.trade_no=epay_orders.trade_no AND i.app_id=? AND i.provider_merchant_id=?)`)
      .run(clock(), options.tradeNo, intent.appId, intent.merchantId);
    if (Number(changed.changes) !== 1) return false;
    appendAuditEvent(sql, { occurredAt: clock(), actorType: "SYSTEM", actorId: "payment-query", action: "epay.order.closed", outcome: "SUCCESS", subjectType: "epay_order", subjectId: options.tradeNo, details: { provider: "wxpay", observedState: "CLOSED", signatureVerified: true } });
    return true;
  });
  return { ...verified, closed };
}
