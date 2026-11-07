import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfiguredHttpServices } from "./http-fixture.ts";
import { RuntimeSettingsStore } from "../src/settings/store.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { preserveMainPaymentArchive } from "../src/epay-compat/main-payment-archive.ts";


export async function mainOrderFixture(alipay: { appId: string; sellerId: string; fingerprint: string } = { appId: "app", sellerId: "seller", fingerprint: "a".repeat(64) }) {
  const directory = mkdtempSync(join(tmpdir(), "perpay-main-order-"));
  const services = await createConfiguredHttpServices({ directory, apiSecret: null, collectionCodePayload: "https://qr.alipay.com/fixture" });
  const database = services.database, masterKey = services.config.masterKey;
  new RuntimeSettingsStore(database, masterKey).initialize();
  const cipher = new RuntimeSecretCipher(masterKey, database.instanceId());
  const platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
  for (const id of [1, 2]) {
    const site = services.sites.create({ operation_id: randomUUID(), configuration: { name: `Merchant ${id}`, accepting_orders: true, notifications_enabled: false, notification_origin: null, return_origin: null, policy: services.sites.defaults().policy } }, { actorId: "admin" });
    services.sites.rotateSecret(site.clientId, "api_secret", 0, { actorId: "admin" });
    const sealed = cipher.encrypt(`epay:merchant:${id}:api_key`, 1, `epay-key-${id}`);
    database.write(sql => {
      sql.prepare("INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,fee_rate_bps,created_at,updated_at) VALUES (?, ?,0,1,500,0,0)").run(id, `Merchant ${id}`);
      sql.prepare("INSERT INTO epay_site_bindings VALUES (?,?,0)").run(id, site.clientId);
      sql.prepare("INSERT INTO epay_merchant_bindings VALUES (?,?,?,?,0,0)").run(`binding-${id}`, `lp-${id}`, `main-${id}`, id);
      sql.prepare("INSERT INTO epay_merchant_secrets VALUES (?,1,1,?,?,?,?,0)").run(id, sealed.nonce, sealed.ciphertext, sealed.authenticationTag, createHash("sha256").update(`epay-key-${id}`).digest("hex"));
      sql.prepare("INSERT INTO epay_alipay_bindings VALUES (?,?,?,?,?)").run(site.clientId, alipay.appId, alipay.sellerId, platform.publicKey.export({ type: "spki", format: "pem" }).toString(), alipay.fingerprint);
    });
  }
  database.write(sql => preserveMainPaymentArchive(sql, cipher, { merchants: [1, 2].map(id => ({ id: `main-${id}`, apiId: `lp-${id}`, enabled: true, callbackUrl: "https://merchant.example/notify" })), orders: [{ id: "historic-id", merchantId: "main-1", merchantOrderId: "historic-order" }], ledger: [] }));
  return { database, masterKey, cipher, platform, directory, close() { services.database.close(); rmSync(directory, { recursive: true, force: true }); } };
}

export const mainIdentity = { merchantId: "main-1", apiId: "lp-1", epayMerchantId: 1, callbackUrl: "https://merchant.example/notify", callbackSecret: "main-signing-secret-1" };
export const mainInput = { merchantOrderId: "external-001", amount: "1.01", channel: "alipay_scan", subject: "测试订单" };
