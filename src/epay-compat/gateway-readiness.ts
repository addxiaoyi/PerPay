import { createPrivateKey, createPublicKey } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../config.ts";
import type { AppDatabase } from "../database/database.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { alipaySigningFingerprint } from "./isolated-alipay-client.ts";
import { readEncryptedChannelConfig } from "./channel-config.ts";
import { hasVerifiedCutoverManifest } from "./cutover-manifest.ts";
import { readMerchantSecret } from "./merchant-secret.ts";
import { verifyWechatMasterKeyGuard } from "./wechat-master-key.ts";
import { signWechatRequest } from "./wechat-signing-keys.ts";
import { readLiveBalance } from "./live-balance.ts";
import { sourceSynchronizationReady } from "./source-sync-status.ts";

type GatewayConfig = NonNullable<AppConfig["epayGateway"]>;
type Database = Pick<AppDatabase, "read" | "instanceId">;
type MerchantSite = { merchant_id: number | bigint; client_id: string | null; configuration: string | null; api_enabled: number | bigint | null; deleted_at: number | bigint | null };
type ChannelState = "not_enabled" | "configured" | "invalid_configuration";

function publicKeyDer(value: unknown): Buffer {
  if (typeof value !== "string" || value.length > 8192) throw new Error("invalid channel public key");
  const key = createPublicKey(value);
  if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error("invalid channel public key");
  return key.export({ format: "der", type: "spki" });
}

function inspectAlipay(db: DatabaseSync, cipher: RuntimeSecretCipher, channelId: number, sites: readonly MerchantSite[]): void {
  const channel = db.prepare("SELECT provider,enabled FROM epay_channels WHERE channel_id=?").get(channelId);
  if (channel?.provider !== "ALIPAY" || Number(channel.enabled) !== 1) throw new Error("Alipay channel is unavailable");
  const raw = readEncryptedChannelConfig(db, cipher, channelId);
  const fields = raw === null ? null : JSON.parse(raw) as Record<string, unknown>;
  if (!fields || typeof fields.privateKey !== "string" || typeof fields.appId !== "string" || !/^\d{16}$/.test(fields.appId)) throw new Error("Alipay identity is incomplete");
  const privateKey = createPrivateKey(fields.privateKey);
  const fingerprint = alipaySigningFingerprint(privateKey);
  const platformKey = publicKeyDer(fields.alipayPublicKey);
  for (const site of sites) {
    const binding = db.prepare("SELECT app_id,seller_id,platform_public_key,signing_key_fingerprint FROM epay_alipay_bindings WHERE client_id=?").get(site.client_id);
    if (!binding || binding.app_id !== fields.appId || typeof binding.seller_id !== "string" || !/^2088\d{12}$/.test(binding.seller_id) ||
      (fields.sellerId !== undefined && fields.sellerId !== binding.seller_id) ||
      binding.signing_key_fingerprint !== fingerprint || !publicKeyDer(binding.platform_public_key).equals(platformKey)) throw new Error("Alipay merchant binding differs");
  }
}

function inspectWechat(db: DatabaseSync, cipher: RuntimeSecretCipher, credentialId: string, signingKeyId: string, sites: readonly MerchantSite[], now: number): void {
  const credential = db.prepare(`SELECT c.* FROM epay_wechat_credentials c
    LEFT JOIN epay_wechat_credential_revocations r ON r.credential_id=c.credential_id
    WHERE c.credential_id=? AND c.valid_from<=? AND c.valid_until>? AND c.created_at<=? AND r.credential_id IS NULL`).get(credentialId, now, now, now);
  if (!credential || typeof credential.app_id !== "string" || typeof credential.provider_merchant_id !== "string") throw new Error("WeChat credential is unavailable");
  publicKeyDer(credential.platform_key);
  const apiKey = cipher.decrypt(`epay:config:wechat-credential:${credentialId}`, 1, {
    cipherVersion: 1, nonce: Buffer.from(credential.key_nonce as Uint8Array),
    ciphertext: Buffer.from(credential.key_ciphertext as Uint8Array), authenticationTag: Buffer.from(credential.key_tag as Uint8Array),
  });
  try { if (apiKey.length !== 32) throw new Error("invalid WeChat API key"); }
  finally { apiKey.fill(0); }
  // A local signature verifies key recovery without creating a provider request.
  signWechatRequest(db, cipher, signingKeyId, credential.app_id, credential.provider_merchant_id, now, "perpay:epay:readiness:v1");
  for (const site of sites) {
    const binding = db.prepare("SELECT app_id,provider_merchant_id FROM epay_wechat_site_bindings WHERE client_id=?").get(site.client_id);
    if (binding?.app_id !== credential.app_id || binding.provider_merchant_id !== credential.provider_merchant_id) throw new Error("WeChat merchant binding differs");
  }
}

