import { createHash, createPrivateKey, createPublicKey, sign, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AppDatabase } from "../database/database.ts";
import { appendAuditEvent } from "../database/identity-store.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { verifyWechatMasterKeyGuard } from "./wechat-master-key.ts";

type SigningKeyInput = {
  id: string; appId: string; merchantId: string; serial: string;
  privateKey: string; publicKey: string; validFrom: number; validUntil: number; actor: string;
};
type SigningKeyRow = { merchant_serial: string; public_fingerprint: string; nonce: Uint8Array; ciphertext: Uint8Array; authentication_tag: Uint8Array };
const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
const identityPattern = /^[A-Za-z0-9_-]{1,128}$/;
const validTime = (value: number) => Number.isSafeInteger(value) && value >= 0;
const validText = (value: string, max: number) => typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
const keyName = (id: string): `epay:config:${string}` => `epay:config:wechat-signing:${id}`;
const fingerprint = (spki: Buffer) => createHash("sha256").update(spki).digest("hex");

// The caller must authenticate the administrator and independently establish certificate provenance.
export function registerWechatSigningKey(database: Pick<AppDatabase, "write" | "instanceId">, masterKey: Uint8Array, input: SigningKeyInput, now: number): void {
  if (!idPattern.test(input.id) || !identityPattern.test(input.appId) || !/^[A-Za-z0-9_-]{1,32}$/.test(input.merchantId) || !identityPattern.test(input.serial) || !validText(input.actor, 128) || !validTime(input.validFrom) || !validTime(input.validUntil) || input.validUntil <= input.validFrom || !validTime(now) || typeof input.privateKey !== "string" || input.privateKey.length > 8192 || typeof input.publicKey !== "string" || input.publicKey.length > 8192) throw new Error("invalid WeChat signing key registration");
  const privateKey = createPrivateKey(input.privateKey);
  const publicKey = createPublicKey(input.publicKey);
  if (privateKey.asymmetricKeyType !== "rsa" || (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 || publicKey.asymmetricKeyType !== "rsa") throw new Error("invalid WeChat merchant signing key");
  const actual = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const expected = publicKey.export({ type: "spki", format: "der" });
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("WeChat signing key pair mismatch");
  const cipher = new RuntimeSecretCipher(masterKey, database.instanceId());
  const der = privateKey.export({ type: "pkcs8", format: "der" });
  try {
    const sealed = cipher.encrypt(keyName(input.id), 1, der);
    database.write((db) => {
      verifyWechatMasterKeyGuard(db, cipher);
      db.prepare(`INSERT INTO epay_wechat_signing_keys(key_id,app_id,provider_merchant_id,merchant_serial,public_fingerprint,nonce,ciphertext,authentication_tag,valid_from,valid_until,created_at,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(input.id, input.appId, input.merchantId, input.serial, fingerprint(actual), sealed.nonce, sealed.ciphertext, sealed.authenticationTag, input.validFrom, input.validUntil, now, input.actor);
      appendAuditEvent(db, { occurredAt: now, actorType: "ADMIN", actorId: input.actor, action: "epay.wechat_signing_key.registered", outcome: "SUCCESS", subjectType: "wechat_signing_key", subjectId: input.id });
    });
  } finally { der.fill(0); }
}

export function revokeWechatSigningKey(database: Pick<AppDatabase, "write">, id: string, actor: string, reason: string, now: number): void {
  if (!idPattern.test(id) || !validText(actor, 128) || !validText(reason, 512) || !validTime(now)) throw new Error("invalid WeChat signing key revocation");
  database.write((db) => {
    const inserted = db.prepare("INSERT INTO epay_wechat_signing_key_revocations(key_id,revoked_at,revoked_by,reason) SELECT key_id,?,?,? FROM epay_wechat_signing_keys WHERE key_id=? AND created_at<=?").run(now, actor, reason, id, now);
    if (Number(inserted.changes) !== 1) throw new Error("WeChat signing key not found or revocation predates registration");
    appendAuditEvent(db, { occurredAt: now, actorType: "ADMIN", actorId: actor, action: "epay.wechat_signing_key.revoked", outcome: "SUCCESS", subjectType: "wechat_signing_key", subjectId: id });
  });
}

export function activeWechatSigningKey(db: DatabaseSync, id: string, appId: string, merchantId: string, now: number): SigningKeyRow {
  if (!idPattern.test(id) || !validTime(now)) throw new Error("invalid WeChat signing key reference");
  const row = db.prepare(`SELECT k.merchant_serial,k.public_fingerprint,k.nonce,k.ciphertext,k.authentication_tag FROM epay_wechat_signing_keys k
    LEFT JOIN epay_wechat_signing_key_revocations r ON r.key_id=k.key_id
    WHERE k.key_id=? AND k.app_id=? AND k.provider_merchant_id=? AND k.valid_from<=? AND k.valid_until>? AND k.created_at<=? AND r.key_id IS NULL`).get(id, appId, merchantId, now, now, now) as SigningKeyRow | undefined;
  if (!row) throw new Error("WeChat signing key unavailable or identity mismatch");
  return row;
}

export function signWechatRequest(db: DatabaseSync, cipher: RuntimeSecretCipher, id: string, appId: string, merchantId: string, now: number, message: string): { serial: string; signature: string } {
  const row = activeWechatSigningKey(db, id, appId, merchantId, now);
  const der = cipher.decrypt(keyName(id), 1, { cipherVersion: 1, nonce: Buffer.from(row.nonce), ciphertext: Buffer.from(row.ciphertext), authenticationTag: Buffer.from(row.authentication_tag) });
  try {
    const key = createPrivateKey({ key: der, type: "pkcs8", format: "der" });
    const spki = createPublicKey(key).export({ type: "spki", format: "der" });
    if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 || fingerprint(spki) !== row.public_fingerprint) throw new Error("WeChat signing key fingerprint mismatch");
    return { serial: row.merchant_serial, signature: sign("RSA-SHA256", Buffer.from(message), key).toString("base64") };
  } finally { der.fill(0); }
}
