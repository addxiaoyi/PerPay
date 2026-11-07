import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { RuntimeSettingsStore } from "../src/settings/store.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { writeEncryptedChannelConfig } from "../src/epay-compat/channel-config.ts";
import { verifyConfiguredAlipayIdentity, verifyConfiguredWechatIdentity } from "../src/epay-compat/configured-channel-identity.ts";
import { provisionConfiguredChannels } from "../src/epay-compat/provision-configured-channels.ts";

const pair = () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString() };
};

it("reuses matching configured channel identities, rejects substitutions and rolls back partial provisioning", async () => {
  const directory = mkdtempSync(join(tmpdir(), "perpay-channel-config-"));
  const signing = pair(), platform = pair(), other = pair();
  const keyFile = join(directory, "synthetic-key.pem"), certificateFile = join(directory, "synthetic-cert.pem");
  writeFileSync(keyFile, signing.privateKey, { mode: 0o600 });
  const windowsOpenSSL = "C:/Program Files/Git/usr/bin/openssl.exe";
  const openssl = process.env.TEST_OPENSSL ?? (process.platform === "win32" && existsSync(windowsOpenSSL) ? windowsOpenSSL : "openssl");
  execFileSync(openssl, ["req", "-new", "-x509", "-key", keyFile, "-out", certificateFile, "-days", "2", "-subj", "/C=CN/O=Synthetic fixture/CN=2088000000000000"], { stdio: "pipe", windowsHide: true });
  const masterKey = randomBytes(32), now = Date.now();
  const db = await AppDatabase.open(join(directory, "candidate.sqlite"), { masterKey });
  try {
    new RuntimeSettingsStore(db, masterKey).initialize();
    const alipay = { appId: "2026000000000000", merchantId: "2088000000000000", privateKey: signing.privateKey, platformPublicKey: platform.publicKey, applicationCertificate: readFileSync(certificateFile, "utf8") };
    const aliChannel = { appId: alipay.appId, privateKey: signing.privateKey, alipayPublicKey: platform.publicKey };
    const wechat = { appId: "wx_fixture", merchantId: "1234567890", privateKey: signing.privateKey, platformPublicKey: platform.publicKey, platformPublicKeyId: "PUB_KEY_ID_fixture" };
    const wxChannel = { appId: wechat.appId, mchId: wechat.merchantId, merchantPrivateKey: signing.privateKey, platformPublicKey: platform.publicKey, platformPublicKeyId: wechat.platformPublicKeyId, apiV3Key: "x".repeat(32), merchantSerialNo: "A".repeat(40) };
    assert.equal(verifyConfiguredAlipayIdentity(aliChannel, alipay, now).sellerId, alipay.merchantId);
    assert.equal(verifyConfiguredWechatIdentity(wxChannel, wechat).merchantId, wechat.merchantId);
    for (const changed of [{ appId: "2026999999999999" }, { merchantId: "2088999999999999" }, { privateKey: other.privateKey }, { platformPublicKey: other.publicKey }]) {
      assert.throws(() => verifyConfiguredAlipayIdentity(aliChannel, { ...alipay, ...changed }, now), /mismatch/);
    }
    assert.throws(() => verifyConfiguredAlipayIdentity({ ...aliChannel, sellerId: "2088999999999999" }, alipay, now), /mismatch/);
    assert.throws(() => verifyConfiguredAlipayIdentity(aliChannel, alipay, Date.parse(new X509Certificate(alipay.applicationCertificate).validTo)), /validity/);
    assert.throws(() => verifyConfiguredWechatIdentity({ ...wxChannel, mchId: "9999999999" }, wechat), /mismatch/);
    assert.throws(() => verifyConfiguredWechatIdentity({ ...wxChannel, merchantPrivateKey: other.privateKey }, wechat), /mismatch/);
    const cipher = new RuntimeSecretCipher(masterKey, db.instanceId());
    db.write(sql => {
      sql.prepare("INSERT INTO system_metadata VALUES('epay_candidate_import','{}',?)").run(now);
      sql.exec("INSERT INTO epay_channels(channel_id,provider,code,name,product,enabled,rate_bps,created_at,updated_at) VALUES(1,'ALIPAY','alipay','支付宝','pc',1,0,0,0),(2,'WECHAT','wechat','微信','native',1,0,0,0)");
      writeEncryptedChannelConfig(sql, cipher, 1, JSON.stringify(aliChannel));
      writeEncryptedChannelConfig(sql, cipher, 2, JSON.stringify(wxChannel));
      sql.exec("INSERT INTO epay_merchant_accounts VALUES(1,'Bound',123,1,500,0,0),(2,'Quarantined',456,0,0,0,0)");
      sql.exec("INSERT INTO epay_merchant_bindings VALUES('binding','api','main',1,0,0)");
    });
    const input = { alipayChannelId: 1, wechatChannelId: 2, alipay, wechat, actor: "operator", now, reviewUntil: now + 86_400_000 };
    const counts = () => db.read(sql => Object.fromEntries(["sites", "alipay_accounts", "epay_wechat_credentials", "epay_wechat_signing_keys", "epay_site_bindings", "epay_alipay_bindings", "epay_wechat_site_bindings", "audit_events"].map(table => [table, Number(sql.prepare(`SELECT count(*) n FROM ${table}`).get()?.n)])));
    const before = counts();
    db.write(sql => sql.exec("CREATE TRIGGER reject_channel_marker BEFORE INSERT ON system_metadata WHEN NEW.key='epay_configured_channels' BEGIN SELECT RAISE(ABORT,'test marker rejected'); END"));
    assert.throws(() => provisionConfiguredChannels(db, masterKey, input), /test marker rejected/);
    assert.deepEqual(counts(), before);
    db.write(sql => sql.exec("DROP TRIGGER reject_channel_marker"));
    const provisioned = provisionConfiguredChannels(db, masterKey, input);
    assert.equal(provisioned.sites, 1);
    assert.equal(provisioned.acceptingOrders, false);
    db.read(sql => {
      assert.equal(Number(sql.prepare("SELECT count(*) n FROM epay_site_bindings WHERE merchant_id=2").get()?.n), 0);
      assert.equal(Number(sql.prepare("SELECT json_extract(configuration,'$.accepting_orders') n FROM sites").get()?.n), 0);
      for (const table of ["epay_orders", "epay_balance_ledger", "epay_callback_jobs"]) assert.equal(Number(sql.prepare(`SELECT count(*) n FROM ${table}`).get()?.n), 0);
      assert.equal(Number(sql.prepare("SELECT balance_cents FROM epay_merchant_accounts WHERE merchant_id=1").get()?.balance_cents), 123);
    });
    assert.throws(() => provisionConfiguredChannels(db, masterKey, input), /unprovisioned/);
  } finally { db.close(); masterKey.fill(0); rmSync(directory, { recursive: true, force: true }); }
});
