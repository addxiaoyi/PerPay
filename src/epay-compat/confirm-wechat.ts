import type { AppDatabase } from "../database/database.ts";
import type { DatabaseSync } from "node:sqlite";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { enqueuePaidCallback } from "./outbox.ts";
import { withConfirmationSavepoint } from "./confirmation-savepoint.ts";
import { verifyWechatEvidence, verifyWechatQueryEvidence } from "./wechat-evidence.ts";

type Intent = { trade_no: string; merchant_id: number | bigint; app_id: string; provider_merchant_id: string; platform_key: string; platform_key_id: string; key_nonce: Uint8Array; key_ciphertext: Uint8Array; key_tag: Uint8Array; amount_cents: number | bigint; fee_cents: number | bigint; status: string; type_code: string | null; order_merchant: number | bigint; order_amount: number | bigint; real_money_cents: number | bigint | null; get_money_cents: number | bigint | null; api_trade_no: string | null; created_at: number | bigint; updated_at: number | bigint };
type Confirmation = { provider_trade_no: string; merchant_id: number | bigint; amount_cents: number | bigint; fee_cents: number | bigint };

function integer(value: number | bigint, minimum = 0): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) throw new Error("invalid payment intent integer");
  return number;
}

// The lookup ID is untrusted until it matches the authenticated decrypted evidence.
export function confirmWechatPayment(database: Pick<AppDatabase, "write" | "instanceId">, masterKey: Uint8Array, tradeNo: string, rawBody: Uint8Array, headers: Headers, now: number) {
  const cipher = new RuntimeSecretCipher(masterKey, database.instanceId());
  return database.write((db) => confirmWechatInTransaction(db, cipher, tradeNo, rawBody, headers, now));
}

export function confirmWechatInTransaction(db: DatabaseSync, cipher: RuntimeSecretCipher, tradeNo: string, rawBody: Uint8Array, headers: Headers, now: number, credentialId?: string, source: "notification" | "query" = "notification") {
  return withConfirmationSavepoint(db, () => confirmWechat(db, cipher, tradeNo, rawBody, headers, now, credentialId, source));
}

