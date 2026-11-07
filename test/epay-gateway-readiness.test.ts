import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { Hono } from "hono";
import { AppDatabase } from "../src/database/database.ts";
import { RuntimeSettingsStore } from "../src/settings/store.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { writeEncryptedChannelConfig } from "../src/epay-compat/channel-config.ts";
import { hasVerifiedCutoverManifest } from "../src/epay-compat/cutover-manifest.ts";
import { inspectEPayReadiness } from "../src/epay-compat/gateway-readiness.ts";
import { createEPayRuntime, mountEPayGateway } from "../src/epay-compat/gateway-runtime.ts";
import { alipaySigningFingerprint } from "../src/epay-compat/isolated-alipay-client.ts";
import { registerWechatCredential } from "../src/epay-compat/wechat-credentials.ts";
import { registerWechatSigningKey } from "../src/epay-compat/wechat-signing-keys.ts";
import { accountCertificate } from "./fixtures/alipay-account-certificate.ts";

const rsa = () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { privateKey: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), publicKey: pair.publicKey.export({ format: "pem", type: "spki" }).toString() };
};
const signing = rsa(), platform = rsa();
const config = { mode: "maintenance" as const, callbackDelivery: false, alipayChannelId: 1, wechatCredentialId: "platform", wechatSigningKeyId: "signing" };

async function fixture(options: { appId?: string; secret?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "perpay-gateway-readiness-"));
  const masterKey = randomBytes(32), now = Date.now();
  const database = await AppDatabase.open(join(directory, "fixture.sqlite"), { masterKey });
  new RuntimeSettingsStore(database, masterKey).initialize();
  const cipher = new RuntimeSecretCipher(masterKey, database.instanceId());
  const certificate = accountCertificate(directory, signing.privateKey);
  database.write(sql => {
    sql.exec(`INSERT INTO epay_merchant_accounts VALUES(1,'bound',100,1,500,0,0),(2,'unbound',200,0,0,0,0);
      INSERT INTO epay_merchant_bindings VALUES('binding','main-api','main-merchant',1,0,0);
      INSERT INTO api_client_config(client_id,secret_fingerprint,key_version,enabled,created_at,updated_at) VALUES('site','${"a".repeat(64)}',1,1,0,0);
      INSERT INTO sites(client_id,revision,configuration,created_at,updated_at) VALUES('site',0,'{"accepting_orders":false}',0,0);
      INSERT INTO epay_site_bindings VALUES(1,'site',0);
      INSERT INTO epay_channels(channel_id,provider,code,name,product,enabled,rate_bps,created_at,updated_at) VALUES(1,'ALIPAY','alipay','synthetic','pc',1,0,0,0);
      INSERT INTO epay_wechat_site_bindings VALUES('site','wx_fixture','1234567890',0);
      INSERT INTO system_metadata VALUES('epay_candidate_import','{"snapshotId":"fixture-snapshot"}',0)`);
    sql.prepare("INSERT INTO epay_alipay_bindings VALUES('site',?,?,?,?)")
      .run(options.appId ?? "2026000000000000", "2088000000000000", platform.publicKey, alipaySigningFingerprint(signing.privateKey));
    writeEncryptedChannelConfig(sql, cipher, 1, JSON.stringify({ appId: "2026000000000000", privateKey: signing.privateKey, alipayPublicKey: platform.publicKey }));
    sql.prepare("INSERT INTO system_metadata VALUES('epay_configured_channels',?,?)").run(JSON.stringify({ alipayChannelId: 1, certificateSha256: certificate.certificateSha256 }), now);
    if (options.secret !== false) {
      const secret = cipher.encrypt("epay:merchant:1:api_key", 1, "fixture-secret");
      sql.prepare("INSERT INTO epay_merchant_secrets VALUES(1,1,1,?,?,?,?,0)")
        .run(secret.nonce, secret.ciphertext, secret.authenticationTag, createHash("sha256").update("fixture-secret").digest("hex"));
    }
  });
  registerWechatCredential(database, masterKey, { id: "platform", appId: "wx_fixture", merchantId: "1234567890", apiV3Key: "x".repeat(32), platformKey: platform.publicKey, platformKeyId: "PUB_KEY_ID_fixture", validFrom: now, validUntil: now + 86_400_000, actor: "fixture" }, now);
  registerWechatSigningKey(database, masterKey, { id: "signing", appId: "wx_fixture", merchantId: "1234567890", privateKey: signing.privateKey, publicKey: signing.publicKey, serial: "A".repeat(40), validFrom: now, validUntil: now + 86_400_000, actor: "fixture" }, now);
  return { database, masterKey, now, certificateFile: certificate.path, close: () => { database.close(); masterKey.fill(0); rmSync(directory, { recursive: true, force: true }); } };
}

