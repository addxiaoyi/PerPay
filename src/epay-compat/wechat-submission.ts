import { randomUUID } from "node:crypto";
import type { AppDatabase } from "../database/database.ts";
import { validateWechatNativeFields } from "./wechat-native-fields.ts";
import type { RuntimeSecretCipher } from "../settings/crypto.ts";
import { expirationMinutes, orderAcceptsPayment } from "./order-expiration.ts";

type Database = Pick<AppDatabase, "write">;
const MAX_LEASE_MS = 120_000;

function validateTime(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid submission time");
}

// No provider request may be sent without reserving its exact order first.
export function reserveWechatSubmission(database: Database, cipher: RuntimeSecretCipher, tradeNo: string, now: number, leaseMs: number, clock: () => number = () => now) {
  validateTime(now);
  if (!/^[a-f0-9]{32}$/.test(tradeNo) || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > MAX_LEASE_MS || !Number.isSafeInteger(now + leaseMs)) throw new Error("invalid WeChat submission request");
  const attemptId = randomUUID(), leaseToken = randomUUID();
  return database.write((db) => {
    const reservedAt = clock();
    validateTime(reservedAt);
    if (reservedAt < now || !Number.isSafeInteger(reservedAt + leaseMs)) throw new Error("invalid WeChat reservation time");
    const intent = db.prepare(`SELECT i.app_id,i.provider_merchant_id,i.amount_cents,o.name,o.created_at,r.credential_id
      FROM epay_exact_order_requests r JOIN epay_wechat_intents i ON i.trade_no=r.trade_no
      JOIN epay_orders o ON o.trade_no=i.trade_no AND o.merchant_id=i.merchant_id AND o.money_cents=i.amount_cents
      JOIN epay_merchant_accounts m ON m.merchant_id=i.merchant_id AND m.enabled=1
      JOIN epay_site_bindings s ON s.merchant_id=i.merchant_id AND s.client_id=r.client_id
      JOIN epay_wechat_site_bindings b ON b.client_id=s.client_id AND b.app_id=i.app_id AND b.provider_merchant_id=i.provider_merchant_id
      JOIN sites site ON site.client_id=s.client_id AND site.deleted_at IS NULL AND json_extract(site.configuration,'$.accepting_orders')=1
      JOIN api_client_config client ON client.client_id=site.client_id AND client.enabled=1
      JOIN epay_wechat_credentials c ON c.credential_id=r.credential_id AND c.app_id=i.app_id AND c.provider_merchant_id=i.provider_merchant_id
      LEFT JOIN epay_wechat_credential_revocations revoked ON revoked.credential_id=c.credential_id
      WHERE r.trade_no=? AND o.status='PENDING' AND o.type_code='wxpay' AND o.device='pc'
        AND c.valid_from<=? AND c.valid_until>? AND c.created_at<=? AND revoked.credential_id IS NULL
        AND o.created_at<=? AND o.updated_at<=? AND r.created_at<=? AND i.created_at<=?`).get(tradeNo, reservedAt, reservedAt, reservedAt, reservedAt, reservedAt, reservedAt, reservedAt) as { app_id: string; provider_merchant_id: string; amount_cents: bigint | number; name: string; created_at: number | bigint; credential_id: string } | undefined;
    if (!intent) throw new Error("WeChat order is unavailable for submission");
    const minutes = expirationMinutes(db, cipher), expiresAt = Number(intent.created_at) + minutes * 60000;
    if (!orderAcceptsPayment(intent.created_at, reservedAt, minutes)) throw new Error("WeChat order is expired or unavailable for submission");
    validateWechatNativeFields({ appId: intent.app_id, providerMerchantId: intent.provider_merchant_id, name: intent.name });
    const amount = Number(intent.amount_cents);
    if (!Number.isSafeInteger(amount) || amount < 1) throw new Error("invalid WeChat intent amount");
    const inserted = db.prepare(`INSERT INTO epay_wechat_submissions(trade_no,attempt_id,state,lease_token,lease_until,started_at,updated_at)
      VALUES (?,?,'IN_FLIGHT',?,?,?,?) ON CONFLICT(trade_no) DO NOTHING`).run(tradeNo, attemptId, leaseToken, reservedAt + leaseMs, reservedAt, reservedAt);
    if (Number(inserted.changes) !== 1) throw new Error("WeChat order already submitted or requires reconciliation");
    return { tradeNo, attemptId, leaseToken, startedAt: reservedAt, leaseUntil: reservedAt + leaseMs, appId: intent.app_id, providerMerchantId: intent.provider_merchant_id, amountCents: amount, name: intent.name, credentialId: intent.credential_id, expiresAt };
  });
}

// An ambiguous transport outcome must never make the order eligible for another submission.
export function markWechatSubmissionUncertain(database: Database, tradeNo: string, leaseToken: string, now: number): void {
  validateTime(now);
  database.write((db) => {
    const updated = db.prepare(`UPDATE epay_wechat_submissions SET state='UNCERTAIN',lease_token=NULL,lease_until=NULL,updated_at=?
      WHERE trade_no=? AND state='IN_FLIGHT' AND lease_token=? AND started_at<=?`).run(now, tradeNo, leaseToken, now);
    if (Number(updated.changes) !== 1) throw new Error("WeChat submission lease is stale or mismatched");
  });
}

export function expireWechatSubmission(database: Database, tradeNo: string, now: number): boolean {
  validateTime(now);
  return database.write((db) => Number(db.prepare(`UPDATE epay_wechat_submissions SET state='UNCERTAIN',lease_token=NULL,lease_until=NULL,updated_at=?
    WHERE trade_no=? AND state='IN_FLIGHT' AND lease_until<=?`).run(now, tradeNo, now).changes) === 1);
}
