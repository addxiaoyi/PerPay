import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { RuntimeSecretCipher } from "../settings/crypto.ts";
import { verifyWechatMasterKeyGuard } from "./wechat-master-key.ts";

// This archive is evidence only and is never used to replay historical jobs.
export const EPAY_MAIN_PAYMENT_ARCHIVE_SCHEMA_SQL = `
  CREATE TABLE epay_main_payment_archive (
    singleton_key INTEGER PRIMARY KEY CHECK(singleton_key=1),
    nonce BLOB NOT NULL CHECK(length(nonce)=12),
    ciphertext BLOB NOT NULL CHECK(length(ciphertext)>0),
    authentication_tag BLOB NOT NULL CHECK(length(authentication_tag)=16)
  ) STRICT;
  CREATE TRIGGER epay_main_payment_archive_no_update BEFORE UPDATE ON epay_main_payment_archive BEGIN SELECT RAISE(ABORT,'payment archive is immutable'); END;
  CREATE TRIGGER epay_main_payment_archive_no_delete BEFORE DELETE ON epay_main_payment_archive BEGIN SELECT RAISE(ABORT,'payment archive is immutable'); END;
`;

const ARCHIVE_NAME = "epay:config:main-payment-archive";

export function readMainPaymentArchive(db: DatabaseSync, cipher: RuntimeSecretCipher): string | null {
  const row = db.prepare("SELECT nonce,ciphertext,authentication_tag FROM epay_main_payment_archive WHERE singleton_key=1").get() as { nonce: Uint8Array; ciphertext: Uint8Array; authentication_tag: Uint8Array } | undefined;
  if (!row) return null;
  const plain = cipher.decrypt(ARCHIVE_NAME, 1, { cipherVersion: 1, nonce: Buffer.from(row.nonce), ciphertext: Buffer.from(row.ciphertext), authenticationTag: Buffer.from(row.authentication_tag) });
  try { return plain.toString("utf8"); } finally { plain.fill(0); }
}

export function preserveMainPaymentArchive(db: DatabaseSync, cipher: RuntimeSecretCipher, payment: unknown): void {
  if (!db.isTransaction) throw new Error("payment archive requires a transaction");
  verifyWechatMasterKeyGuard(db, cipher);
  if (!payment || typeof payment !== "object" || Array.isArray(payment)) throw new Error("invalid payment archive source");
  if (db.prepare("SELECT 1 FROM epay_main_payment_archive").get()) throw new Error("payment archive already exists");
  const raw = JSON.stringify(payment);
  if (!isDeepStrictEqual(JSON.parse(raw), payment)) throw new Error("payment archive source is not lossless JSON");
  db.exec("SAVEPOINT main_payment_archive");
  try {
    const sealed = cipher.encrypt(ARCHIVE_NAME, 1, raw);
    db.prepare("INSERT INTO epay_main_payment_archive VALUES(1,?,?,?)").run(sealed.nonce, sealed.ciphertext, sealed.authenticationTag);
    if (readMainPaymentArchive(db, cipher) !== raw) throw new Error("payment archive verification failed");
    db.exec("RELEASE SAVEPOINT main_payment_archive");
  } catch (error) {
    db.exec("ROLLBACK TO SAVEPOINT main_payment_archive; RELEASE SAVEPOINT main_payment_archive");
    throw error;
  }
}
