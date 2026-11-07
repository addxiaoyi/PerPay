import { randomUUID } from "node:crypto";
import type { AppDatabase } from "../database/database.ts";
import { AlipayAccountStore } from "../alipay-accounts/store.ts";
import { appendAuditEvent } from "../database/identity-store.ts";
import { SiteStore } from "../sites/store.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { readEncryptedChannelConfig } from "./channel-config.ts";
import { channelFields, verifyConfiguredAlipayIdentity, verifyConfiguredWechatIdentity, type ConfiguredAlipayIdentity, type ConfiguredWechatIdentity } from "./configured-channel-identity.ts";
import { registerWechatCredential } from "./wechat-credentials.ts";
import { registerWechatSigningKey } from "./wechat-signing-keys.ts";

type Database = Pick<AppDatabase, "read" | "write" | "instanceId">;
const MARKER = "epay_configured_channels";
const MAX_REVIEW_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

export function provisionConfiguredChannels(database: Database, masterKey: Uint8Array, input: {
  readonly alipayChannelId: number;
  readonly wechatChannelId: number;
  readonly alipay: ConfiguredAlipayIdentity;
  readonly wechat: ConfiguredWechatIdentity;
  readonly actor: string;
  readonly now: number;
  readonly reviewUntil: number;
}) {
  const { now, reviewUntil, actor } = input;
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(reviewUntil) || reviewUntil <= now || reviewUntil - now > MAX_REVIEW_INTERVAL_MS || !/^[A-Za-z0-9:_-]{1,128}$/.test(actor)) throw new Error("invalid channel provisioning context");
  const cipher = new RuntimeSecretCipher(masterKey, database.instanceId());
  return database.write(sql => {
    if (!sql.prepare("SELECT 1 FROM system_metadata WHERE key='epay_candidate_import'").get() || sql.prepare("SELECT 1 FROM system_metadata WHERE key IN ('epay_cutover',?)").get(MARKER)) throw new Error("channel provisioning requires an unprovisioned maintenance candidate");
    for (const table of ["epay_site_bindings", "epay_alipay_intents", "epay_wechat_intents", "epay_wechat_credentials", "epay_wechat_signing_keys"]) {
      if (sql.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) throw new Error("candidate already has channel routing or payment intents");
    }
    const readChannel = (id: number, provider: string) => {
      if (!Number.isSafeInteger(id) || id < 1 || !sql.prepare("SELECT 1 FROM epay_channels WHERE channel_id=? AND provider=? AND enabled=1").get(id, provider)) throw new Error("configured channel is not enabled");
      const raw = readEncryptedChannelConfig(sql, cipher, id);
      if (raw === null) throw new Error("configured channel is missing encrypted settings");
      return channelFields(JSON.parse(raw));
    };
    const alipay = verifyConfiguredAlipayIdentity(readChannel(input.alipayChannelId, "ALIPAY"), input.alipay, now);
    const wechat = verifyConfiguredWechatIdentity(readChannel(input.wechatChannelId, "WECHAT"), input.wechat);
    const owner: Database = { instanceId: () => database.instanceId(), read: operation => operation(sql), write: operation => operation(sql) };
    const account = new AlipayAccountStore(owner, masterKey).create({ name: "支付宝官方支付", enabled: true, environment: "PRODUCTION", code_payload: null, app_id: alipay.appId, private_key: alipay.privateKey, platform_public_key: alipay.platformPublicKey }, { actorId: actor });
    const credentialId = `channel-${input.wechatChannelId}-platform`;
    const signingKeyId = `channel-${input.wechatChannelId}-signing`;
    // This is a local review deadline for configured public keys, not a claimed certificate expiry.
    registerWechatCredential(owner, masterKey, { id: credentialId, ...wechat, validFrom: now, validUntil: reviewUntil, actor }, now);
    registerWechatSigningKey(owner, masterKey, { id: signingKeyId, ...wechat, validFrom: now, validUntil: reviewUntil, actor }, now);
    const merchants = sql.prepare(`SELECT m.merchant_id,m.name FROM epay_merchant_accounts m
      JOIN epay_merchant_bindings b ON b.epay_merchant_id=m.merchant_id WHERE m.enabled=1 ORDER BY m.merchant_id`).all() as Array<{ merchant_id: number | bigint; name: string }>;
    if (merchants.length === 0) throw new Error("no verified merchant bindings available");
    const sites = new SiteStore(owner, masterKey);
    const policy = sites.defaults().policy;
    for (const merchant of merchants) {
      const site = sites.create({ operation_id: randomUUID(), configuration: {
        name: merchant.name, accepting_orders: false, notifications_enabled: false,
        notification_origin: null, return_origin: null,
        collection: { mode: "FIXED", accounts: [{ account_id: account.id, weight: 1 }] },
        policy,
      } }, { actorId: actor }, now);
      sites.rotateSecret(site.clientId, "api_secret", site.revision, { actorId: actor }, now);
      sql.prepare("INSERT INTO epay_site_bindings VALUES (?,?,?)").run(merchant.merchant_id, site.clientId, now);
      sql.prepare("INSERT INTO epay_alipay_bindings VALUES (?,?,?,?,?)").run(site.clientId, alipay.appId, alipay.sellerId, alipay.platformPublicKey, alipay.signingFingerprint);
      sql.prepare("INSERT INTO epay_wechat_site_bindings VALUES (?,?,?,?)").run(site.clientId, wechat.appId, wechat.merchantId, now);
    }
    const marker = { version: 1, provisionedAt: now, sites: merchants.length, alipayChannelId: input.alipayChannelId, wechatChannelId: input.wechatChannelId, credentialId, signingKeyId, certificateSha256: alipay.certificateSha256, certificateValidUntil: alipay.certificateValidUntil, reviewUntil, acceptingOrders: false };
    sql.prepare("INSERT INTO system_metadata(key,value,updated_at) VALUES(?,?,?)").run(MARKER, JSON.stringify(marker), now);
    appendAuditEvent(sql, { occurredAt: now, actorType: "ADMIN", actorId: actor, action: "epay.configured_channels.provisioned", outcome: "SUCCESS", subjectType: "epay_channel", subjectId: String(input.alipayChannelId) });
    return marker;
  });
}
