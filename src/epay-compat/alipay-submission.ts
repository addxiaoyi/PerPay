import { createPublicKey, randomUUID } from "node:crypto";
import type { AppDatabase } from "../database/database.ts";
import type { SignedV3Request } from "../infrastructure/alipay/types.ts";
import type { RuntimeSecretCipher } from "../settings/crypto.ts";
import { validateAlipayPrecreateOrder } from "./alipay-precreate.ts";
import { expirationMinutes, orderAcceptsPayment } from "./order-expiration.ts";


type Database = Pick<AppDatabase, "write">;
type Intent = { app_id: string; seller_id: string; platform_public_key: string; amount_cents: number | bigint; name: string; created_at: number | bigint };

export function reserveAlipayPrecreate(database: Database, cipher: RuntimeSecretCipher, tradeNo: string, now: number, leaseMs: number, signingKeyFingerprint: string, prepare?: (input: { tradeNo: string; appId: string; sellerId: string; amountCents: number; subject: string; reservedAt: number }) => SignedV3Request, clock: () => number = () => now) {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(tradeNo) || !/^[a-f0-9]{64}$/.test(signingKeyFingerprint) || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 120_000 || !Number.isSafeInteger(now + leaseMs)) throw new Error("invalid Alipay submission request");
  return database.write((db) => {
    const reservedAt = clock();
    if (!Number.isSafeInteger(reservedAt) || reservedAt < now || !Number.isSafeInteger(reservedAt + leaseMs)) throw new Error("invalid Alipay reservation time");
    const intent = db.prepare(`SELECT i.app_id,i.seller_id,i.platform_public_key,i.amount_cents,o.name,o.created_at
      FROM epay_alipay_orders r JOIN epay_alipay_intents i ON i.trade_no=r.trade_no
      JOIN epay_orders o ON o.trade_no=i.trade_no AND o.merchant_id=i.merchant_id AND o.money_cents=i.amount_cents
      JOIN epay_merchant_accounts m ON m.merchant_id=i.merchant_id AND m.enabled=1
      JOIN epay_site_bindings s ON s.merchant_id=i.merchant_id AND s.client_id=r.client_id
      JOIN epay_alipay_bindings b ON b.client_id=r.client_id AND b.app_id=i.app_id AND b.seller_id=i.seller_id AND b.platform_public_key=i.platform_public_key
      JOIN sites site ON site.client_id=s.client_id AND site.deleted_at IS NULL AND json_extract(site.configuration,'$.accepting_orders')=1
      JOIN api_client_config client ON client.client_id=site.client_id AND client.enabled=1
      WHERE r.trade_no=? AND b.signing_key_fingerprint=? AND o.status='PENDING' AND o.type_code='alipay' AND o.created_at<=? AND o.updated_at<=? AND i.created_at<=?`).get(tradeNo, signingKeyFingerprint, reservedAt, reservedAt, reservedAt) as Intent | undefined;
    if (!intent) throw new Error("Alipay order is unavailable for submission");
    if (!orderAcceptsPayment(intent.created_at, reservedAt, expirationMinutes(db, cipher))) throw new Error("Alipay order is expired or unavailable for submission");
    let platformKey;
    try { platformKey = createPublicKey(intent.platform_public_key); }
    catch (cause) { throw new Error("invalid Alipay platform public key", { cause }); }
    if (platformKey.asymmetricKeyType !== "rsa" || (platformKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error("invalid Alipay platform public key");
    const amountCents = Number(intent.amount_cents);
    validateAlipayPrecreateOrder({ tradeNo, amountCents, subject: intent.name });
    const request = prepare?.({ tradeNo, appId: intent.app_id, sellerId: intent.seller_id, amountCents, subject: intent.name, reservedAt });
    const attemptId = randomUUID(), leaseToken = randomUUID();
    const inserted = db.prepare("INSERT INTO epay_alipay_submissions VALUES (?,?,'IN_FLIGHT',?,?,?,?) ON CONFLICT(trade_no) DO NOTHING").run(tradeNo, attemptId, leaseToken, reservedAt + leaseMs, reservedAt, reservedAt);
    if (Number(inserted.changes) !== 1) throw new Error("Alipay order already submitted or requires reconciliation");
    return { tradeNo, attemptId, leaseToken, startedAt: reservedAt, leaseUntil: reservedAt + leaseMs, appId: intent.app_id, sellerId: intent.seller_id, platformPublicKey: intent.platform_public_key, amountCents, subject: intent.name, request };
  });
}

export function markAlipaySubmissionUncertain(database: Database, tradeNo: string, leaseToken: string, now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid submission time");
  database.write((db) => {
    const changed = db.prepare("UPDATE epay_alipay_submissions SET state='UNCERTAIN',lease_token=NULL,lease_until=NULL,updated_at=? WHERE trade_no=? AND state='IN_FLIGHT' AND lease_token=? AND started_at<=?").run(now, tradeNo, leaseToken, now);
    if (Number(changed.changes) !== 1) throw new Error("Alipay submission lease is stale or mismatched");
  });
}

export function expireAlipaySubmission(database: Database, tradeNo: string, now: number): boolean {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid submission time");
  return database.write((db) => Number(db.prepare("UPDATE epay_alipay_submissions SET state='UNCERTAIN',lease_token=NULL,lease_until=NULL,updated_at=? WHERE trade_no=? AND state='IN_FLIGHT' AND lease_until<=?").run(now, tradeNo, now).changes) === 1);
}
