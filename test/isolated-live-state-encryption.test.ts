import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { it } from "node:test";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";

it("authenticates and recovers a large synthetic state without writing plaintext", () => {
  const masterKey = randomBytes(32);
  const cipher = new RuntimeSecretCipher(masterKey, "fixture-instance");
  const name = "epay:config:isolated-live-state-fixture";
  const state = Buffer.alloc(50 * 1024 * 1024, 0x78);
  const marker = Buffer.from("fixture-sensitive-value");
  marker.copy(state, 1234);
  try {
    const sealed = cipher.encrypt(name, 1, state);
    assert.equal(sealed.ciphertext.includes(marker), false);
    const restored = cipher.decrypt(name, 1, sealed);
    try { assert.equal(restored.equals(state), true); } finally { restored.fill(0); }
    assert.throws(() => new RuntimeSecretCipher(randomBytes(32), "fixture-instance").decrypt(name, 1, sealed));
    assert.throws(() => cipher.decrypt("epay:config:different-fixture", 1, sealed));
    const altered = { ...sealed, ciphertext: Buffer.from(sealed.ciphertext) };
    altered.ciphertext[0] = altered.ciphertext[0]! ^ 1;
    assert.throws(() => cipher.decrypt(name, 1, altered));
  } finally {
    state.fill(0);
    masterKey.fill(0);
  }
});
