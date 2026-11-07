import { createHash, randomUUID } from "node:crypto";
import type { AppDatabase } from "../database/database.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { NodeWebhookTransport } from "../notifications/transport.ts";
import { withAuthenticatedOrder } from "./authenticated-order.ts";
import type { EPayOrderRequest } from "./order-request.ts";
import { validateWechatNativeFields } from "./wechat-native-fields.ts";
import { assertCallbackQueryIsUnambiguous } from "./notification.ts";
import { pinOrderSigningKey } from "./merchant-secret.ts";

export function exactWechatFingerprint(order: EPayOrderRequest): string {
  return createHash("sha256").update(JSON.stringify(["epay-exact-wechat-v1", order.merchantId, order.siteClientId, order.merchantOrderNo, order.amountCents, order.name, order.type, order.notifyUrl, order.returnUrl, order.param, order.device, order.openid])).digest("hex");
}

function validateTarget(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("invalid order URL"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash || value.length > 2048) throw new Error("invalid order URL");
}

type StoredCredential = { app_id: string; provider_merchant_id: string; platform_key: string; platform_key_id: string; key_nonce: Uint8Array; key_ciphertext: Uint8Array; key_tag: Uint8Array; fee_rate_bps: bigint | number };
type ExistingOrder = { trade_no: string; merchant_id: bigint | number; money_cents: bigint | number; name: string; type_code: string | null; notify_url: string; return_url: string | null; param: string | null; device: string | null; client_id: string | null; request_fingerprint: string | null; credential_id: string | null; fee_rate_bps: bigint | number | null; intent_merchant: bigint | number | null; intent_amount: bigint | number | null; intent_fee: bigint | number | null; intent_app: string | null; intent_provider: string | null; credential_app: string | null; credential_provider: string | null };

function feeFor(amount: number, rawRate: bigint | number): number {
  const rate = Number(rawRate);
  if (!Number.isSafeInteger(rate) || rate < 0 || rate > 5000) throw new Error("invalid merchant fee");
  return Number((BigInt(amount) * BigInt(rate) + 5000n) / 10000n);
}

function matchesExisting(stored: ExistingOrder, order: EPayOrderRequest, requestFingerprint: string): boolean {
  const sameRequest = stored.client_id === order.siteClientId && stored.request_fingerprint === requestFingerprint && stored.credential_id !== null
    && Number(stored.merchant_id) === order.merchantId && Number(stored.money_cents) === order.amountCents
    && stored.name === order.name && stored.type_code === order.type && stored.notify_url === order.notifyUrl
    && stored.return_url === (order.returnUrl || null) && stored.param === (order.param || null) && stored.device === order.device;
  const sameIntent = stored.intent_merchant !== null && Number(stored.intent_merchant) === order.merchantId
    && stored.intent_amount !== null && Number(stored.intent_amount) === order.amountCents
    && stored.fee_rate_bps !== null && stored.intent_fee !== null && Number(stored.intent_fee) === feeFor(order.amountCents, stored.fee_rate_bps)
    && !!stored.intent_app && stored.intent_app === stored.credential_app
    && !!stored.intent_provider && stored.intent_provider === stored.credential_provider;
  return sameRequest && sameIntent;
}

