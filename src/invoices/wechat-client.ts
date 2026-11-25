import { constants, createPublicKey, publicEncrypt, randomBytes, X509Certificate } from "node:crypto";
import type { RuntimeSecretCipher } from "../settings/crypto.ts";
import { parseStrictJson } from "../http/strict-json.ts";
import { readBoundedBody } from "../epay-compat/main-order-auth.ts";
import { verifyWechatSignature } from "../epay-compat/wechat-evidence.ts";
import { signWechatRequest } from "../epay-compat/wechat-signing-keys.ts";
import { verifyWechatMasterKeyGuard } from "../epay-compat/wechat-master-key.ts";
import type { InvoiceDatabase } from "./model.ts";

export type WechatInvoiceOptions = {
  database: InvoiceDatabase; cipher: RuntimeSecretCipher; appId: string; merchantId: string;
  credentialId: string; signingKeyId: string; transport: typeof fetch; clock?: () => number;
};

export function invoiceFields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid WeChat invoice response");
  return value as Record<string, unknown>;
}

export function createWechatInvoiceClient(options: WechatInvoiceOptions) {
  const clock = options.clock ?? Date.now;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(options.appId) || !/^\d{6,32}$/.test(options.merchantId)) throw new Error("invalid invoice provider identity");
  const credential = () => options.database.read(sql => {
    verifyWechatMasterKeyGuard(sql, options.cipher);
    const now = clock();
    const row = sql.prepare(`SELECT c.platform_key,c.platform_key_id FROM epay_wechat_credentials c
      LEFT JOIN epay_wechat_credential_revocations r ON r.credential_id=c.credential_id
      WHERE c.credential_id=? AND c.app_id=? AND c.provider_merchant_id=? AND c.valid_from<=? AND c.valid_until>?
        AND c.created_at<=? AND r.credential_id IS NULL`).get(options.credentialId, options.appId, options.merchantId, now, now, now);
    if (!row) throw new Error("WeChat invoice credential unavailable");
    return { platformKey: String(row.platform_key), platformKeyId: String(row.platform_key_id) };
  });
  return {
    encrypt(value: string) {
      const current = credential(), key = current.platformKey.includes("BEGIN CERTIFICATE")
        ? new X509Certificate(current.platformKey).publicKey : createPublicKey(current.platformKey);
      return publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" }, Buffer.from(value)).toString("base64");
    },
    async request(method: "GET" | "POST", path: string, fields?: Record<string, unknown>, signal?: AbortSignal) {
      const url = new URL(path, "https://api.mch.weixin.qq.com");
      if (url.origin !== "https://api.mch.weixin.qq.com" || !url.pathname.startsWith("/v3/new-tax-control-fapiao/") || url.hash || url.username || url.password)
        throw new Error("invalid WeChat invoice path");
      const started = clock(), timestamp = String(Math.floor(started / 1000)), nonce = randomBytes(16).toString("hex"), body = fields ? JSON.stringify(fields) : "";
      const key = credential(), signed = options.database.read(sql => signWechatRequest(sql, options.cipher, options.signingKeyId,
        options.appId, options.merchantId, started, `${method}\n${url.pathname}${url.search}\n${timestamp}\n${nonce}\n${body}\n`));
      const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${options.merchantId}",nonce_str="${nonce}",signature="${signed.signature}",timestamp="${timestamp}",serial_no="${signed.serial}"`;
      const response = await options.transport(url, { method, headers: { accept: "application/json", "content-type": "application/json",
        authorization, "wechatpay-serial": key.platformKeyId }, ...(body ? { body } : {}),
        redirect: "error", cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
      const bytes = await readBoundedBody(response.body, 1024 * 1024), observedAt = clock();
      if (observedAt < started) throw new Error("WeChat invoice clock regressed");
      // An HTTP success alone cannot establish issuance; even an empty 202 response must be authenticated.
      verifyWechatSignature(bytes, response.headers, credential(), observedAt);
      return { status: response.status, fields: bytes.length ? invoiceFields(parseStrictJson(bytes)) : {}, observedAt, startedAt: started };
    },
  };
}
