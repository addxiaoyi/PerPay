import { createHash, randomBytes } from "node:crypto";
import type { AppDatabase } from "../database/database.ts";
import { appendAuditEvent } from "../database/identity-store.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { MerchantAccessError, type authorizeMerchant } from "./merchant-access.ts";
import { preserveMerchantKey, readMerchantSecret } from "./merchant-secret.ts";
import { z } from "zod";

type Database = Pick<AppDatabase, "read" | "write" | "instanceId">;
export const keyRotationCommand = z.object({ requestId: z.string().regex(/^[a-zA-Z0-9_-]{16,80}$/), expectedVersion: z.number().int().safe().positive() }).strict();
export class MerchantKeyConflict extends Error {}
export function rotateMerchantKey(database: Database, masterKey: Uint8Array, access: Awaited<ReturnType<typeof authorizeMerchant>>, input: unknown, now: number) {
  const command = keyRotationCommand.parse(input);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid key rotation time");
  if (!access.userId || !["owner", "admin"].includes(access.role)) throw new Error("key rotation requires owner or admin");
  const cipher = new RuntimeSecretCipher(masterKey, database.instanceId());
  return database.write(sql => {
    if (!sql.prepare(`SELECT 1 FROM epay_merchant_bindings b JOIN epay_merchant_accounts m ON m.merchant_id=b.epay_merchant_id
      WHERE b.main_merchant_id=? AND b.main_api_id=? AND b.epay_merchant_id=? AND m.enabled=1`).get(access.merchantId, access.mainApiId, access.epayMerchantId)) throw new MerchantAccessError("invalid_binding");
    const prior = sql.prepare("SELECT * FROM epay_merchant_key_rotations WHERE merchant_id=? AND request_id=?").get(access.epayMerchantId, command.requestId);
    if (prior) {
      if (Number(prior.previous_version) !== command.expectedVersion || prior.actor_id !== access.userId) throw new MerchantKeyConflict("key rotation request conflict");
      return { version: Number(prior.next_version), duplicate: true };
    }
    const current = sql.prepare("SELECT secret_version,updated_at FROM epay_merchant_secrets WHERE merchant_id=?").get(access.epayMerchantId);
    if (!current || Number(current.secret_version) !== command.expectedVersion || now < Number(current.updated_at)) throw new MerchantKeyConflict("merchant key changed");
    readMerchantSecret(sql, cipher, access.epayMerchantId);
    preserveMerchantKey(sql, access.epayMerchantId);
    sql.prepare(`INSERT OR IGNORE INTO epay_order_key_versions
      SELECT o.trade_no,o.merchant_id,? FROM epay_orders o WHERE o.merchant_id=? AND
      (EXISTS(SELECT 1 FROM epay_alipay_intents i WHERE i.trade_no=o.trade_no) OR EXISTS(SELECT 1 FROM epay_wechat_intents i WHERE i.trade_no=o.trade_no))`)
      .run(command.expectedVersion, access.epayMerchantId);
    const version = command.expectedVersion + 1;
    if (!Number.isSafeInteger(version)) throw new Error("merchant key version overflow");
    const secret = randomBytes(32).toString("hex"), sealed = cipher.encrypt(`epay:merchant:${access.epayMerchantId}:api_key`, version, secret);
    sql.prepare(`UPDATE epay_merchant_secrets SET secret_version=?,nonce=?,ciphertext=?,authentication_tag=?,secret_fingerprint=?,updated_at=? WHERE merchant_id=? AND secret_version=?`)
      .run(version, sealed.nonce, sealed.ciphertext, sealed.authenticationTag, createHash("sha256").update(secret).digest("hex"), now, access.epayMerchantId, command.expectedVersion);
    preserveMerchantKey(sql, access.epayMerchantId);
    sql.prepare("INSERT INTO epay_merchant_key_rotations VALUES(?,?,?,?,?,?)").run(access.epayMerchantId, command.requestId, access.userId!, command.expectedVersion, version, now);
    appendAuditEvent(sql, { occurredAt: now, actorType: access.role === "admin" ? "ADMIN" : "SYSTEM", actorId: access.userId, action: "epay.merchant_key.rotated",
      outcome: "SUCCESS", subjectType: "epay_merchant", subjectId: String(access.epayMerchantId), details: { previousVersion: command.expectedVersion, version } });
    return { version, duplicate: false };
  });
}
