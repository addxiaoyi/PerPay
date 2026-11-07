import { z } from "zod";
import type { AppDatabase } from "../database/database.ts";
import type { DatabaseSync } from "node:sqlite";
import { MerchantAccessError, type authorizeMerchant } from "./merchant-access.ts";

export type PayoutDatabase = Pick<AppDatabase, "read" | "write">;
export type PayoutAccess = Awaited<ReturnType<typeof authorizeMerchant>>;
export type PayoutChannel = "bank" | "alipay" | "wechat";
export type PayoutPolicy = Readonly<{ enabled: boolean; channels: Readonly<Partial<Record<PayoutChannel, Readonly<{ account: string; maxSingleCents: number; maxDailyCents: number }>>>> }>;
export const disabledPayoutPolicy: PayoutPolicy = Object.freeze({ enabled: false, channels: Object.freeze({}) });
export const payoutText = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\x00-\x1f\x7f]+$/);
export const payoutRequestId = z.string().regex(/^[a-zA-Z0-9_-]{16,80}$/);
const holderName = payoutText(100);
export const payoutDestination = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bank"), holderName, account: z.string().regex(/^\d{8,32}$/), bankName: payoutText(80), bankCode: z.string().regex(/^\d{12}$/), accountType: z.enum(["business", "personal"]) }).strict(),
  z.object({ kind: z.literal("alipay"), holderName, account: z.string().trim().max(128).refine(value => /^1\d{10}$/.test(value) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), "invalid Alipay account") }).strict(),
  z.object({ kind: z.literal("wechat"), holderName, account: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/), appId: z.string().regex(/^wx[A-Za-z0-9]{16}$/) }).strict(),
]);
export type PayoutDestination = z.infer<typeof payoutDestination>;
export class PayoutConflict extends Error {}
export class PayoutUnavailable extends Error {}
export type PayoutState = "PENDING" | "READY" | "UNKNOWN" | "PROCESSING" | "WAIT_USER_CONFIRM" | "SUCCEEDED" | "FAILED" | "REJECTED";
export type PayoutRow = {
  settlement_id: string; merchant_id: number | bigint; account_id: string; channel: PayoutChannel; out_no: string;
  amount_cents: number | bigint; status: PayoutState; payer: string | null; approved_by: string | null;
  approved_at: number | bigint | null; approval_reference: string | null; submitted_at: number | bigint | null;
  provider_id: string | null; attempts: number | bigint; lease_token: string | null; lease_until: number | bigint | null;
  next_at: number | bigint; last_error: string | null; response_sha256: string | null; created_at: number | bigint; updated_at: number | bigint;
};
export type PayoutLease = Readonly<{ id: string; merchantId: number; accountId: string; channel: PayoutChannel; payer: string; outNo: string; amountCents: number; action: "SUBMIT" | "QUERY"; token: string; until: number }>;
export type PayoutProof = Readonly<{ outNo: string; channel: PayoutChannel; payer: string; accountId: string; amountCents: number; providerId: string; state: "PROCESSING" | "WAIT_USER_CONFIRM" | "SUCCEEDED" | "FAILED"; observedAt: number; responseSha256: string }>;

export function payoutTime(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + 86_400_000)) throw new Error("invalid payout time");
}

export function payoutAccess(sql: DatabaseSync, access: PayoutAccess, level: "read" | "owner" | "admin") {
  if (!access.userId || (level === "admin" && access.role !== "admin") || (level === "owner" && access.role === "member")) throw new MerchantAccessError("forbidden");
  const bound = sql.prepare(`SELECT 1 FROM epay_merchant_bindings b JOIN epay_merchant_accounts m ON m.merchant_id=b.epay_merchant_id
    WHERE b.main_merchant_id=? AND b.main_api_id=? AND b.epay_merchant_id=? AND m.enabled=1`).get(access.merchantId, access.mainApiId, access.epayMerchantId);
  if (!bound) throw new MerchantAccessError("invalid_binding");
}

export function payoutChannel(policy: PayoutPolicy, kind: PayoutChannel) {
  const channel = policy.channels[kind];
  if (!policy.enabled || !channel || !/^[A-Za-z0-9_-]{1,128}$/.test(channel.account) ||
      !Number.isSafeInteger(channel.maxSingleCents) || channel.maxSingleCents < 1 ||
      !Number.isSafeInteger(channel.maxDailyCents) || channel.maxDailyCents < channel.maxSingleCents) throw new PayoutUnavailable("payout channel unavailable");
  return channel;
}

export function payoutRow(sql: DatabaseSync, id: string): PayoutRow {
  const row = sql.prepare("SELECT * FROM epay_payouts WHERE settlement_id=?").get(id) as PayoutRow | undefined;
  if (!row) throw new PayoutConflict("payout not found");
  return row;
}

export function publicPayout(row: PayoutRow) {
  return { id: row.settlement_id, accountId: row.account_id, channel: row.channel, outNo: row.out_no, amountCents: Number(row.amount_cents),
    status: row.status, providerId: row.provider_id, attempts: Number(row.attempts), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    approvedBy: row.approved_by, approvalReference: row.approval_reference, lastError: row.last_error };
}

export function payoutPage(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) throw new PayoutConflict("invalid payout page");
  return (value - 1) * 20;
}
