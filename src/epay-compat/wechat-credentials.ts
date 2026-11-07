import { createPublicKey, X509Certificate } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AppDatabase } from "../database/database.ts";
import { appendAuditEvent } from "../database/identity-store.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { confirmWechatInTransaction } from "./confirm-wechat.ts";
import { observeWechatQuery, resolveWechatNotification, type WechatCredential } from "./wechat-evidence.ts";
import { activeWechatSigningKey } from "./wechat-signing-keys.ts";
import { verifyWechatMasterKeyGuard } from "./wechat-master-key.ts";
export { verifyWechatMasterKeyGuard } from "./wechat-master-key.ts";

interface CredentialInput extends WechatCredential {
  readonly id: string;
  readonly validFrom: number;
  readonly validUntil: number;
  readonly actor: string;
}

type CredentialRow = { credential_id: string; app_id: string; provider_merchant_id: string; platform_key: string; platform_key_id: string; key_nonce: Uint8Array; key_ciphertext: Uint8Array; key_tag: Uint8Array };

function text(value: string, max: number): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
}

function credentialName(id: string): `epay:config:${string}` {
  return `epay:config:wechat-credential:${id}`;
}

// Callers must enforce administrator authorization and supply a verified actor.
export function registerWechatCredential(database: Pick<AppDatabase, "write" | "instanceId">, masterKey: Uint8Array, input: CredentialInput, now: number): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.id) || !text(input.appId, 128) || !text(input.merchantId, 128) || !text(input.platformKeyId, 128) || !text(input.actor, 128) || Buffer.byteLength(input.apiV3Key) !== 32 || !Number.isSafeInteger(input.validFrom) || input.validFrom < 0 || !Number.isSafeInteger(input.validUntil) || input.validUntil <= input.validFrom || !Number.isSafeInteger(now) || now < 0 || input.platformKey.length > 8192) throw new Error("invalid WeChat credential registration");
  const isCertificate = input.platformKey.startsWith("-----BEGIN CERTIFICATE-----");
  if (!isCertificate && !input.platformKey.startsWith("-----BEGIN PUBLIC KEY-----")) throw new Error("invalid WeChat platform public key");
  const certificate = isCertificate ? new X509Certificate(input.platformKey) : null;
  if (certificate) {
    const notBefore = Date.parse(certificate.validFrom), notAfter = Date.parse(certificate.validTo);
    if (!/^[0-9A-F]+$/.test(input.platformKeyId) || input.platformKeyId !== certificate.serialNumber || !Number.isSafeInteger(notBefore) || !Number.isSafeInteger(notAfter) || input.validFrom < notBefore || input.validUntil > notAfter) throw new Error("WeChat certificate serial or validity mismatch");
  }
  const key = certificate?.publicKey ?? createPublicKey(input.platformKey);
  if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error("invalid WeChat platform public key");
  const cipher = new RuntimeSecretCipher(masterKey, database.instanceId());
  const sealed = cipher.encrypt(credentialName(input.id), 1, input.apiV3Key);
  database.write((db) => {
    verifyWechatMasterKeyGuard(db, cipher);
    db.prepare(`INSERT INTO epay_wechat_credentials(credential_id,app_id,provider_merchant_id,platform_key,platform_key_id,key_nonce,key_ciphertext,key_tag,valid_from,valid_until,created_at,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.id, input.appId, input.merchantId, input.platformKey, input.platformKeyId, sealed.nonce, sealed.ciphertext, sealed.authenticationTag, input.validFrom, input.validUntil, now, input.actor);
    appendAuditEvent(db, { occurredAt: now, actorType: "ADMIN", actorId: input.actor, action: "epay.wechat_credential.registered", outcome: "SUCCESS", subjectType: "wechat_credential", subjectId: input.id });
  });
}

export function revokeWechatCredential(database: Pick<AppDatabase, "write">, id: string, actor: string, reason: string, now: number): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !text(actor, 128) || !text(reason, 512) || !Number.isSafeInteger(now) || now < 0) throw new Error("invalid WeChat credential revocation");
  database.write((db) => {
    const changed = db.prepare("INSERT INTO epay_wechat_credential_revocations(credential_id,revoked_at,revoked_by,reason) SELECT credential_id,?,?,? FROM epay_wechat_credentials WHERE credential_id=? AND created_at<=?").run(now, actor, reason, id, now);
    if (Number(changed.changes) !== 1) throw new Error("WeChat credential not found or revocation predates registration");
    appendAuditEvent(db, { occurredAt: now, actorType: "ADMIN", actorId: actor, action: "epay.wechat_credential.revoked", outcome: "SUCCESS", subjectType: "wechat_credential", subjectId: id });
  });
}

function activeCredentials(db: DatabaseSync, cipher: RuntimeSecretCipher, serial: string, now: number): Array<WechatCredential & { id: string }> {
  const rows = db.prepare(`SELECT c.credential_id,c.app_id,c.provider_merchant_id,c.platform_key,c.platform_key_id,c.key_nonce,c.key_ciphertext,c.key_tag
    FROM epay_wechat_credentials c LEFT JOIN epay_wechat_credential_revocations r ON r.credential_id=c.credential_id
    WHERE c.platform_key_id=? AND c.valid_from<=? AND c.valid_until>? AND c.created_at<=? AND r.credential_id IS NULL LIMIT 17`).all(serial, now, now, now) as CredentialRow[];
  if (rows.length > 16) throw new Error("too many active WeChat credentials for serial");
  return rows.map((row) => {
    const key = cipher.decrypt(credentialName(row.credential_id), 1, { cipherVersion: 1, nonce: Buffer.from(row.key_nonce), ciphertext: Buffer.from(row.key_ciphertext), authenticationTag: Buffer.from(row.key_tag) });
    try {
      return { id: row.credential_id, appId: row.app_id, merchantId: row.provider_merchant_id, platformKey: row.platform_key, platformKeyId: row.platform_key_id, apiV3Key: key.toString("utf8") };
    } finally { key.fill(0); }
  });
}

// The registry lookup and confirmation share one transaction so revocation cannot race settlement.
export function confirmRegisteredWechatNotification(database: Pick<AppDatabase, "write" | "instanceId">, masterKey: Uint8Array, rawBody: Uint8Array, headers: Headers, now: number) {
  const serial = headers.get("wechatpay-serial") ?? "";
  if (!text(serial, 128) || !Number.isSafeInteger(now) || now < 0 || rawBody.byteLength > 1024 * 1024) throw new Error("invalid WeChat notification");
  const cipher = new RuntimeSecretCipher(masterKey, database.instanceId());
  return database.write((db) => {
    verifyWechatMasterKeyGuard(db, cipher);
    const credentials = activeCredentials(db, cipher, serial, now);
    const match = resolveWechatNotification(rawBody, headers, credentials, now);
    return confirmWechatInTransaction(db, cipher, match.tradeNo, rawBody, headers, now, match.credential.id);
  });
}

// The caller must provide the HTTP status and credential selected by its trusted query transport.
export function confirmRegisteredWechatQuery(database: Pick<AppDatabase, "write" | "instanceId">, masterKey: Uint8Array, tradeNo: string, credentialId: string, httpStatus: number, rawBody: Uint8Array, headers: Headers, now: number, signingKeyId?: string) {
  if (httpStatus !== 200 || !/^[A-Za-z0-9_-]{1,64}$/.test(credentialId) || !tradeNo || tradeNo.length > 64 || !Number.isSafeInteger(now) || now < 0 || rawBody.byteLength > 1024 * 1024) throw new Error("invalid WeChat query response");
  const cipher = new RuntimeSecretCipher(masterKey, database.instanceId());
  return database.write((db) => {
    verifyWechatMasterKeyGuard(db, cipher);
    if (signingKeyId !== undefined) {
      const intent = db.prepare("SELECT app_id,provider_merchant_id FROM epay_wechat_intents WHERE trade_no=?").get(tradeNo) as { app_id: string; provider_merchant_id: string } | undefined;
      if (!intent) throw new Error("WeChat query order identity mismatch");
      activeWechatSigningKey(db, signingKeyId, intent.app_id, intent.provider_merchant_id, now);
    }
    return confirmWechatInTransaction(db, cipher, tradeNo, rawBody, headers, now, credentialId, "query");
  });
}

export function observeAndConfirmRegisteredWechatQuery(database: Pick<AppDatabase, "write" | "instanceId">, masterKey: Uint8Array, tradeNo: string, credentialId: string, rawBody: Uint8Array, headers: Headers, now: number, signingKeyId: string) {
  const cipher = new RuntimeSecretCipher(masterKey, database.instanceId());
  return database.write(db => {
    verifyWechatMasterKeyGuard(db, cipher);
    const identity = db.prepare(`SELECT i.app_id,i.provider_merchant_id,i.amount_cents,c.platform_key,c.platform_key_id
      FROM epay_wechat_intents i JOIN epay_wechat_credentials c ON c.app_id=i.app_id AND c.provider_merchant_id=i.provider_merchant_id
      LEFT JOIN epay_wechat_credential_revocations r ON r.credential_id=c.credential_id
      WHERE i.trade_no=? AND c.credential_id=? AND c.valid_from<=? AND c.valid_until>? AND c.created_at<=? AND r.credential_id IS NULL`)
      .get(tradeNo, credentialId, now, now, now);
    if (!identity) throw new Error("WeChat query credential identity changed");
    activeWechatSigningKey(db, signingKeyId, String(identity.app_id), String(identity.provider_merchant_id), now);
    const observation = observeWechatQuery(rawBody, headers, { appId: String(identity.app_id), merchantId: String(identity.provider_merchant_id), tradeNo, amountCents: Number(identity.amount_cents), platformKey: String(identity.platform_key), platformKeyId: String(identity.platform_key_id), now });
    if (observation.state !== "SUCCESS") return { paymentConfirmed: false as const, tradeStatus: observation.state };
    return { paymentConfirmed: true as const, ...confirmWechatInTransaction(db, cipher, tradeNo, rawBody, headers, now, credentialId, "query"), tradeStatus: observation.state };
  });
}
