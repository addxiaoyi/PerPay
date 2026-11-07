import { closeSync, fstatSync, fsyncSync, openSync, readSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { RuntimeSecretCipher, type EncryptedSecret } from "../settings/crypto.ts";

const MAGIC = Buffer.from("EPAYR001", "ascii");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + NONCE_BYTES + TAG_BYTES;
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;

// A partial write stays in place and must be inspected; existing artifacts are never replaced.
export function writeRehearsalArtifact(path: string, encrypted: EncryptedSecret): void {
  if (encrypted.cipherVersion !== 1 || encrypted.nonce.length !== NONCE_BYTES || encrypted.authenticationTag.length !== TAG_BYTES || encrypted.ciphertext.length < 1 || encrypted.ciphertext.length > MAX_ARTIFACT_BYTES - HEADER_BYTES) throw new Error("invalid rehearsal artifact");
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, Buffer.concat([MAGIC, encrypted.nonce, encrypted.authenticationTag, encrypted.ciphertext]));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

// The returned read-only database is isolated in memory and must be closed by the caller.
export function restoreRehearsalArtifact(path: string, snapshotId: string, masterKey: Uint8Array, instanceId: string): DatabaseSync {
  const descriptor = openSync(path, "r");
  let artifact: Buffer;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size <= HEADER_BYTES || stat.size > MAX_ARTIFACT_BYTES) throw new Error("invalid rehearsal artifact");
    artifact = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < artifact.length) {
      const count = readSync(descriptor, artifact, offset, artifact.length - offset, null);
      if (count === 0) throw new Error("truncated rehearsal artifact");
      offset += count;
    }
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, null) !== 0) throw new Error("rehearsal artifact changed while reading");
  } finally {
    closeSync(descriptor);
  }
  if (artifact.length <= HEADER_BYTES || artifact.length > MAX_ARTIFACT_BYTES || !artifact.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("invalid rehearsal artifact");
  const cipher = new RuntimeSecretCipher(masterKey, instanceId);
  const bytes = cipher.decrypt(`epay:config:isolated-import:${snapshotId}`, 1, {
    cipherVersion: 1,
    nonce: artifact.subarray(MAGIC.length, MAGIC.length + NONCE_BYTES),
    authenticationTag: artifact.subarray(MAGIC.length + NONCE_BYTES, HEADER_BYTES),
    ciphertext: artifact.subarray(HEADER_BYTES),
  });
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  try {
    db.deserialize(bytes);
    db.exec("PRAGMA temp_store=MEMORY; PRAGMA query_only=ON");
    const guard = db.prepare("SELECT cipher_version,nonce,ciphertext,authentication_tag FROM runtime_master_key_guard WHERE singleton_key=1").get() as { cipher_version: number; nonce: Uint8Array; ciphertext: Uint8Array; authentication_tag: Uint8Array } | undefined;
    if (!guard || guard.cipher_version !== 1) throw new Error("invalid rehearsal master key guard");
    cipher.verifyGuard({ cipherVersion: 1, nonce: Buffer.from(guard.nonce), ciphertext: Buffer.from(guard.ciphertext), authenticationTag: Buffer.from(guard.authentication_tag) });
    const integrity = db.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok" || db.prepare("PRAGMA foreign_key_check").get()) throw new Error("rehearsal database integrity check failed");
    return db;
  } catch (error) {
    db.close();
    throw error;
  } finally {
    bytes.fill(0);
  }
}
