import { constants, createHash, createPrivateKey, createPublicKey, privateDecrypt, publicEncrypt, randomBytes, type KeyObject } from "node:crypto";
import { RuntimeSecretCipher } from "../settings/crypto.ts";

const MAX_STATE_BYTES = 128 * 1024 * 1024;
const LABEL = Buffer.from("starmc-live-state-wrap-v1", "utf8");
const FIELD = "epay:config:starmc-live-state";

export interface LiveStateEnvelope {
  readonly version: 1;
  readonly snapshotId: string;
  readonly recipientFingerprint: string;
  readonly wrappedKey: string;
  readonly nonce: string;
  readonly authenticationTag: string;
  readonly ciphertext: string;
}

function rsaKey(key: KeyObject): void {
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (key.asymmetricKeyType !== "rsa" || bits < 3072 || bits > 8192) throw new Error("recovery key must be RSA between 3072 and 8192 bits");
}

function fingerprint(key: KeyObject): string {
  const publicKey = key.type === "public" ? key : createPublicKey(key);
  return createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
}

function decode(value: unknown, maxBytes: number): Buffer {
  if (typeof value !== "string" || !value || value.length % 4 !== 0 || value.length > Math.ceil(maxBytes / 3) * 4 || /[^A-Za-z0-9+/=]/.test(value)) throw new Error("invalid encrypted recovery envelope");
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength > maxBytes || bytes.toString("base64") !== value) throw new Error("invalid encrypted recovery envelope");
  return bytes;
}

function instance(snapshotId: string, recipient: string): string {
  return `starmc-live-state:v1:${snapshotId}:${recipient}`;
}

export function validateLiveStateRecipient(recipientPem: string, snapshotId: string, expectedFingerprint: string): void {
  if (!/^[a-f0-9]{32}$/.test(snapshotId) || !/^[a-f0-9]{64}$/.test(expectedFingerprint)) throw new Error("invalid recovery snapshot");
  if (typeof recipientPem !== "string" || !/^\s*-----BEGIN (PUBLIC KEY|RSA PUBLIC KEY)-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END \1-----\s*$/.test(recipientPem)) throw new Error("recovery recipient must contain only a PEM public key");
  const recipient = createPublicKey(recipientPem);
  rsaKey(recipient);
  if (fingerprint(recipient) !== expectedFingerprint) throw new Error("recovery recipient fingerprint mismatch");
}

export function sealLiveState(plaintext: Uint8Array, recipientPem: string, snapshotId: string, expectedFingerprint: string): LiveStateEnvelope {
  if (plaintext.byteLength < 1 || plaintext.byteLength > MAX_STATE_BYTES) throw new Error("invalid recovery snapshot");
  validateLiveStateRecipient(recipientPem, snapshotId, expectedFingerprint);
  const recipient = createPublicKey(recipientPem);
  const recipientFingerprint = expectedFingerprint;
  const key = randomBytes(32);
  try {
    const wrappedKey = publicEncrypt({ key: recipient, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256", oaepLabel: LABEL }, key);
    const sealed = new RuntimeSecretCipher(key, instance(snapshotId, recipientFingerprint)).encrypt(FIELD, 1, Buffer.from(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength));
    return { version: 1, snapshotId, recipientFingerprint, wrappedKey: wrappedKey.toString("base64"), nonce: sealed.nonce.toString("base64"), authenticationTag: sealed.authenticationTag.toString("base64"), ciphertext: sealed.ciphertext.toString("base64") };
  } finally { key.fill(0); }
}

// The caller must keep the private key outside the production host.
export function openLiveState(envelope: LiveStateEnvelope, privatePem: string, expectedSnapshotId: string): Buffer {
  if (!envelope || envelope.version !== 1 || !/^[a-f0-9]{32}$/.test(envelope.snapshotId) || envelope.snapshotId !== expectedSnapshotId || !/^[a-f0-9]{64}$/.test(envelope.recipientFingerprint)) throw new Error("invalid encrypted recovery envelope");
  const recipient = createPrivateKey(privatePem);
  rsaKey(recipient);
  if (fingerprint(recipient) !== envelope.recipientFingerprint) throw new Error("recovery key does not match envelope recipient");
  const wrapped = decode(envelope.wrappedKey, 2048);
  const nonce = decode(envelope.nonce, 12);
  const authenticationTag = decode(envelope.authenticationTag, 16);
  const ciphertext = decode(envelope.ciphertext, MAX_STATE_BYTES);
  const key = privateDecrypt({ key: recipient, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256", oaepLabel: LABEL }, wrapped);
  try {
    if (key.length !== 32) throw new Error("invalid wrapped recovery key");
    return new RuntimeSecretCipher(key, instance(envelope.snapshotId, envelope.recipientFingerprint)).decrypt(FIELD, 1, { cipherVersion: 1, nonce, authenticationTag, ciphertext });
  } finally { key.fill(0); }
}
