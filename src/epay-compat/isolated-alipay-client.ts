import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import type { AppDatabase } from "../database/database.ts";
import type { V3Transport } from "../infrastructure/alipay/types.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { buildAlipayPrecreate, validateAlipayNotifyUrl, verifyAlipayPrecreate } from "./alipay-precreate.ts";
import { markAlipaySubmissionUncertain, reserveAlipayPrecreate } from "./alipay-submission.ts";

const LEASE_MS = 30_000;
const TIMEOUT_MS = 10_000;
type Database = Pick<AppDatabase, "read" | "write" | "instanceId">;

export function alipaySigningFingerprint(privateKey: KeyObject | string): string {
  const publicKey = createPublicKey(privateKey);
  if (publicKey.asymmetricKeyType !== "rsa" || (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error("invalid Alipay signing key");
  return createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
}

// A durable submission fence prevents retrying a provider request with an unknown outcome.
export async function submitIsolatedAlipayPrecreate(options: { database: Database; masterKey: Uint8Array; tradeNo: string; privateKey: KeyObject | string; notifyUrl: string; transport: V3Transport; appCertSn?: string; alipayRootCertSn?: string; clock?: () => number }): Promise<void> {
  validateAlipayNotifyUrl(options.notifyUrl);
  if (!options.transport || typeof options.transport.request !== "function") throw new Error("invalid Alipay transport");
  const fingerprint = alipaySigningFingerprint(options.privateKey);
  const cipher = new RuntimeSecretCipher(options.masterKey, options.database.instanceId());
  const clock = options.clock ?? Date.now;
  const now = clock();
  const reservation = reserveAlipayPrecreate(options.database, cipher, options.tradeNo, now, LEASE_MS, fingerprint, (order) =>
    buildAlipayPrecreate({ ...order, notifyUrl: options.notifyUrl }, { appId: order.appId, privateKey: options.privateKey, appCertSn: options.appCertSn, alipayRootCertSn: options.alipayRootCertSn, clock: () => order.reservedAt }), clock);
  try {
    if (!reservation.request) throw new Error("Alipay signed request unavailable");
    const response = await options.transport.request(reservation.request, { timeoutMilliseconds: TIMEOUT_MS });
    const verified = verifyAlipayPrecreate(response, { tradeNo: reservation.tradeNo, platformKey: reservation.platformPublicKey });
    const receivedAt = clock();
    if (!Number.isSafeInteger(receivedAt) || receivedAt < reservation.startedAt) throw new Error("invalid Alipay response time");
    const plaintext = Buffer.from(verified.qrCode, "utf8");
    try {
      const sealed = cipher.encrypt(`epay:config:alipay-prepay:${reservation.tradeNo}`, 1, plaintext);
      options.database.write((db) => {
        const active = db.prepare(`SELECT 1 FROM epay_alipay_submissions s
          JOIN epay_orders o ON o.trade_no=s.trade_no
          JOIN epay_alipay_intents i ON i.trade_no=o.trade_no AND i.merchant_id=o.merchant_id AND i.amount_cents=o.money_cents
          WHERE s.trade_no=? AND s.attempt_id=? AND s.lease_token=? AND s.state='IN_FLIGHT' AND s.lease_until>? AND o.status='PENDING' AND i.app_id=? AND i.seller_id=? AND i.platform_public_key=?`)
          .get(reservation.tradeNo, reservation.attemptId, reservation.leaseToken, receivedAt, reservation.appId, reservation.sellerId, reservation.platformPublicKey);
        if (!active) throw new Error("Alipay submission lease or order is stale");
        db.prepare("INSERT INTO epay_alipay_prepay VALUES (?,?,?,?,?,?)").run(reservation.tradeNo, reservation.attemptId, sealed.nonce, sealed.ciphertext, sealed.authenticationTag, receivedAt);
        const changed = db.prepare("UPDATE epay_alipay_submissions SET state='UNCERTAIN',lease_token=NULL,lease_until=NULL,updated_at=? WHERE trade_no=? AND state='IN_FLIGHT' AND lease_token=?").run(receivedAt, reservation.tradeNo, reservation.leaseToken);
        if (Number(changed.changes) !== 1) throw new Error("Alipay submission changed");
      });
    } finally { plaintext.fill(0); }
  } catch (cause) {
    const failedAt = clock();
    try { markAlipaySubmissionUncertain(options.database, reservation.tradeNo, reservation.leaseToken, failedAt); }
    catch (error) {
      const state = options.database.read((db) => db.prepare("SELECT state FROM epay_alipay_submissions WHERE trade_no=?").get(reservation.tradeNo));
      if (state?.state !== "UNCERTAIN" && state?.state !== "SETTLED") throw new AggregateError([cause, error], "Alipay submission state could not be preserved");
    }
    throw new Error("Alipay precreate requires reconciliation", { cause });
  }
}
