import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { readEncryptedChannelConfig, writeEncryptedChannelConfig } from "../src/epay-compat/channel-config.ts";
import { encryptLegacyChannelConfigs } from "../src/epay-compat/channel-config-migration.ts";
import { RuntimeSettingsStore } from "../src/settings/store.ts";

it("encrypts complete channel JSON and binds ciphertext to the channel ID", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-channel-config-"));
  const path = join(dir, "test.sqlite");
  const key = randomBytes(32);
  const db = await AppDatabase.open(path, { masterKey: key });
  const config = JSON.stringify({ nested: { arbitrarySecret: "fixture-channel-secret-23901" }, enabled: true });
  try {
    const cipher = new RuntimeSecretCipher(key, db.instanceId());
    db.write((sql) => {
      sql.exec("INSERT INTO epay_channels(channel_id,provider,code,name,product,enabled,rate_bps,created_at,updated_at) VALUES (1,'test','a','A','test',1,0,0,0),(2,'test','b','B','test',1,0,0,0)");
      writeEncryptedChannelConfig(sql, cipher, 1, config);
      sql.exec("INSERT INTO epay_channel_config_secrets SELECT 2,cipher_version,nonce,ciphertext,authentication_tag FROM epay_channel_config_secrets WHERE channel_id=1");
    });
    assert.equal(db.read((sql) => readEncryptedChannelConfig(sql, cipher, 1)), config);
    assert.equal(db.read((sql) => readEncryptedChannelConfig(sql, cipher, 3)), null);
    assert.throws(() => db.read((sql) => readEncryptedChannelConfig(sql, cipher, 2)), /could not be decrypted/);
    assert.throws(() => db.read((sql) => readEncryptedChannelConfig(sql, new RuntimeSecretCipher(randomBytes(32), db.instanceId()), 1)), /could not be decrypted/);
    assert.throws(() => db.write((sql) => writeEncryptedChannelConfig(sql, cipher, 1, "not-json")), /JSON/);
  } finally {
    db.close();
    try { assert.equal(readFileSync(path).includes(Buffer.from("fixture-channel-secret-23901")), false); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

it("rolls back conflicting plaintext migration and safely retries with the correct key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-channel-migration-"));
  const key = randomBytes(32);
  const db = await AppDatabase.open(join(dir, "test.sqlite"), { masterKey: key });
  try {
    new RuntimeSettingsStore(db, key).initialize();
    const cipher = new RuntimeSecretCipher(key, db.instanceId());
    db.write((sql) => {
      sql.exec(`INSERT INTO epay_channels(channel_id,provider,code,name,product,enabled,rate_bps,config_json,created_at,updated_at) VALUES
        (1,'test','a','A','test',1,0,'{"key":"first"}',0,0),
        (2,'test','b','B','test',1,0,'{"key":"second"}',0,0),
        (3,'test','c','C','test',1,0,NULL,0,0)`);
      writeEncryptedChannelConfig(sql, cipher, 2, '{"key":"different"}');
    });
    assert.throws(() => encryptLegacyChannelConfigs(db, randomBytes(32)), /PERPAY_MASTER_KEY/);
    assert.throws(() => encryptLegacyChannelConfigs(db, key), /configuration conflict/);
    assert.equal(db.read((sql) => sql.prepare("SELECT config_json FROM epay_channels WHERE channel_id=1").get())?.config_json, '{"key":"first"}');
    assert.equal(db.read((sql) => readEncryptedChannelConfig(sql, cipher, 1)), null);
    db.write((sql) => sql.prepare("UPDATE epay_channels SET config_json=? WHERE channel_id=2").run('{"key":"different"}'));
    assert.deepEqual(encryptLegacyChannelConfigs(db, key), { encrypted: 1, alreadyEncrypted: 1 });
    assert.equal(db.read((sql) => readEncryptedChannelConfig(sql, cipher, 1)), '{"key":"first"}');
    assert.equal(db.read((sql) => sql.prepare("SELECT COUNT(*) AS n FROM epay_channels WHERE config_json IS NOT NULL").get())?.n, 0n);
    assert.deepEqual(encryptLegacyChannelConfigs(db, key), { encrypted: 0, alreadyEncrypted: 0 });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