it("recognizes native EPay configuration without creating a personal QR profile, admin identity or financial records", async () => {
  const f = await fixture();
  try {
    const inspect = () => inspectEPayReadiness(f.database, f.masterKey, config, f.now);
    const counts = () => f.database.read(sql => Object.fromEntries(["epay_orders", "epay_balance_ledger", "epay_callback_jobs", "admin_identity", "alipay_accounts", "audit_events"].map(table => [table, sql.prepare(`SELECT count(*) n FROM ${table}`).get()?.n])));
    const before = counts();
    assert.deepEqual(inspect(), { status: "not_ready", code: "epay_maintenance", mode: "maintenance", configurationReady: true,
      merchantConfigurationReady: true, channels: { alipay: "configured", wxpay: "configured" }, merchants: 1, acceptingMerchants: 0,
      cutoverRecorded: false, balancesReady: false, callbackDeliveryEnabled: false });
    assert.deepEqual(counts(), before);
    assert.equal(Number(before.admin_identity), 0);
    assert.equal(Number(before.alipay_accounts), 0);
    const runtime = createEPayRuntime({ ...f, config, publicOrigin: "https://gateway.example", basePath: "/pay", onError: assert.fail });
    try {
      const app = new Hono().basePath("/pay");
      mountEPayGateway(app, runtime, "/pay");
      const response = await app.request("/pay/epay/readyz");
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal((await response.json() as { code: string }).code, "epay_maintenance");
      assert.equal((await app.request("/pay/epay/mapi.php", { method: "POST" })).status, 503);
      assert.equal((await app.request("/pay/epay/wechat/notify", { method: "POST" })).status, 400);
      assert.deepEqual(counts(), before);
    } finally { await runtime.close(); }
  } finally { f.close(); }
});

