import type { AppDatabase } from "../database/database.ts";
import type { DatabaseSync } from "node:sqlite";
import { verifyAlipayEvidence, type VerifiedAlipayEvidence } from "./alipay-evidence.ts";
import type { RawV3Response } from "../infrastructure/alipay/types.ts";
import { verifyAlipayQueryEvidence } from "./alipay-query-evidence.ts";
import type { AlipayQueryAccount } from "./alipay-query-account.ts";
import { enqueuePaidCallback } from "./outbox.ts";
import { withConfirmationSavepoint } from "./confirmation-savepoint.ts";

type Intent = { trade_no: string; merchant_id: bigint | number; app_id: string; seller_id: string; platform_public_key: string; amount_cents: bigint | number; fee_cents: bigint | number; status: string; type_code: string | null; order_merchant: bigint | number; order_amount: bigint | number; real_money_cents: bigint | number | null; get_money_cents: bigint | number | null; api_trade_no: string | null; created_at: bigint | number; updated_at: bigint | number };
type Confirmation = { provider_trade_no: string; merchant_id: bigint | number; amount_cents: bigint | number; fee_cents: bigint | number };

function integer(value: bigint | number, minimum = 0): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted < minimum) throw new Error("invalid payment intent integer");
  return converted;
}

// Only a pre-existing trusted intent supplies account identity, key and fee; there is no public intent creation route.
export function confirmAlipayPayment(database: Pick<AppDatabase, "write">, params: Readonly<Record<string, string>>, now: number) {
  return database.write((db) => confirmAlipayInTransaction(db, params, now));
}

export function confirmAlipayInTransaction(db: DatabaseSync, params: Readonly<Record<string, string>>, now: number) {
  return withConfirmationSavepoint(db, () => confirmAlipay(db, params, now));
}

function confirmAlipay(db: DatabaseSync, params: Readonly<Record<string, string>>, now: number) {
  if (!Number.isSafeInteger(now) || now < 0 || typeof params.out_trade_no !== "string" || !params.out_trade_no || params.out_trade_no.length > 64) throw new Error("invalid payment notification");
  const tradeNo = params.out_trade_no;
  const intent = readIntent(db, tradeNo);
  const evidence = verifyAlipayEvidence(params, expectation(intent));
  return postPayment(db, intent, evidence, now);
}

export function confirmAlipayQueryInTransaction(db: DatabaseSync, tradeNo: string, response: RawV3Response, now: number, account?: AlipayQueryAccount) {
  return withConfirmationSavepoint(db, () => {
    if (!/^[A-Za-z0-9_]{1,64}$/.test(tradeNo) || !Number.isSafeInteger(now) || now < 0) throw new Error("invalid Alipay query confirmation");
    const intent = readIntent(db, tradeNo);
    const verified = verifyAlipayQueryEvidence(response, expectation(intent), now, account);
    if (!verified.evidence) return { paymentConfirmed: false as const, tradeStatus: verified.tradeStatus };
    return { paymentConfirmed: true as const, ...postPayment(db, intent, verified.evidence, now), tradeStatus: verified.tradeStatus };
  });
}

function readIntent(db: DatabaseSync, tradeNo: string): Intent {
  if (!db.isTransaction) throw new Error("payment confirmation requires a database transaction");
  const intent = db.prepare(`SELECT i.*, o.status, o.type_code, o.merchant_id AS order_merchant, o.money_cents AS order_amount, o.real_money_cents, o.get_money_cents, o.api_trade_no, o.created_at, o.updated_at
      FROM epay_alipay_intents i JOIN epay_orders o ON o.trade_no = i.trade_no JOIN epay_merchant_accounts m ON m.merchant_id = i.merchant_id WHERE i.trade_no = ?`).get(tradeNo) as Intent | undefined;
    if (!intent) throw new Error("payment intent not found");
    const merchantId = integer(intent.merchant_id, 1), amount = integer(intent.amount_cents, 1), fee = integer(intent.fee_cents);
    // Disabling a merchant stops new orders, not settlement of an existing trusted intent.
    if (intent.type_code !== "alipay" || fee > amount || integer(intent.order_merchant, 1) !== merchantId || integer(intent.order_amount, 1) !== amount) throw new Error("payment intent and order mismatch");
  return intent;
}