function confirmWechat(db: DatabaseSync, cipher: RuntimeSecretCipher, tradeNo: string, rawBody: Uint8Array, headers: Headers, now: number, credentialId?: string, source: "notification" | "query" = "notification") {
  if (!tradeNo || tradeNo.length > 64 || !Number.isSafeInteger(now) || now < 0) throw new Error("invalid payment notification");
    if (!db.isTransaction) throw new Error("payment confirmation requires a database transaction");
    if (source === "query" && (!credentialId || !db.prepare("SELECT 1 FROM epay_wechat_submissions WHERE trade_no=?").get(tradeNo))) throw new Error("WeChat query has no registered submission");
    const intent = db.prepare(`SELECT i.*, o.status, o.type_code, o.merchant_id AS order_merchant, o.money_cents AS order_amount, o.real_money_cents, o.get_money_cents, o.api_trade_no, o.created_at, o.updated_at
      FROM epay_wechat_intents i JOIN epay_orders o ON o.trade_no=i.trade_no JOIN epay_merchant_accounts m ON m.merchant_id=i.merchant_id WHERE i.trade_no=?`).get(tradeNo) as Intent | undefined;
    if (!intent) throw new Error("payment intent not found");
    const merchantId = integer(intent.merchant_id, 1), amount = integer(intent.amount_cents, 1), fee = integer(intent.fee_cents);
    if (intent.type_code !== "wxpay" || fee > amount || integer(intent.order_merchant, 1) !== merchantId || integer(intent.order_amount, 1) !== amount) throw new Error("payment intent and order mismatch");
    let platformKey = intent.platform_key;
    let platformKeyId = intent.platform_key_id;
    let encrypted = { cipherVersion: 1 as const, nonce: Buffer.from(intent.key_nonce), ciphertext: Buffer.from(intent.key_ciphertext), authenticationTag: Buffer.from(intent.key_tag) };
    let secretName: `epay:config:${string}` = `epay:config:wechat-intent:${tradeNo}`;
    if (credentialId !== undefined) {
      const registered = db.prepare(`SELECT c.app_id,c.provider_merchant_id,c.platform_key,c.platform_key_id,c.key_nonce,c.key_ciphertext,c.key_tag
        FROM epay_wechat_credentials c LEFT JOIN epay_wechat_credential_revocations r ON r.credential_id=c.credential_id
        WHERE c.credential_id=? AND c.valid_from<=? AND c.valid_until>? AND c.created_at<=? AND r.credential_id IS NULL`).get(credentialId, now, now, now) as { app_id: string; provider_merchant_id: string; platform_key: string; platform_key_id: string; key_nonce: Uint8Array; key_ciphertext: Uint8Array; key_tag: Uint8Array } | undefined;
      if (!registered || registered.app_id !== intent.app_id || registered.provider_merchant_id !== intent.provider_merchant_id) throw new Error("WeChat credential and order identity mismatch");
      platformKey = registered.platform_key;
      platformKeyId = registered.platform_key_id;
      encrypted = { cipherVersion: 1, nonce: Buffer.from(registered.key_nonce), ciphertext: Buffer.from(registered.key_ciphertext), authenticationTag: Buffer.from(registered.key_tag) };
      secretName = `epay:config:wechat-credential:${credentialId}`;
    }
    let evidence: ReturnType<typeof verifyWechatEvidence>;
    if (source === "query") {
      evidence = verifyWechatQueryEvidence(rawBody, headers, { appId: intent.app_id, merchantId: intent.provider_merchant_id, tradeNo, amountCents: amount, platformKey, platformKeyId, now });
    } else {
      const key = cipher.decrypt(secretName, 1, encrypted);
      try {
        evidence = verifyWechatEvidence(rawBody, headers, { appId: intent.app_id, merchantId: intent.provider_merchant_id, tradeNo, amountCents: amount, platformKey, platformKeyId, apiV3Key: key.toString("utf8"), now });
      } finally { key.fill(0); }
    }
    const prior = db.prepare("SELECT provider_trade_no,merchant_id,amount_cents,fee_cents FROM epay_wechat_confirmations WHERE trade_no=?").get(tradeNo) as Confirmation | undefined;
    const entryId = `epay_payment:${tradeNo}`;
    if (prior) {
      if (prior.provider_trade_no !== evidence.providerTradeNo || integer(prior.merchant_id, 1) !== merchantId || integer(prior.amount_cents, 1) !== amount || integer(prior.fee_cents) !== fee || intent.status !== "PAID" || intent.api_trade_no !== evidence.providerTradeNo || intent.real_money_cents === null || integer(intent.real_money_cents) !== amount || intent.get_money_cents === null || integer(intent.get_money_cents) !== amount) throw new Error("conflicting payment confirmation");
      const ledger = db.prepare("SELECT merchant_id,available_delta_cents,frozen_delta_cents FROM epay_balance_ledger WHERE entry_id=? AND entry_type='payment_paid' AND source='perpay_epay'").get(entryId) as { merchant_id: number | bigint; available_delta_cents: number | bigint; frozen_delta_cents: number | bigint } | undefined;
      const callback = db.prepare(`SELECT j.merchant_id FROM epay_callback_jobs j JOIN epay_orders o ON o.trade_no=j.trade_no AND o.merchant_id=j.merchant_id
        WHERE j.trade_no=? AND ((j.status IN ('PENDING','LEASED') AND o.notify_status='PENDING') OR (j.status='SUCCEEDED' AND o.notify_status='SUCCESS') OR (j.status='FAILED' AND o.notify_status='FAILED'))`).get(tradeNo) as { merchant_id: number | bigint } | undefined;
      const submission = db.prepare("SELECT state FROM epay_wechat_submissions WHERE trade_no=?").get(tradeNo) as { state: string } | undefined;
      if (!ledger || integer(ledger.merchant_id, 1) !== merchantId || integer(ledger.available_delta_cents) !== amount - fee || integer(ledger.frozen_delta_cents) !== 0 || !callback || integer(callback.merchant_id, 1) !== merchantId || (submission && submission.state !== "SETTLED")) throw new Error("incomplete prior payment confirmation");
      return { duplicate: true as const };
    }
    if (intent.status !== "PENDING" || now < integer(intent.created_at) || now < integer(intent.updated_at)) throw new Error("payment order is not confirmable");
    db.prepare("INSERT INTO epay_wechat_confirmations VALUES (?,?,?,?,?,?)").run(tradeNo, evidence.providerTradeNo, merchantId, amount, fee, now);
    const changed = db.prepare("UPDATE epay_orders SET status='PAID',real_money_cents=?,get_money_cents=?,api_trade_no=?,paid_at=?,updated_at=? WHERE trade_no=? AND merchant_id=? AND status='PENDING'").run(amount, amount, evidence.providerTradeNo, now, now, tradeNo, merchantId);
    if (Number(changed.changes) !== 1) throw new Error("payment order changed during confirmation");
    db.prepare("INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,frozen_delta_cents,reason,occurred_at,source) VALUES (?,?,'payment_paid',?,0,'verified_wechat_payment',?,'perpay_epay')").run(entryId, merchantId, amount - fee, now);
    if (!enqueuePaidCallback(db, tradeNo, merchantId, now)) throw new Error("payment callback already exists");
    const submission = db.prepare("SELECT started_at FROM epay_wechat_submissions WHERE trade_no=?").get(tradeNo) as { started_at: bigint | number } | undefined;
    if (submission) {
      if (now < integer(submission.started_at)) throw new Error("payment confirmation predates submission");
      db.prepare("UPDATE epay_wechat_submissions SET state='SETTLED',lease_token=NULL,lease_until=NULL,updated_at=? WHERE trade_no=?").run(now, tradeNo);
    }
    return { duplicate: false as const };
}
