import type { KeyObject } from "node:crypto";
import type { AppDatabase } from "../database/database.ts";
import type { V3Transport } from "../infrastructure/alipay/types.ts";
import { buildAlipayTradeQuery, verifyAlipayTradeObservation } from "./alipay-query.ts";
import { alipaySigningFingerprint } from "./isolated-alipay-client.ts";
import { confirmAlipayQueryInTransaction } from "./confirm-alipay.ts";
import { requireAlipayQueryAccount, type AlipayQueryAccount } from "./alipay-query-account.ts";
import { appendAuditEvent } from "../database/identity-store.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { expirationMinutes } from "./order-expiration.ts";

type Database = Pick<AppDatabase, "read">;
type QueryBinding = { app_id: string; seller_id: string; platform_public_key: string; signing_key_fingerprint: string; merchant_id: number | bigint; amount_cents: number | bigint };
const TIMEOUT_MS = 10_000;

type QueryOptions = { database: Database; tradeNo: string; privateKey: KeyObject | string; transport: V3Transport; appCertSn?: string; alipayRootCertSn?: string; account?: AlipayQueryAccount; clock?: () => number };

function readBinding(database: Database, tradeNo: string): QueryBinding | undefined {
  return database.read((db) => db.prepare(`SELECT i.app_id, i.seller_id, i.platform_public_key, b.signing_key_fingerprint, i.merchant_id, i.amount_cents
    FROM epay_alipay_submissions s
    JOIN epay_alipay_orders r ON r.trade_no=s.trade_no
    JOIN epay_alipay_intents i ON i.trade_no=r.trade_no
    JOIN epay_orders o ON o.trade_no=i.trade_no AND o.merchant_id=i.merchant_id AND o.money_cents=i.amount_cents AND o.type_code='alipay'
    JOIN epay_alipay_bindings b ON b.client_id=r.client_id AND b.app_id=i.app_id AND b.seller_id=i.seller_id AND b.platform_public_key=i.platform_public_key
    WHERE s.trade_no=?`).get(tradeNo) as QueryBinding | undefined);
}

// Querying is read-only and does not establish account ownership or settle an order.
export async function queryIsolatedAlipaySubmission(options: QueryOptions) {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(options.tradeNo) || !options.transport || typeof options.transport.request !== "function") throw new Error("invalid Alipay query configuration");
  const binding = readBinding(options.database, options.tradeNo);
  if (!binding || alipaySigningFingerprint(options.privateKey) !== binding.signing_key_fingerprint) throw new Error("Alipay query binding is unavailable");
  const amountCents = Number(binding.amount_cents);
  if (!Number.isSafeInteger(amountCents) || amountCents < 1) throw new Error("invalid Alipay query amount");
  const request = buildAlipayTradeQuery(options.tradeNo, { appId: binding.app_id, privateKey: options.privateKey, ...(options.clock ? { clock: options.clock } : {}) });
  const response = await options.transport.request(request, { timeoutMilliseconds: TIMEOUT_MS });
  const observation = verifyAlipayTradeObservation(response, { tradeNo: options.tradeNo, platformKey: binding.platform_public_key, expectedAmountCents: amountCents, expectedSellerId: binding.seller_id });
  const current = readBinding(options.database, options.tradeNo);
  if (!current || current.app_id !== binding.app_id || current.seller_id !== binding.seller_id || current.platform_public_key !== binding.platform_public_key || current.signing_key_fingerprint !== binding.signing_key_fingerprint || current.merchant_id !== binding.merchant_id || current.amount_cents !== binding.amount_cents) throw new Error("Alipay query binding changed");
  return observation;
}

