import { createHash, createPrivateKey, createPublicKey, X509Certificate, type KeyObject } from "node:crypto";

export interface ConfiguredAlipayIdentity {
  readonly appId: string;
  readonly merchantId: string;
  readonly privateKey: string;
  readonly platformPublicKey: string;
  readonly applicationCertificate: string;
}

export interface ConfiguredWechatIdentity {
  readonly appId: string;
  readonly merchantId: string;
  readonly privateKey: string;
  readonly platformPublicKey: string;
  readonly platformPublicKeyId: string;
}

export function channelFields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("channel configuration must be an object");
  return value as Record<string, unknown>;
}

export function channelText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 16_384) throw new Error("channel configuration field is missing");
  return value.trim();
}

export function normalizeChannelPem(value: string, kind: "PRIVATE KEY" | "PUBLIC KEY"): string {
  const text = channelText(value);
  if (text.startsWith("-----BEGIN")) return text;
  const base64 = text.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error("invalid channel key encoding");
  return `-----BEGIN ${kind}-----\n${base64.match(/.{1,64}/g)!.join("\n")}\n-----END ${kind}-----`;
}

function privateKey(value: string): KeyObject {
  const key = createPrivateKey(normalizeChannelPem(value, "PRIVATE KEY"));
  if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error("channel signing key must be RSA 2048 or stronger");
  return key;
}

function publicKey(value: string): KeyObject {
  const key = createPublicKey(normalizeChannelPem(value, "PUBLIC KEY"));
  if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error("channel platform key must be RSA 2048 or stronger");
  return key;
}

const der = (key: KeyObject) => (key.type === "private" ? createPublicKey(key) : key).export({ type: "spki", format: "der" });
const fingerprint = (key: KeyObject) => createHash("sha256").update(der(key)).digest("hex");

// The main configuration and certificate must come from the trusted host, never a merchant request.
export function verifyConfiguredAlipayIdentity(channel: unknown, main: ConfiguredAlipayIdentity, now: number) {
  const fields = channelFields(channel);
  if (!Number.isSafeInteger(now) || now < 0 || !/^2088\d{12}$/.test(main.merchantId) || !/^\d{16}$/.test(main.appId)) throw new Error("invalid configured Alipay identity");
  if (fields.appId !== main.appId || (fields.sellerId !== undefined && fields.sellerId !== main.merchantId)) throw new Error("Alipay configured identity mismatch");
  const signing = privateKey(channelText(fields.privateKey));
  const platform = publicKey(channelText(fields.alipayPublicKey));
  if (!der(signing).equals(der(privateKey(main.privateKey))) || !der(platform).equals(der(publicKey(main.platformPublicKey)))) throw new Error("Alipay configured keys mismatch");
  const certificate = new X509Certificate(main.applicationCertificate);
  const commonName = certificate.toLegacyObject().subject.CN;
  const pids = typeof commonName === "string" ? commonName.match(/\b2088\d{12}\b/g) : null;
  if (pids?.length !== 1 || pids[0] !== main.merchantId || !der(certificate.publicKey).equals(der(signing))) throw new Error("Alipay certificate account or key mismatch");
  if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) throw new Error("Alipay application certificate is outside its validity window");
  return {
    appId: main.appId, sellerId: main.merchantId,
    privateKey: signing.export({ type: "pkcs8", format: "pem" }).toString(),
    platformPublicKey: platform.export({ type: "spki", format: "pem" }).toString(),
    signingFingerprint: fingerprint(signing),
    certificateSha256: createHash("sha256").update(certificate.raw).digest("hex"),
    certificateValidUntil: Date.parse(certificate.validTo),
  };
}

export function verifyConfiguredWechatIdentity(channel: unknown, main: ConfiguredWechatIdentity) {
  const fields = channelFields(channel);
  if (fields.appId !== main.appId || fields.mchId !== main.merchantId || fields.platformPublicKeyId !== main.platformPublicKeyId) throw new Error("WeChat configured identity mismatch");
  const signing = privateKey(channelText(fields.merchantPrivateKey));
  const platform = publicKey(channelText(fields.platformPublicKey));
  if (!der(signing).equals(der(privateKey(main.privateKey))) || !der(platform).equals(der(publicKey(main.platformPublicKey)))) throw new Error("WeChat configured keys mismatch");
  const apiV3Key = channelText(fields.apiV3Key);
  if (Buffer.byteLength(apiV3Key) !== 32) throw new Error("invalid WeChat API v3 key");
  const serial = channelText(fields.merchantSerialNo);
  if (!/^[0-9A-Fa-f]{16,64}$/.test(serial)) throw new Error("invalid WeChat merchant certificate serial");
  return {
    appId: main.appId, merchantId: main.merchantId, apiV3Key, serial,
    platformKeyId: main.platformPublicKeyId,
    privateKey: signing.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: createPublicKey(signing).export({ type: "spki", format: "pem" }).toString(),
    platformKey: platform.export({ type: "spki", format: "pem" }).toString(),
  };
}
