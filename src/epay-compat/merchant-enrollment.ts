import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AppDatabase } from "../database/database.ts";
import { appendAuditEvent } from "../database/identity-store.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { SiteStore } from "../sites/store.ts";
import { NodeWebhookTransport } from "../notifications/transport.ts";
import { z } from "zod";
import { MerchantAccessError, type authorizeMainAdmin } from "./merchant-access.ts";
import { preserveMerchantKey } from "./merchant-secret.ts";

export const createMerchantCommand = z.object({ requestId: z.uuid(), userId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  displayName: z.string().trim().min(1).max(80).regex(/^[^\x00-\x1f\x7f]+$/), callbackUrl: z.string().max(2048).url() }).strict();
export const mainCreatedMerchant = z.object({ id: z.uuid(), apiId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/), userId: z.string().min(1).max(128),
  displayName: z.string().min(1).max(80), callbackUrl: z.string().url(), enabled: z.literal(true), feeRate: z.number().min(0).max(0.5), createdAt: z.string() });
type Database = Pick<AppDatabase, "read" | "write" | "instanceId">;
type Admin = Awaited<ReturnType<typeof authorizeMainAdmin>>;
export class EnrollmentConflict extends Error {}
function requireAdmin(sql: DatabaseSync, access: Admin) {
  if (access.role !== "admin" || !access.userId || !sql.prepare(`SELECT 1 FROM epay_merchant_bindings b JOIN epay_merchant_accounts m ON m.merchant_id=b.epay_merchant_id
    WHERE b.main_merchant_id=? AND b.main_api_id=? AND b.epay_merchant_id=? AND m.enabled=1`).get(access.merchantId, access.mainApiId, access.epayMerchantId)) throw new MerchantAccessError("forbidden");
}
export function reserveMerchantCreation(database: Database, access: Admin, input: unknown, now: number) {
  const command = createMerchantCommand.parse(input);
  new NodeWebhookTransport(new URL(command.callbackUrl).origin).validateTarget(command.callbackUrl);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid merchant creation time");
  return database.write(sql => {
    requireAdmin(sql, access);
    const prior = sql.prepare("SELECT * FROM epay_merchant_creation_requests WHERE request_id=? OR user_id=?").get(command.requestId, command.userId);
    if (prior) {
      if (prior.request_id !== command.requestId || prior.user_id !== command.userId || prior.display_name !== command.displayName || prior.callback_url !== command.callbackUrl || prior.actor_id !== access.userId) throw new EnrollmentConflict("merchant creation request differs");
      return { ...command, requestedAt: Number(prior.created_at) };
    }
    sql.prepare("INSERT INTO epay_merchant_creation_requests VALUES(?,?,?,?,?,?)").run(command.requestId, command.userId, command.displayName, command.callbackUrl, access.userId, now);
    return { ...command, requestedAt: now };
  });
}