// Credential selection is an internal routing decision, never an EPay request parameter.
// This persists an exact-amount intent only; it does not contact a payment provider.
export function createExactWechatOrder(database: Pick<AppDatabase, "write" | "instanceId">, masterKey: Uint8Array, params: Readonly<Record<string, string>>, mode: "page" | "api", credentialId: string, now: number) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(credentialId) || !Number.isSafeInteger(now) || now < 0) throw new Error("invalid exact order configuration");
  const cipher = new RuntimeSecretCipher(masterKey, database.instanceId());
  return withAuthenticatedOrder(database, masterKey, params, mode, (db, order) => {
    if (order.type !== "wxpay" || order.device !== "pc" || order.openid || order.param.length > 1024 || /[\x00-\x1f\x7f]/.test(order.param)) throw new Error("unsupported exact WeChat order");
    validateTarget(order.notifyUrl);
    try {
      const callback = new URL(order.notifyUrl);
      assertCallbackQueryIsUnambiguous(callback);
      new NodeWebhookTransport(callback.origin).validateTarget(order.notifyUrl);
    } catch (cause) {
      throw new Error("invalid callback URL", { cause });
    }
    if (order.returnUrl) {
      validateTarget(order.returnUrl);
      assertCallbackQueryIsUnambiguous(new URL(order.returnUrl));
    }
    const requestFingerprint = exactWechatFingerprint(order);
    const existing = db.prepare(`SELECT o.trade_no,o.merchant_id,o.money_cents,o.name,o.type_code,o.notify_url,o.return_url,o.param,o.device,r.client_id,r.request_fingerprint,r.credential_id,r.fee_rate_bps,i.merchant_id AS intent_merchant,i.amount_cents AS intent_amount,i.fee_cents AS intent_fee,i.app_id AS intent_app,i.provider_merchant_id AS intent_provider,c.app_id AS credential_app,c.provider_merchant_id AS credential_provider
      FROM epay_orders o LEFT JOIN epay_exact_order_requests r ON r.trade_no=o.trade_no LEFT JOIN epay_wechat_intents i ON i.trade_no=o.trade_no
      LEFT JOIN epay_wechat_credentials c ON c.credential_id=r.credential_id
      WHERE o.merchant_id=? AND o.out_trade_no=?`).get(order.merchantId, order.merchantOrderNo) as ExistingOrder | undefined;
    if (existing) {
      if (!existing.credential_id || !matchesExisting(existing, order, requestFingerprint)) throw new Error("merchant order conflict");
      return { tradeNo: existing.trade_no, credentialId: existing.credential_id, created: false as const };
    }
    const credential = db.prepare(`SELECT c.app_id,c.provider_merchant_id,c.platform_key,c.platform_key_id,c.key_nonce,c.key_ciphertext,c.key_tag,m.fee_rate_bps
      FROM epay_wechat_credentials c JOIN epay_wechat_site_bindings b ON b.app_id=c.app_id AND b.provider_merchant_id=c.provider_merchant_id
      JOIN epay_site_bindings s ON s.client_id=b.client_id JOIN epay_merchant_accounts m ON m.merchant_id=s.merchant_id AND m.enabled=1
      LEFT JOIN epay_wechat_credential_revocations r ON r.credential_id=c.credential_id
      WHERE c.credential_id=? AND b.client_id=? AND s.merchant_id=? AND c.valid_from<=? AND c.valid_until>? AND c.created_at<=? AND r.credential_id IS NULL`).get(credentialId, order.siteClientId, order.merchantId, now, now, now) as StoredCredential | undefined;
    if (!credential) throw new Error("WeChat channel is unavailable for this site");
    validateWechatNativeFields({ appId: credential.app_id, providerMerchantId: credential.provider_merchant_id, name: order.name });
    const feeRate = Number(credential.fee_rate_bps);
    const fee = feeFor(order.amountCents, feeRate);
    // Keep the provider-facing order number within the WeChat 32-character limit.
    const tradeNo = randomUUID().replaceAll("-", "");
    const key = cipher.decrypt(`epay:config:wechat-credential:${credentialId}`, 1, { cipherVersion: 1, nonce: Buffer.from(credential.key_nonce), ciphertext: Buffer.from(credential.key_ciphertext), authenticationTag: Buffer.from(credential.key_tag) });
    let sealed: ReturnType<RuntimeSecretCipher["encrypt"]>;
    try { sealed = cipher.encrypt(`epay:config:wechat-intent:${tradeNo}`, 1, key); } finally { key.fill(0); }
    db.prepare(`INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,type_code,name,money_cents,notify_url,return_url,param,device,status,notify_status,notify_count,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'PENDING','PENDING',0,?,?)`).run(tradeNo, order.merchantOrderNo, order.merchantId, order.type, order.name, order.amountCents, order.notifyUrl, order.returnUrl || null, order.param || null, order.device, now, now);
    db.prepare("INSERT INTO epay_wechat_intents(trade_no,merchant_id,app_id,provider_merchant_id,platform_key,platform_key_id,key_nonce,key_ciphertext,key_tag,amount_cents,fee_cents,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(tradeNo, order.merchantId, credential.app_id, credential.provider_merchant_id, credential.platform_key, credential.platform_key_id, sealed.nonce, sealed.ciphertext, sealed.authenticationTag, order.amountCents, fee, now);
    db.prepare("INSERT INTO epay_exact_order_requests(trade_no,client_id,request_fingerprint,credential_id,fee_rate_bps,created_at) VALUES (?,?,?,?,?,?)").run(tradeNo, order.siteClientId, requestFingerprint, credentialId, feeRate, now);
    pinOrderSigningKey(db, order.merchantId, tradeNo);
    return { tradeNo, credentialId, created: true as const };
  });
}
