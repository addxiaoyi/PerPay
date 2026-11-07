import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { RuntimeSettingsStore } from "../src/settings/store.ts";
import { expireAlipaySubmission, markAlipaySubmissionUncertain, reserveAlipayPrecreate } from "../src/epay-compat/alipay-submission.ts";
import { createConfiguredHttpServices } from "./http-fixture.ts";

it("fences Alipay submissions across restarts and refuses mismatched or disabled bindings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-alipay-fence-"));
  const services = await createConfiguredHttpServices({ directory: dir, apiSecret: null, collectionCodePayload: "https://qr.alipay.com/fixture" });
  const db = services.database;
  const cipher = new RuntimeSecretCipher(services.config.masterKey, db.instanceId());
  let open = true;
  let recovered: AppDatabase | undefined;
  const now = 1_800_000_000_000;
  const fingerprint = "a".repeat(64);
  const platformKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
  try {
    new RuntimeSettingsStore(db, services.config.masterKey).initialize();
    const site = services.sites.create({ operation_id: randomUUID(), configuration: { name: "Fixture", accepting_orders: true, notifications_enabled: false, notification_origin: null, return_origin: null, policy: services.sites.defaults().policy } }, { actorId: "admin" });
    services.sites.rotateSecret(site.clientId, "api_secret", 0, { actorId: "admin" });
    db.write((sql) => {
      sql.exec("INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,fee_rate_bps,created_at,updated_at) VALUES (1,'fixture',0,1,500,0,0)");
      sql.prepare("INSERT INTO epay_site_bindings VALUES (1,?,0)").run(site.clientId);
      sql.prepare("INSERT INTO epay_alipay_bindings VALUES (?,'app','seller',?,?)").run(site.clientId, platformKey, fingerprint);
      for (const tradeNo of ["order_1", "order_2", "order_3"]) {
        sql.prepare("INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,type_code,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES (?,?,1,'alipay','fixture',101,'https://merchant.example/callback','PENDING','PENDING',0,?,?)").run(tradeNo, `external_${tradeNo}`, now, now);
        sql.prepare("INSERT INTO epay_alipay_intents(trade_no,merchant_id,app_id,seller_id,platform_public_key,amount_cents,fee_cents,created_at) VALUES (?,1,'app','seller',?,101,5,?)").run(tradeNo, platformKey, now);
        sql.prepare("INSERT INTO epay_alipay_orders VALUES (?,?)").run(tradeNo, site.clientId);
      }
    });
    db.write((sql) => sql.prepare("UPDATE epay_orders SET name='   ' WHERE trade_no='order_3'").run());
    assert.throws(() => reserveAlipayPrecreate(db, cipher, "order_3", now, 1000, fingerprint), /invalid Alipay precreate/);
    assert.equal(Number(db.read((sql) => sql.prepare("SELECT count(*) AS n FROM epay_alipay_submissions WHERE trade_no='order_3'").get())?.n), 0);
    db.write((sql) => sql.prepare("UPDATE epay_orders SET name='fixture' WHERE trade_no='order_3'").run());
    db.write((sql) => sql.prepare("INSERT INTO epay_config_values(config_key,config_value,updated_at) VALUES ('order_expire_minutes','0.001',0)").run());
    assert.throws(() => reserveAlipayPrecreate(db, cipher, "order_3", now + 60, 1000, fingerprint), /expired/);
    assert.throws(() => reserveAlipayPrecreate(db, cipher, "order_3", now, 1000, fingerprint, undefined, () => now + 60), /expired/);
    assert.equal(Number(db.read((sql) => sql.prepare("SELECT count(*) AS n FROM epay_alipay_submissions WHERE trade_no='order_3'").get())?.n), 0);
    db.write((sql) => sql.prepare("DELETE FROM epay_config_values WHERE config_key='order_expire_minutes'").run());
    assert.throws(() => reserveAlipayPrecreate(db, cipher, "order_3", now, 1000, fingerprint, () => { throw new Error("invalid local signing configuration"); }), /invalid local signing configuration/);
    assert.equal(Number(db.read((sql) => sql.prepare("SELECT count(*) AS n FROM epay_alipay_submissions WHERE trade_no='order_3'").get())?.n), 0);
    db.write((sql) => sql.prepare("UPDATE epay_orders SET money_cents=102 WHERE trade_no='order_3'").run());
    assert.throws(() => reserveAlipayPrecreate(db, cipher, "order_3", now, 1000, fingerprint), /unavailable/);
    db.write((sql) => sql.prepare("UPDATE epay_orders SET money_cents=101 WHERE trade_no='order_3'").run());
    db.write((sql) => sql.prepare("UPDATE epay_merchant_accounts SET enabled=0 WHERE merchant_id=1").run());
    assert.throws(() => reserveAlipayPrecreate(db, cipher, "order_2", now, 1000, fingerprint), /unavailable/);
    db.write((sql) => sql.prepare("UPDATE epay_merchant_accounts SET enabled=1 WHERE merchant_id=1").run());
    assert.throws(() => reserveAlipayPrecreate(db, cipher, "order_1", now, 1000, "b".repeat(64)), /unavailable/);
    const first = reserveAlipayPrecreate(db, cipher, "order_1", now, 1000, fingerprint);
    assert.equal(first.amountCents, 101);
    assert.throws(() => reserveAlipayPrecreate(db, cipher, "order_1", now, 1000, fingerprint), /already submitted/);
    assert.throws(() => markAlipaySubmissionUncertain(db, "order_1", "wrong-token", now), /stale/);
    db.close();
    open = false;
    recovered = await AppDatabase.open(services.config.databasePath, { masterKey: services.config.masterKey });
    const isolated = recovered;
    assert.equal(expireAlipaySubmission(isolated, "order_1", now + 999), false);
    assert.equal(expireAlipaySubmission(isolated, "order_1", now + 1000), true);
    assert.throws(() => reserveAlipayPrecreate(isolated, cipher, "order_1", now + 1000, 1000, fingerprint), /already submitted/);
    assert.throws(() => isolated.write((connection) => connection.prepare("DELETE FROM epay_alipay_submissions WHERE trade_no='order_1'").run()), /immutable/);
    const second = reserveAlipayPrecreate(isolated, cipher, "order_2", now, 1000, fingerprint);
    markAlipaySubmissionUncertain(isolated, "order_2", second.leaseToken, now + 1);
    assert.throws(() => reserveAlipayPrecreate(isolated, cipher, "order_2", now + 1, 1000, fingerprint), /already submitted/);
  } finally { if (open) db.close(); recovered?.close(); rmSync(dir, { recursive: true, force: true }); }
});
