import { createHash, timingSafeEqual } from "node:crypto";
import { TextDecoder } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import type { AppDatabase } from "../database/database.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";

type SecretRow = {
  secret_version: bigint | number;
  cipher_version: bigint | number;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  authentication_tag: Uint8Array;
  secret_fingerprint: string;
};

export function createMerchantSecretReader(database: Pick<AppDatabase, "read" | "instanceId">, masterKey: Uint8Array): (merchantId: number, tradeNo?: string) => string {
  const cipher = new RuntimeSecretCipher(masterKey, database.instanceId());
  return (merchantId, tradeNo) => database.read((db) => tradeNo ? readOrderSigningSecret(db, cipher, merchantId, tradeNo) : readMerchantSecret(db, cipher, merchantId));
}

export function preserveMerchantKey(db: DatabaseSync, merchantId: number) {
  if (!db.isTransaction) throw new Error("merchant key history requires a transaction");
  db.prepare(`INSERT OR IGNORE INTO epay_merchant_key_versions SELECT merchant_id,secret_version,cipher_version,nonce,ciphertext,authentication_tag,secret_fingerprint,updated_at
    FROM epay_merchant_secrets WHERE merchant_id=?`).run(merchantId);
  if (!db.prepare(`SELECT 1 FROM epay_merchant_secrets s JOIN epay_merchant_key_versions k ON k.merchant_id=s.merchant_id AND k.secret_version=s.secret_version
    WHERE s.merchant_id=? AND k.cipher_version=s.cipher_version AND k.nonce=s.nonce AND k.ciphertext=s.ciphertext AND k.authentication_tag=s.authentication_tag AND k.secret_fingerprint=s.secret_fingerprint`).get(merchantId)) throw new Error("merchant key history differs from active version");
}

export function pinOrderSigningKey(db: DatabaseSync, merchantId: number, tradeNo: string) {
  preserveMerchantKey(db, merchantId);
  db.prepare("INSERT INTO epay_order_key_versions SELECT ?,merchant_id,secret_version FROM epay_merchant_secrets WHERE merchant_id=?").run(tradeNo, merchantId);
}

export function readOrderSigningSecret(db: DatabaseSync, cipher: RuntimeSecretCipher, merchantId: number, tradeNo: string): string {
  const supportsVersions = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='epay_order_key_versions'").get();
  const row = supportsVersions ? db.prepare(`SELECT k.* FROM epay_order_key_versions o JOIN epay_merchant_key_versions k
    ON k.merchant_id=o.merchant_id AND k.secret_version=o.secret_version WHERE o.trade_no=? AND o.merchant_id=?`).get(tradeNo, merchantId) as SecretRow | undefined : undefined;
  if (row) return decryptMerchantKey(cipher, merchantId, row);
  const current = db.prepare("SELECT secret_version FROM epay_merchant_secrets WHERE merchant_id=?").get(merchantId);
  if (Number(current?.secret_version) !== 1) throw new Error("order signing key version is missing");
  return readMerchantSecret(db, cipher, merchantId);
}

export function readMerchantSecret(db: DatabaseSync, cipher: RuntimeSecretCipher, merchantId: number): string {
    if (!Number.isSafeInteger(merchantId) || merchantId < 1) throw new Error("invalid merchant ID");
    const row = db.prepare(`SELECT secret_version, cipher_version, nonce, ciphertext, authentication_tag, secret_fingerprint
      FROM epay_merchant_secrets WHERE merchant_id = ?`).get(merchantId) as SecretRow | undefined;
    if (!row) throw new Error("merchant callback key unavailable");
    return decryptMerchantKey(cipher, merchantId, row);
}

function decryptMerchantKey(cipher: RuntimeSecretCipher, merchantId: number, row: SecretRow): string {
    const version = Number(row.secret_version);
    if (!Number.isSafeInteger(version) || version < 1 || Number(row.cipher_version) !== 1 || !/^[0-9a-f]{64}$/.test(row.secret_fingerprint)) throw new Error("merchant callback key invalid");
    let plaintext: Buffer | undefined;
    try {
      plaintext = cipher.decrypt(`epay:merchant:${merchantId}:api_key`, version, {
        cipherVersion: 1,
        nonce: Buffer.from(row.nonce),
        ciphertext: Buffer.from(row.ciphertext),
        authenticationTag: Buffer.from(row.authentication_tag),
      });
      const expected = Buffer.from(row.secret_fingerprint, "hex");
      const actual = createHash("sha256").update(plaintext).digest();
      if (!timingSafeEqual(expected, actual)) throw new Error("fingerprint mismatch");
      const secret = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
      if (!secret) throw new Error("empty key");
      return secret;
    } catch (cause) {
      throw new Error("merchant callback key invalid", { cause });
    } finally {
      plaintext?.fill(0);
    }
}
