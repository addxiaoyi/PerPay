import type { DatabaseSync } from "node:sqlite";
import type { RuntimeSecretCipher } from "../settings/crypto.ts";

export function verifyWechatMasterKeyGuard(db: DatabaseSync, cipher: RuntimeSecretCipher): void {
  const guard = db.prepare("SELECT cipher_version,nonce,ciphertext,authentication_tag FROM runtime_master_key_guard WHERE singleton_key=1").get() as { cipher_version: number | bigint; nonce: Uint8Array; ciphertext: Uint8Array; authentication_tag: Uint8Array } | undefined;
  if (!guard) throw new Error("runtime master key guard is not initialized");
  cipher.verifyGuard({ cipherVersion: Number(guard.cipher_version) as 1, nonce: Buffer.from(guard.nonce), ciphertext: Buffer.from(guard.ciphertext), authenticationTag: Buffer.from(guard.authentication_tag) });
}