function channelState(enabled: boolean, inspect: () => void): ChannelState {
  if (!enabled) return "not_enabled";
  try { inspect(); return "configured"; }
  catch { return "invalid_configuration"; }
}

// Native EPay orders generate their own provider QR codes; personal collection
// payloads and the separate PerPay administrator identity do not authorize them.
export function inspectEPayReadiness(database: Database, masterKey: Uint8Array, config: GatewayConfig, now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid readiness time");
  const cipher = new RuntimeSecretCipher(masterKey, database.instanceId());
  return database.read(db => {
    verifyWechatMasterKeyGuard(db, cipher);
    const sites = db.prepare(`SELECT m.merchant_id,b.client_id,s.configuration,s.deleted_at,c.enabled api_enabled
      FROM epay_merchant_accounts m JOIN epay_merchant_bindings mb ON mb.epay_merchant_id=m.merchant_id
      LEFT JOIN epay_site_bindings b ON b.merchant_id=m.merchant_id
      LEFT JOIN sites s ON s.client_id=b.client_id LEFT JOIN api_client_config c ON c.client_id=b.client_id
      WHERE m.enabled=1 ORDER BY m.merchant_id`).all() as MerchantSite[];
    let merchantConfigurationReady = sites.length > 0;
    let acceptingMerchants = 0;
    for (const site of sites) {
      if (!site.client_id || site.deleted_at !== null || !site.configuration || Number(site.api_enabled) !== 1) { merchantConfigurationReady = false; continue; }
      const configuration = JSON.parse(site.configuration) as Record<string, unknown>;
      if (configuration.accepting_orders === true) acceptingMerchants++;
      try { readMerchantSecret(db, cipher, Number(site.merchant_id)); }
      catch { merchantConfigurationReady = false; }
    }
    const channels = {
      alipay: channelState(config.alipayChannelId !== undefined, () => inspectAlipay(db, cipher, config.alipayChannelId!, sites)),
      wxpay: channelState(Boolean(config.wechatCredentialId && config.wechatSigningKeyId), () => inspectWechat(db, cipher, config.wechatCredentialId!, config.wechatSigningKeyId!, sites, now)),
    };
    const configured = Object.values(channels).some(state => state === "configured") &&
      !Object.values(channels).includes("invalid_configuration") && merchantConfigurationReady;
    const cutoverRecorded = hasVerifiedCutoverManifest(db);
    let balancesReady = sites.length > 0;
    for (const site of sites) {
      try { readLiveBalance(db, Number(site.merchant_id)); }
      catch { balancesReady = false; }
    }
    const code = !configured ? "epay_configuration_invalid" : config.mode === "maintenance" ? "epay_maintenance" :
      !cutoverRecorded ? "epay_cutover_unverified" : !balancesReady ? "epay_balances_unverified" : !config.callbackDelivery ? "epay_callbacks_disabled" :
        acceptingMerchants !== sites.length ? "epay_merchants_closed" : !sourceSynchronizationReady(db, now) ? "epay_source_sync_unavailable" : null;
    return { status: code === null ? "ready" as const : "not_ready" as const, code, mode: config.mode,
      configurationReady: configured, merchantConfigurationReady, channels, merchants: sites.length,
      acceptingMerchants, cutoverRecorded, balancesReady, callbackDeliveryEnabled: config.callbackDelivery };
  });
}
