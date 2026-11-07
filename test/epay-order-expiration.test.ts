import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { expirationMinutes, orderAcceptsPayment } from "../src/epay-compat/order-expiration.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";

test("expiration configuration fails closed for malformed or excessive durations", () => {
  const db = new DatabaseSync(":memory:");
  const cipher = new RuntimeSecretCipher(randomBytes(32), "expiration-test");
  try {
    db.exec("CREATE TABLE epay_config_values(config_key TEXT, config_value TEXT); CREATE TABLE epay_config_secrets(config_key TEXT, secret_version INTEGER, cipher_version INTEGER, nonce BLOB, ciphertext BLOB, authentication_tag BLOB, secret_fingerprint TEXT)");
    assert.equal(expirationMinutes(db, cipher), 15);
    const insert = db.prepare("INSERT INTO epay_config_values VALUES ('order_expire_minutes', ?)");
    for (const raw of ["", "0", "-1", "NaN", "Infinity", "1e100", "999999999999999", "0.0000001"]) {
      insert.run(raw);
      assert.throws(() => expirationMinutes(db, cipher), /invalid expiration configuration/, raw);
      db.exec("DELETE FROM epay_config_values");
    }
    insert.run("0.001");
    assert.equal(expirationMinutes(db, cipher), 0.001);
    db.exec("DELETE FROM epay_config_values");
    insert.run("43201");
    assert.equal(expirationMinutes(db, cipher), 43201);
  } finally { db.close(); }
});

test("order expiration rejects invalid durations and preserves the exact deadline", () => {
  assert.equal(orderAcceptsPayment(1000, 1059, 0.001), true);
  assert.equal(orderAcceptsPayment(1000, 1060, 0.001), false);
  assert.equal(orderAcceptsPayment(1000, 1000, 43201), true);
  for (const minutes of [0, -1, NaN, Infinity, 999999999999999, 0.0000001]) {
    assert.equal(orderAcceptsPayment(1000, 1000, minutes), false);
  }
});