export function completeMerchantEnrollment(database: Database, masterKey: Uint8Array, access: Admin, requestId: string, rawMerchant: unknown, now: number) {
  const merchant = mainCreatedMerchant.parse(rawMerchant), feeBps = Math.round(merchant.feeRate * 10000), createdAt = Date.parse(merchant.createdAt);
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(createdAt) || createdAt > now || Math.abs(merchant.feeRate * 10000 - feeBps) > 1e-8) throw new Error("invalid enrolled merchant values");
  return database.write(sql => {
    requireAdmin(sql, access);
    const request = sql.prepare("SELECT * FROM epay_merchant_creation_requests WHERE request_id=?").get(requestId);
    if (!request || request.actor_id !== access.userId || request.user_id !== merchant.userId || request.display_name !== merchant.displayName || request.callback_url !== merchant.callbackUrl || createdAt < Number(request.created_at) - 1000) throw new EnrollmentConflict("main merchant does not match the requested creation");
    const prior = sql.prepare("SELECT * FROM epay_merchant_enrollments WHERE request_id=?").get(requestId);
    if (prior) {
      if (prior.main_merchant_id !== merchant.id || prior.main_api_id !== merchant.apiId) throw new EnrollmentConflict("merchant enrollment identity differs");
      return { merchantId: merchant.id, epayMerchantId: Number(prior.epay_merchant_id), duplicate: true };
    }
    if (sql.prepare("SELECT 1 FROM epay_merchant_bindings WHERE main_merchant_id=? OR main_api_id=?").get(merchant.id, merchant.apiId)) throw new EnrollmentConflict("merchant already bound");
    const marker = sql.prepare("SELECT value FROM system_metadata WHERE key='epay_cutover'").get();
    if (!marker) throw new EnrollmentConflict("merchant enrollment requires a completed gateway cutover");
    const template = sql.prepare(`SELECT b.client_id FROM epay_site_bindings b JOIN epay_merchant_accounts m ON m.merchant_id=b.merchant_id
      JOIN epay_alipay_bindings a ON a.client_id=b.client_id JOIN epay_wechat_site_bindings w ON w.client_id=b.client_id WHERE m.enabled=1 ORDER BY m.merchant_id LIMIT 1`).get();
    if (!template) throw new EnrollmentConflict("verified channel template is unavailable");
    const merchantId = Number(sql.prepare("SELECT coalesce(max(merchant_id),0)+1 n FROM epay_merchant_accounts").get()?.n);
    if (!Number.isSafeInteger(merchantId) || merchantId < 1) throw new Error("merchant identifier overflow");
    sql.prepare("INSERT INTO epay_merchant_accounts VALUES(?,?,0,1,?,?,?)").run(merchantId, merchant.displayName, feeBps, now, now);
    sql.prepare("INSERT INTO epay_merchant_bindings VALUES(?,?,?,?,?,?)").run(randomUUID(), merchant.apiId, merchant.id, merchantId, now, now);
    const secret = randomBytes(32).toString("hex"), cipher = new RuntimeSecretCipher(masterKey, database.instanceId());
    const sealed = cipher.encrypt(`epay:merchant:${merchantId}:api_key`, 1, secret);
    sql.prepare("INSERT INTO epay_merchant_secrets VALUES(?,1,1,?,?,?,?,?)").run(merchantId, sealed.nonce, sealed.ciphertext, sealed.authenticationTag, createHash("sha256").update(secret).digest("hex"), now);
    preserveMerchantKey(sql, merchantId);
    const owner: Database = { read: operation => operation(sql), write: operation => operation(sql), instanceId: () => database.instanceId() };
    const sites = new SiteStore(owner, masterKey), original = sites.get(String(template.client_id));
    if (!original) throw new EnrollmentConflict("channel template was removed");
    const site = sites.create({ operation_id: requestId, configuration: { ...original.configuration, name: merchant.displayName, accepting_orders: true, notifications_enabled: false, notification_origin: null, return_origin: null } }, { actorId: access.userId }, now);
    sites.rotateSecret(site.clientId, "api_secret", site.revision, { actorId: access.userId }, now);
    sql.prepare("INSERT INTO epay_site_bindings VALUES(?,?,?)").run(merchantId, site.clientId, now);
    sql.prepare("INSERT INTO epay_alipay_bindings SELECT ?,app_id,seller_id,platform_public_key,signing_key_fingerprint FROM epay_alipay_bindings WHERE client_id=?").run(site.clientId, String(template.client_id));
    sql.prepare("INSERT INTO epay_wechat_site_bindings SELECT ?,app_id,provider_merchant_id,? FROM epay_wechat_site_bindings WHERE client_id=?").run(site.clientId, now, String(template.client_id));
    const proof = createHash("sha256").update(JSON.stringify(merchant)).digest("hex");
    sql.prepare("INSERT INTO epay_balance_openings VALUES(?,?,0,0,0,?,?,?)").run(merchantId, `native:${requestId}`, proof, proof, now);
    sql.prepare("INSERT INTO epay_live_balances VALUES(?,0,0,0)").run(merchantId);
    sql.prepare("INSERT INTO epay_merchant_enrollments VALUES(?,?,?,?,?,?,?)").run(merchant.id, merchant.apiId, merchantId, requestId, merchant.userId, proof, now);
    appendAuditEvent(sql, { occurredAt: now, actorType: "ADMIN", actorId: access.userId, action: "epay.merchant.created", outcome: "SUCCESS", subjectType: "epay_merchant", subjectId: String(merchantId), details: { mainMerchantId: merchant.id, userId: merchant.userId, requestId } });
    return { merchantId: merchant.id, epayMerchantId: merchantId, duplicate: false };
  });
}