it("retains manifest, callback-delivery and merchant-admission gates independently of channel configuration", async () => {
  const f = await fixture();
  const live = { ...config, mode: "live" as const, callbackDelivery: true };
  try {
    assert.equal(inspectEPayReadiness(f.database, f.masterKey, live, f.now).code, "epay_cutover_unverified");
    const manifest = { version: 1, snapshotId: "fixture-snapshot", sharedCutoff: true, cutoff: new Date(f.now).toISOString(), reconciliationSha256: "a".repeat(64), rollbackSha256: "b".repeat(64), channelVerificationSha256: "c".repeat(64) };
    f.database.write(sql => sql.prepare("INSERT INTO system_metadata VALUES('epay_cutover',?,?)").run(JSON.stringify(manifest), f.now));
    assert.equal(inspectEPayReadiness(f.database, f.masterKey, live, f.now).code, "epay_balances_unverified");
    f.database.write(sql => {
      sql.prepare("INSERT INTO epay_balance_openings VALUES(1,'fixture-snapshot',100,0,100,?,?,?)").run("a".repeat(64), "d".repeat(64), f.now);
      sql.exec("INSERT INTO epay_live_balances VALUES(1,100,0,0)");
    });
    assert.equal(inspectEPayReadiness(f.database, f.masterKey, live, f.now).code, "epay_merchants_closed");
    assert.equal(inspectEPayReadiness(f.database, f.masterKey, { ...live, callbackDelivery: false }, f.now).code, "epay_callbacks_disabled");
    f.database.write(sql => sql.exec("UPDATE sites SET configuration='{\"accepting_orders\":true}',revision=revision+1,updated_at=1 WHERE client_id='site'"));
    assert.equal(inspectEPayReadiness(f.database, f.masterKey, live, f.now).code, "epay_source_sync_unavailable");
    f.database.write(sql => {
      for (const table of ["epay_main_sync_runs", "epay_legacy_sync_runs"]) sql.prepare(`INSERT INTO ${table} VALUES(1,?,?,?,?,?,0,?,?,?)`).run("0".repeat(64), "d".repeat(64), "e".repeat(64), f.now, f.now, randomBytes(12), Buffer.from("synthetic-cursor"), randomBytes(16));
      sql.prepare("INSERT INTO system_metadata VALUES('epay_source_sync',?,?)").run(JSON.stringify({ version: 1, ok: true, capturedAt: new Date(f.now).toISOString(), appliedAt: f.now, mainSequence: 1, legacySequence: 1, sourceSha256: "f".repeat(64) }), f.now);
    });
    assert.equal(inspectEPayReadiness(f.database, f.masterKey, live, f.now).status, "ready");
    assert.equal(inspectEPayReadiness(f.database, f.masterKey, live, f.now + 90_001).code, "epay_source_sync_unavailable");
    assert.throws(() => createEPayRuntime({ ...f, config: live, publicOrigin: "https://gateway.example", basePath: "/pay", onError: assert.fail }), /pinned account certificate/);
    const runtime = createEPayRuntime({ ...f, config: { ...live, alipayCertificateFile: f.certificateFile }, publicOrigin: "https://gateway.example", basePath: "/pay", onError: assert.fail });
    try {
      assert.equal(runtime.readiness().code, "epay_callbacks_unavailable");
      assert.equal((await runtime.app.request("/mapi.php", { method: "POST" })).status, 503, "new orders must wait for recovery workers to start");
      await runtime.start();
      assert.equal(runtime.readiness().status, "ready");
      f.database.write(sql => sql.exec("UPDATE system_metadata SET value='{\"version\":1,\"ok\":false}' WHERE key='epay_source_sync'"));
      assert.equal((await runtime.app.request("/mapi.php", { method: "POST" })).status, 503);
      assert.equal((await runtime.app.request("/wechat/notify", { method: "POST" })).status, 400);
      f.database.write(sql => sql.prepare("UPDATE system_metadata SET value=? WHERE key='epay_source_sync'").run(JSON.stringify({ version: 1, ok: true, capturedAt: new Date(f.now).toISOString(), appliedAt: f.now, mainSequence: 1, legacySequence: 1, sourceSha256: "f".repeat(64) })));
      await runtime.quiesceOrders();
      assert.equal(runtime.readiness().code, "epay_draining");
    } finally { await runtime.close(); }
    f.database.write(sql => sql.prepare("UPDATE system_metadata SET value=? WHERE key='epay_cutover'").run(JSON.stringify({ ...manifest, snapshotId: "different" })));
    assert.equal(inspectEPayReadiness(f.database, f.masterKey, live, f.now).code, "epay_cutover_unverified");
    f.database.write(sql => {
      sql.prepare("UPDATE system_metadata SET value=? WHERE key='epay_cutover'").run(JSON.stringify({ ...manifest, snapshotId: undefined }));
      sql.exec("UPDATE system_metadata SET value='{}' WHERE key='epay_candidate_import'");
    });
    assert.equal(f.database.read(hasVerifiedCutoverManifest), false);
  } finally { f.close(); }
});

it("rejects mismatched Alipay identity, missing merchant secrets and expired WeChat keys without leaking their values", async () => {
  for (const options of [{ appId: "2026999999999999" }, { secret: false }, {}]) {
    const f = await fixture(options);
    try {
      const health = inspectEPayReadiness(f.database, f.masterKey, config, f.now + (Object.keys(options).length ? 0 : 86_400_000));
      assert.equal(health.configurationReady, false);
      assert.equal(health.code, "epay_configuration_invalid");
      if ("appId" in options) assert.equal(health.channels.alipay, "invalid_configuration");
      if ("secret" in options) assert.equal(health.merchantConfigurationReady, false);
      if (!Object.keys(options).length) assert.equal(health.channels.wxpay, "invalid_configuration");
      assert.doesNotMatch(JSON.stringify(health), /PRIVATE KEY|fixture-secret|wx_fixture|2088000000000000/);
    } finally { f.close(); }
  }
});
