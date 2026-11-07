import type { DatabaseSync } from "node:sqlite";
import type { RuntimeSecretCipher } from "../settings/crypto.ts";

export const EPAY_CHANNEL_CONFIG_SCHEMA_SQL = `
  CREATE TABLE epay_channel_config_secrets (
    channel_id INTEGER PRIMARY KEY REFERENCES epay_channels(channel_id),
    cipher_version INTEGER NOT NULL CHECK (cipher_version=1),
    nonce BLOB NOT NULL CHECK (length(nonce)=12),
    ciphertext BLOB NOT NULL CHECK (length(ciphertext)>0),
    authentication_tag BLOB NOT NULL CHECK (length(authentication_tag)=16)
  ) STRICT;
`;

function keyName(channelId: number): `epay:config:${string}` {
  if (!Number.isSafeInteger(channelId) || channelId < 1) throw new Error("invalid channel ID");
  return `epay:config:channel:${channelId}`;
}

export function writeEncryptedChannelConfig(db: DatabaseSync, cipher: RuntimeSecretCipher, channelId: number, value: string): void {
  if (typeof value !== "string" || value.length === 0) throw new Error("invalid channel config");
  try { JSON.parse(value); } catch { throw new Error("invalid channel config JSON"); }
  const sealed = cipher.encrypt(keyName(channelId), 1, value);
  db.prepare("INSERT INTO epay_channel_config_secrets(channel_id,cipher_version,nonce,ciphertext,authentication_tag) VALUES (?,1,?,?,?)")
    .run(channelId, sealed.nonce, sealed.ciphertext, sealed.authenticationTag);
}

export function readEncryptedChannelConfig(db: DatabaseSync, cipher: RuntimeSecretCipher, channelId: number): string | null {
  const name = keyName(channelId);
  const row = db.prepare("SELECT nonce,ciphertext,authentication_tag FROM epay_channel_config_secrets WHERE channel_id=?").get(channelId) as { nonce: Uint8Array; ciphertext: Uint8Array; authentication_tag: Uint8Array } | undefined;
  if (!row) return null;
  const plaintext = cipher.decrypt(name, 1, { cipherVersion: 1, nonce: Buffer.from(row.nonce), ciphertext: Buffer.from(row.ciphertext), authenticationTag: Buffer.from(row.authentication_tag) });
  try {
    const value = plaintext.toString("utf8");
    JSON.parse(value);
    return value;
  } finally { plaintext.fill(0); }
}