// The configured signer is rechecked after the network await, in the confirmation transaction.
export async function queryAndConfirmAlipaySubmission(options: Omit<QueryOptions, "database"> & { database: Pick<AppDatabase, "read" | "write">; absentOrderExpiry?: { masterKey: Uint8Array; instanceId: string } }) {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(options.tradeNo)) throw new Error("invalid Alipay query order");
  const binding = readBinding(options.database, options.tradeNo);
  const fingerprint = alipaySigningFingerprint(options.privateKey);
  if (!binding || binding.signing_key_fingerprint !== fingerprint) throw new Error("Alipay query binding is unavailable");
  if (options.account) {
    requireAlipayQueryAccount(options.account, { appId: binding.app_id, sellerId: binding.seller_id, platformPublicKey: binding.platform_public_key }, (options.clock ?? Date.now)());
    if (options.account.signingFingerprint !== fingerprint) throw new Error("Alipay query signing identity mismatch");
  }
  const request = buildAlipayTradeQuery(options.tradeNo, { appId: binding.app_id, privateKey: options.privateKey, ...(options.appCertSn ? { appCertSn: options.appCertSn } : {}), ...(options.alipayRootCertSn ? { alipayRootCertSn: options.alipayRootCertSn } : {}), ...(options.clock ? { clock: options.clock } : {}) });
  const response = await options.transport.request(request, { timeoutMilliseconds: TIMEOUT_MS });
  const now = (options.clock ?? Date.now)();
  return options.database.write(sql => {
    const current = readBinding({ read: operation => operation(sql) }, options.tradeNo);
    if (!current || current.app_id !== binding.app_id || current.seller_id !== binding.seller_id || current.platform_public_key !== binding.platform_public_key || current.signing_key_fingerprint !== fingerprint || current.merchant_id !== binding.merchant_id || current.amount_cents !== binding.amount_cents) throw new Error("Alipay query binding changed");
    const submission = sql.prepare("SELECT state,started_at FROM epay_alipay_submissions WHERE trade_no=?").get(options.tradeNo);
    if (!submission || !Number.isSafeInteger(now) || now < Number(submission.started_at)) throw new Error("Alipay query submission is invalid");
    const confirmation = confirmAlipayQueryInTransaction(sql, options.tradeNo, response, now, options.account);
    if (!confirmation.paymentConfirmed) {
      if (confirmation.tradeStatus === "TRADE_NOT_EXIST" && options.absentOrderExpiry) {
        const cipher = new RuntimeSecretCipher(options.absentOrderExpiry.masterKey, options.absentOrderExpiry.instanceId);
        // A signed missing trade can retire only an expired attempt that never exposed a payment link.
        const expiredBefore = now - expirationMinutes(sql, cipher) * 60000;
        const closed = sql.prepare(`UPDATE epay_orders SET status='CLOSED',updated_at=? WHERE trade_no=? AND status='PENDING' AND created_at<=?
          AND paid_at IS NULL AND api_trade_no IS NULL AND NOT EXISTS(SELECT 1 FROM epay_alipay_prepay p WHERE p.trade_no=epay_orders.trade_no)
          AND NOT EXISTS(SELECT 1 FROM epay_alipay_web_links w WHERE w.trade_no=epay_orders.trade_no)
          AND NOT EXISTS(SELECT 1 FROM epay_alipay_confirmations c WHERE c.trade_no=epay_orders.trade_no)
          AND NOT EXISTS(SELECT 1 FROM epay_balance_ledger l WHERE l.entry_id='epay_payment:' || epay_orders.trade_no)
          AND NOT EXISTS(SELECT 1 FROM epay_callback_jobs j WHERE j.trade_no=epay_orders.trade_no)`)
          .run(now, options.tradeNo, expiredBefore);
        if (Number(closed.changes) === 1) appendAuditEvent(sql, { occurredAt: now, actorType: "SYSTEM", actorId: "payment-query", action: "epay.order.closed", outcome: "SUCCESS", subjectType: "epay_order", subjectId: options.tradeNo,
          details: { provider: "alipay", observedState: "TRADE_NOT_EXIST", signatureVerified: true, paymentDetailsIssued: false } });
      }
      return confirmation;
    }
    if (confirmation.duplicate) {
      if (submission.state !== "SETTLED") throw new Error("Alipay query settlement is incomplete");
      return confirmation;
    }
    const changed = sql.prepare("UPDATE epay_alipay_submissions SET state='SETTLED',lease_token=NULL,lease_until=NULL,updated_at=? WHERE trade_no=? AND state IN ('IN_FLIGHT','UNCERTAIN')").run(now, options.tradeNo);
    if (Number(changed.changes) !== 1) throw new Error("Alipay query submission changed");
    return confirmation;
  });
}