function expectation(intent: Intent) {
  return { appId: intent.app_id, sellerId: intent.seller_id, tradeNo: intent.trade_no, amountCents: integer(intent.amount_cents, 1), platformPublicKey: intent.platform_public_key };
}

function postPayment(db: DatabaseSync, intent: Intent, evidence: VerifiedAlipayEvidence, now: number) {
    const merchantId = integer(intent.merchant_id, 1), amount = integer(intent.amount_cents, 1), fee = integer(intent.fee_cents);
    const prior = db.prepare("SELECT provider_trade_no, merchant_id, amount_cents, fee_cents FROM epay_alipay_confirmations WHERE trade_no = ?").get(intent.trade_no) as Confirmation | undefined;
    const entryId = `epay_payment:${intent.trade_no}`;
    if (prior) {
      if (prior.provider_trade_no !== evidence.providerTradeNo || integer(prior.merchant_id, 1) !== merchantId || integer(prior.amount_cents, 1) !== amount || integer(prior.fee_cents) !== fee || intent.status !== "PAID" || intent.api_trade_no !== evidence.providerTradeNo || intent.real_money_cents === null || integer(intent.real_money_cents) !== amount || intent.get_money_cents === null || integer(intent.get_money_cents) !== amount) throw new Error("conflicting payment confirmation");
      const ledger = db.prepare("SELECT merchant_id, available_delta_cents, frozen_delta_cents FROM epay_balance_ledger WHERE entry_id = ? AND entry_type = 'payment_paid' AND source = 'perpay_epay'").get(entryId) as { merchant_id: bigint | number; available_delta_cents: bigint | number; frozen_delta_cents: bigint | number } | undefined;
      const callback = db.prepare(`SELECT j.merchant_id FROM epay_callback_jobs j JOIN epay_orders o ON o.trade_no=j.trade_no AND o.merchant_id=j.merchant_id
        WHERE j.trade_no=? AND ((j.status IN ('PENDING','LEASED') AND o.notify_status='PENDING') OR (j.status='SUCCEEDED' AND o.notify_status='SUCCESS') OR (j.status='FAILED' AND o.notify_status='FAILED'))`).get(intent.trade_no) as { merchant_id: bigint | number } | undefined;
      if (!ledger || integer(ledger.merchant_id, 1) !== merchantId || integer(ledger.available_delta_cents) !== amount - fee || integer(ledger.frozen_delta_cents) !== 0 || !callback || integer(callback.merchant_id, 1) !== merchantId) throw new Error("incomplete prior payment confirmation");
      return { duplicate: true as const };
    }
    if (intent.status !== "PENDING" || now < integer(intent.created_at) || now < integer(intent.updated_at)) throw new Error("payment order is not confirmable");
    db.prepare("INSERT INTO epay_alipay_confirmations(trade_no, provider_trade_no, merchant_id, amount_cents, fee_cents, confirmed_at) VALUES (?, ?, ?, ?, ?, ?)").run(intent.trade_no, evidence.providerTradeNo, merchantId, amount, fee, now);
    // Legacy getMoney is gross; the fee-adjusted amount belongs only in the ledger.
    const updated = db.prepare("UPDATE epay_orders SET status = 'PAID', real_money_cents = ?, get_money_cents = ?, api_trade_no = ?, paid_at = ?, updated_at = ? WHERE trade_no = ? AND merchant_id = ? AND status = 'PENDING'").run(amount, amount, evidence.providerTradeNo, now, now, intent.trade_no, merchantId);
    if (Number(updated.changes) !== 1) throw new Error("payment order changed during confirmation");
    db.prepare("INSERT INTO epay_balance_ledger(entry_id, merchant_id, entry_type, available_delta_cents, frozen_delta_cents, reason, occurred_at, source) VALUES (?, ?, 'payment_paid', ?, 0, 'verified_alipay_payment', ?, 'perpay_epay')").run(entryId, merchantId, amount - fee, now);
    if (!enqueuePaidCallback(db, intent.trade_no, merchantId, now)) throw new Error("payment callback already exists");
    return { duplicate: false as const };
}
