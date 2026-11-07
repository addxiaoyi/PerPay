import { constants, createDecipheriv, createPublicKey, publicEncrypt, randomBytes, X509Certificate } from "node:crypto";
import type { RuntimeSecretCipher } from "../settings/crypto.ts";
import { parseStrictJson } from "../http/strict-json.ts";
import { readBoundedBody } from "./main-order-auth.ts";
import { verifyWechatSignature, type WechatCredential } from "./wechat-evidence.ts";
import { signWechatRequest } from "./wechat-signing-keys.ts";
import { verifyWechatMasterKeyGuard } from "./wechat-master-key.ts";
import type { PayoutDatabase } from "./payout-model.ts";

export type WechatPayoutClientOptions = { database: PayoutDatabase; cipher: RuntimeSecretCipher; appId: string; payer: string; credentialId: string; signingKeyId: string; transport: typeof fetch; clock?: () => number };
export function wechatFields(bytes: Uint8Array): Record<string, unknown> {
  const value = parseStrictJson(bytes);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid WeChat payout response");
  return value as Record<string, unknown>;
}

export function createWechatPayoutClient(options: WechatPayoutClientOptions) {
  const clock = options.clock ?? Date.now;
  const credential = (): WechatCredential => options.database.read(sql => {
    verifyWechatMasterKeyGuard(sql, options.cipher);
    const now = clock();
    const row = sql.prepare(`SELECT c.* FROM epay_wechat_credentials c LEFT JOIN epay_wechat_credential_revocations r ON r.credential_id=c.credential_id
      WHERE c.credential_id=? AND c.app_id=? AND c.provider_merchant_id=? AND c.valid_from<=? AND c.valid_until>? AND c.created_at<=? AND r.credential_id IS NULL`)
      .get(options.credentialId, options.appId, options.payer, now, now, now);
    if (!row) throw new Error("WeChat payout credential unavailable");
    const secret = options.cipher.decrypt(`epay:config:wechat-credential:${options.credentialId}`, 1, { cipherVersion: 1, nonce: Buffer.from(row.key_nonce as Uint8Array), ciphertext: Buffer.from(row.key_ciphertext as Uint8Array), authenticationTag: Buffer.from(row.key_tag as Uint8Array) });
    try { return { appId: options.appId, merchantId: options.payer, platformKey: String(row.platform_key), platformKeyId: String(row.platform_key_id), apiV3Key: secret.toString("utf8") }; }
    finally { secret.fill(0); }
  });
  return {
    credential,
    encryptName(name: string) {
      const current = credential(), key = current.platformKey.includes("BEGIN CERTIFICATE") ? new X509Certificate(current.platformKey).publicKey : createPublicKey(current.platformKey);
      return publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" }, Buffer.from(name)).toString("base64");
    },
    async request(method: "GET" | "POST", path: string, fields?: Record<string, unknown>, signal?: AbortSignal) {
      if (!/^\/v3\/fund-app\/mch-transfer\/[A-Za-z0-9/_-]+$/.test(path)) throw new Error("invalid WeChat payout path");
      const started = clock(), timestamp = String(Math.floor(started / 1000)), nonce = randomBytes(16).toString("hex"), body = fields ? JSON.stringify(fields) : "";
      const key = credential();
      const signed = options.database.read(sql => signWechatRequest(sql, options.cipher, options.signingKeyId, options.appId, options.payer, started, `${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`));
      const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${options.payer}",nonce_str="${nonce}",signature="${signed.signature}",timestamp="${timestamp}",serial_no="${signed.serial}"`;
      const response = await options.transport(new URL(path, "https://api.mch.weixin.qq.com"), { method, headers: { accept: "application/json", "content-type": "application/json", authorization, "wechatpay-serial": key.platformKeyId },
        ...(body ? { body } : {}), redirect: "error", cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
      const bytes = await readBoundedBody(response.body, 65536), now = clock();
      if (now < started) throw new Error("WeChat payout clock regressed");
      verifyWechatSignature(bytes, response.headers, credential(), now);
      if (response.status !== 200) throw new Error("WeChat payout response requires original-order query");
      return { bytes, headers: response.headers, fields: wechatFields(bytes), now };
    },
    notification(bytes: Uint8Array, headers: Headers) {
      const key = credential(); verifyWechatSignature(bytes, headers, key, clock());
      const envelope = wechatFields(bytes), resource = envelope.resource as Record<string, unknown> | undefined;
      if (!resource || !["MCHTRANSFER.AUTHORIZATION.CONFIRMED", "MCHTRANSFER.AUTHORIZATION.CLOSED"].includes(String(envelope.event_type)) || envelope.resource_type !== "encrypt-resource" || resource.algorithm !== "AEAD_AES_256_GCM" ||
        typeof resource.nonce !== "string" || Buffer.byteLength(resource.nonce) !== 12 || typeof resource.associated_data !== "string" || typeof resource.ciphertext !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(resource.ciphertext)) throw new Error("invalid WeChat authorization notification");
      const encrypted = Buffer.from(resource.ciphertext, "base64");
      if (encrypted.length <= 16) throw new Error("invalid WeChat authorization ciphertext");
      const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key.apiV3Key), Buffer.from(resource.nonce));
      decipher.setAAD(Buffer.from(resource.associated_data)); decipher.setAuthTag(encrypted.subarray(-16));
      const plain = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
      try {
        const fields = wechatFields(plain), state = envelope.event_type === "MCHTRANSFER.AUTHORIZATION.CLOSED" ? "CLOSED" : "TAKING_EFFECT";
        if (fields.state !== state) throw new Error("WeChat authorization event differs");
        return fields;
      } finally { plain.fill(0); }
    },
  };
}
