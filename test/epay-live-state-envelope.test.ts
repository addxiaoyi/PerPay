import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { it } from "node:test";
import { openLiveState, sealLiveState } from "../src/epay-compat/live-state-envelope.ts";

it("wraps a synthetic state for an offline key and rejects altered envelopes", { timeout: 30000 }, () => {
  const key = generateKeyPairSync("rsa", { modulusLength: 3072, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const other = generateKeyPairSync("rsa", { modulusLength: 3072, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const marker = Buffer.from("synthetic-confidential-value");
  const state = Buffer.alloc(50 * 1024 * 1024, 0x78);
  const snapshotId = "0123456789abcdef0123456789abcdef";
  const fingerprint = createHash("sha256").update(createPublicKey(key.publicKey).export({ type: "spki", format: "der" })).digest("hex");
  marker.copy(state, 1234);
  try {
    assert.throws(() => sealLiveState(state, key.publicKey, snapshotId, "0".repeat(64)), /fingerprint mismatch/);
    assert.throws(() => sealLiveState(state, key.privateKey, snapshotId, fingerprint), /only a PEM public key/);
    assert.throws(() => sealLiveState(state, key.publicKey + key.privateKey, snapshotId, fingerprint), /only a PEM public key/);
    const sealed = sealLiveState(state, key.publicKey, snapshotId, fingerprint);
    assert.equal(Buffer.from(sealed.ciphertext, "base64").includes(marker), false);
    const recovered = openLiveState(sealed, key.privateKey, snapshotId);
    try { assert.equal(recovered.equals(state), true); } finally { recovered.fill(0); }
    assert.throws(() => openLiveState(sealed, other.privateKey, snapshotId), /does not match/);
    assert.throws(() => openLiveState({ ...sealed, snapshotId: "1123456789abcdef0123456789abcdef" }, key.privateKey, snapshotId));
    assert.throws(() => openLiveState({ ...sealed, snapshotId: "1123456789abcdef0123456789abcdef" }, key.privateKey, "1123456789abcdef0123456789abcdef"));
    const bytes = Buffer.from(sealed.ciphertext, "base64");
    bytes[0] = bytes[0]! ^ 1;
    assert.throws(() => openLiveState({ ...sealed, ciphertext: bytes.toString("base64") }, key.privateKey, snapshotId));
    assert.throws(() => openLiveState({ ...sealed, nonce: "invalid!" }, key.privateKey, snapshotId), /invalid/);
    assert.throws(() => openLiveState({ ...sealed, wrappedKey: Buffer.alloc(384).toString("base64") }, key.privateKey, snapshotId));
  } finally { state.fill(0); }
});

it("rejects weak keys and invalid snapshot metadata", () => {
  const weak = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  assert.throws(() => sealLiveState(Buffer.from("fixture"), weak.publicKey, "0123456789abcdef0123456789abcdef", "0".repeat(64)), /3072/);
  assert.throws(() => sealLiveState(Buffer.from("fixture"), weak.publicKey, "invalid", "0".repeat(64)), /invalid/);
  assert.throws(() => sealLiveState(Buffer.alloc(0), weak.publicKey, "0123456789abcdef0123456789abcdef", "0".repeat(64)), /invalid/);
});
