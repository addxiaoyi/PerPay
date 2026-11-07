import { createHash, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { RuntimeSecretCipher } from "../settings/crypto.ts";

const DEFAULT_EXPIRATION_MINUTES = 15;

export function expirationMinutes(db: DatabaseSync, cipher: RuntimeSecretCipher): number {
  const value = db.prepare("SELECT config_value FROM epay_config_values WHERE config_key='order_expire_minutes'").get();
  const secret = db.prepare("SELECT secret_version,cipher_version,nonce,ciphertext,authentication_tag,secret_fingerprint FROM epay_config_secrets WHERE config_key='order_expire_minutes'").get();
  if (value && secret) throw new Error("duplicate expiration configuration");
  let raw: string | null = typeof value?.config_value === "string" ? value.config_value : null;
  if (secret) {
    if (Number(secret.secret_version) !== 1 || Number(secret.cipher_version) !== 1 || typeof secret.secret_fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(secret.secret_fingerprint)) throw new Error("invalid expiration configuration");
    const plain = cipher.decrypt("epay:config:order_expire_minutes", 1, { cipherVersion: 1, nonce: Buffer.from(secret.nonce as Uint8Array), ciphertext: Buffer.from(secret.ciphertext as Uint8Array), authenticationTag: Buffer.from(secret.authentication_tag as Uint8Array) });
    try {
      if (!timingSafeEqual(createHash("sha256").update(plain).digest(), Buffer.from(secret.secret_fingerprint, "hex"))) throw new Error("invalid expiration configuration");
      raw = new TextDecoder("utf-8", { fatal: true }).decode(plain);
    } finally { plain.fill(0); }
  }
  if (raw === null) return DEFAULT_EXPIRATION_MINUTES;
  if (!/^(?:\d+)(?:\.\d+)?$/.test(raw)) throw new Error("invalid expiration configuration");
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0 || !Number.isSafeInteger(minutes * 60_000)) throw new Error("invalid expiration configuration");
  return minutes;
}

export function orderAcceptsPayment(createdAt: number | bigint, now: number, minutes: number): boolean {
  const created = Number(createdAt);
  const duration = minutes * 60_000;
  return Number.isSafeInteger(created) && created >= 0 && Number.isSafeInteger(now) && now >= created && Number.isFinite(minutes) && minutes > 0 && Number.isSafeInteger(duration) && now - created < duration;
}
