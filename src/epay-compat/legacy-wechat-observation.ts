import { createPrivateKey, createSign } from "node:crypto";
import { queryWechatOrderReadonly } from "./wechat-readonly-order-query.ts";

type LegacyChannel = { appId?: unknown; mchId?: unknown; merchantPrivateKey?: unknown; merchantSerialNo?: unknown; platformPublicKey?: unknown; platformCertificate?: unknown; platformPublicKeyId?: unknown; publicKeyId?: unknown; platformCertificateSerialNo?: unknown };

function required(value: unknown): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > 16_384) throw new Error("invalid legacy WeChat channel configuration");
  return value;
}

function keyText(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid legacy WeChat channel configuration");
  return required(value.trim());
}

// Only call with an authenticated snapshot; this performs a GET and never writes local state.
export async function observeLegacyWechatPayment(options: {
  readonly config: LegacyChannel;
  readonly tradeNo: string;
  readonly providerTradeNo: string;
  readonly amountCents: number;
  readonly transport: typeof fetch;
  readonly clock?: () => number;
}) {
  const config = options.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("invalid legacy WeChat channel configuration");
  const rawKey = keyText(config.merchantPrivateKey);
  const pem = rawKey.includes("BEGIN") ? rawKey : `-----BEGIN PRIVATE KEY-----\n${rawKey.match(/.{1,64}/g)?.join("\n")}\n-----END PRIVATE KEY-----`;
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error("invalid legacy WeChat signing key");
  const serial = required(config.merchantSerialNo);
  const expected = {
    appId: required(config.appId), merchantId: required(config.mchId), tradeNo: options.tradeNo,
    providerTradeNo: options.providerTradeNo, amountCents: options.amountCents,
    platformKey: keyText(config.platformPublicKey || config.platformCertificate),
    platformKeyId: required(config.platformPublicKeyId || config.publicKeyId || config.platformCertificateSerialNo),
  };
  return queryWechatOrderReadonly({ expected, transport: options.transport, ...(options.clock ? { clock: options.clock } : {}),
    sign: message => ({ serial, signature: createSign("RSA-SHA256").update(message).sign(key, "base64") }) });
}
