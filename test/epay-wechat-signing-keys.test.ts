import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { RuntimeSettingsStore } from "../src/settings/store.ts";
import { registerWechatSigningKey, revokeWechatSigningKey, signWechatRequest } from "../src/epay-compat/wechat-signing-keys.ts";

it("binds encrypted signing keys to their identity and enforces their lifecycle", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-wechat-signing-"));
  const path = join(dir, "db.sqlite");
  const masterKey = randomBytes(32);
  const db = await AppDatabase.open(path, { masterKey });
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const privateDer = pair.privateKey.export({ type: "pkcs8", format: "der" });
  try {
    new RuntimeSettingsStore(db, masterKey).initialize();
    const input = { id: "key-a", appId: "app", merchantId: "merchant", serial: "serial", privateKey, publicKey: pair.publicKey.export({ type: "spki", format: "pem" }).toString(), validFrom: 100, validUntil: 200, actor: "admin" };
    assert.throws(() => registerWechatSigningKey(db, randomBytes(32), input, 100), /PERPAY_MASTER_KEY/);
    registerWechatSigningKey(db, masterKey, input, 100);
    const cipher = new RuntimeSecretCipher(masterKey, db.instanceId());
    const signRequest = (id: string, time: number, merchant = "merchant") => db.read((sql) => signWechatRequest(sql, cipher, id, "app", merchant, time, "fixture"));
    const signed = signRequest("key-a", 100);
    assert.equal(signed.serial, "serial");
    assert.equal(verify("RSA-SHA256", Buffer.from("fixture"), pair.publicKey, Buffer.from(signed.signature, "base64")), true);
    assert.throws(() => signRequest("key-a", 99), /unavailable/);
    assert.throws(() => signRequest("key-a", 200), /unavailable/);
    assert.throws(() => signRequest("key-a", 100, "other"), /identity mismatch/);
    db.write((sql) => sql.exec(`INSERT INTO epay_wechat_signing_keys SELECT 'copied',app_id,provider_merchant_id,'other-serial',public_fingerprint,nonce,ciphertext,authentication_tag,valid_from,valid_until,created_at,created_by FROM epay_wechat_signing_keys WHERE key_id='key-a'`));
    assert.throws(() => signRequest("copied", 100), /could not be decrypted/);
    assert.throws(() => revokeWechatSigningKey(db, "key-a", "admin", "test", 99), /predates/);
    revokeWechatSigningKey(db, "key-a", "admin", "test", 101);
    assert.throws(() => signRequest("key-a", 101), /unavailable/);
    assert.throws(() => db.write((sql) => sql.exec("DELETE FROM epay_wechat_signing_key_revocations WHERE key_id='key-a'")), /immutable/);
  } finally {
    db.close();
    try {
      const file = readFileSync(path);
      assert.equal(file.includes(Buffer.from(privateKey)), false);
      assert.equal(file.includes(privateDer), false);
    } finally { privateDer.fill(0); rmSync(dir, { recursive: true, force: true }); }
  }
});
