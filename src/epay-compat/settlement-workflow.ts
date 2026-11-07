import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { AppDatabase } from "../database/database.ts";
import { appendAuditEvent } from "../database/identity-store.ts";
import { InsufficientBalance, readLiveBalance } from "./live-balance.ts";
import { MerchantAccessError, type authorizeMerchant } from "./merchant-access.ts";

type Database = Pick<AppDatabase, "read" | "write">;
type Access = Awaited<ReturnType<typeof authorizeMerchant>>;
type Row = { settlement_id: string; request_id: string; merchant_id: bigint | number; amount_cents: bigint | number; note: string; automatic_payout?: number | bigint;
  status: "PENDING" | "PAID" | "REJECTED"; created_by: string; reviewed_by: string | null; reference: string | null;
  created_at: bigint | number; reviewed_at: bigint | number | null };
const text = (max: number) => z.string().trim().max(max).regex(/^[^\x00-\x1f\x7f]*$/);
export const settlementRequest = z.object({ requestId: z.string().regex(/^[a-zA-Z0-9_-]{16,80}$/), amountCents: z.number().int().safe().positive(), note: text(300).default("") }).strict();
export const settlementDecision = z.object({ decision: z.enum(["paid", "rejected"]), reference: text(200) }).strict()
  .refine(value => value.decision !== "paid" || value.reference.length > 0, "payout reference is required");
export class SettlementConflict extends Error {}

function requireAccess(sql: DatabaseSync, access: Access, administrator = false) {
  if (!access.userId || !sql.prepare(`SELECT 1 FROM epay_merchant_bindings b JOIN epay_merchant_accounts m ON m.merchant_id=b.epay_merchant_id
    WHERE b.main_merchant_id=? AND b.main_api_id=? AND b.epay_merchant_id=? AND m.enabled=1`).get(access.merchantId, access.mainApiId, access.epayMerchantId)) throw new MerchantAccessError("invalid_binding");
  if (administrator && access.role !== "admin") throw new SettlementConflict("settlement decision requires administrator");
}
function time(now: number) { if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid settlement time"); }
function publicSettlement(row: Row) {
  return { id: row.settlement_id, requestId: row.request_id, amountCents: Number(row.amount_cents), note: row.note, status: row.status,
    createdBy: row.created_by, reviewedBy: row.reviewed_by, reference: row.reference, createdAt: Number(row.created_at),
    reviewedAt: row.reviewed_at === null ? null : Number(row.reviewed_at), automaticPayout: Number(row.automatic_payout ?? 0) === 1 };
}
function row(sql: DatabaseSync, id: string, merchantId: number) {
  const saved = sql.prepare("SELECT * FROM epay_native_settlements WHERE settlement_id=? AND merchant_id=?").get(id, merchantId) as Row | undefined;
  if (!saved) throw new SettlementConflict("settlement merchant or record not found");
  return saved;
}
function post(sql: DatabaseSync, id: string, merchantId: number, type: string, available: number, frozen: number, note: string, actor: string, now: number) {
  sql.prepare(`INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,frozen_delta_cents,reason,actor_id,occurred_at,source)
    VALUES(?,?,?,?,?,?,?,?,'perpay_epay')`).run(id, merchantId, type, available, frozen, note, actor, now);
}

export function requestSettlement(database: Database, access: Access, input: unknown, now: number) {
  const command = settlementRequest.parse(input); time(now);
  return database.write(sql => {
    requireAccess(sql, access);
    const prior = sql.prepare("SELECT * FROM epay_native_settlements WHERE merchant_id=? AND request_id=?").get(access.epayMerchantId, command.requestId) as Row | undefined;
    if (prior) {
      if (Number(prior.amount_cents) !== command.amountCents || prior.note !== command.note || prior.created_by !== access.userId) throw new SettlementConflict("settlement request conflict");
      return publicSettlement(prior);
    }
    const before = readLiveBalance(sql, access.epayMerchantId);
    if (command.amountCents > before.availableCents) throw new InsufficientBalance("settlement available balance is insufficient");
    const id = randomUUID();
    sql.prepare(`INSERT INTO epay_native_settlements(settlement_id,request_id,merchant_id,amount_cents,note,status,created_by,created_at)
      VALUES(?,?,?,?,?,'PENDING',?,?)`).run(id, command.requestId, access.epayMerchantId, command.amountCents, command.note, access.userId!, now);
    post(sql, `epay_settlement_hold:${id}`, access.epayMerchantId, "settlement_freeze", -command.amountCents, command.amountCents, command.note, access.userId!, now);
    const after = readLiveBalance(sql, access.epayMerchantId);
    if (after.availableCents !== before.availableCents - command.amountCents || after.frozenCents !== before.frozenCents + command.amountCents) throw new Error("settlement hold did not post exactly once");
    appendAuditEvent(sql, { occurredAt: now, actorType: access.role === "admin" ? "ADMIN" : "SYSTEM", actorId: access.userId!, action: "epay.settlement.requested",
      outcome: "SUCCESS", subjectType: "epay_settlement", subjectId: id, details: { merchantId: access.epayMerchantId, amountCents: command.amountCents } });
    return publicSettlement(row(sql, id, access.epayMerchantId));
  });
}

// A paid decision records an independently completed payout; it never initiates a bank transfer.
export function decideSettlement(database: Database, access: Access, id: string, input: unknown, now: number) {
  const command = settlementDecision.parse(input); time(now);
  return database.write(sql => {
    requireAccess(sql, access, true);
    if (sql.prepare("SELECT 1 FROM epay_payouts WHERE settlement_id=?").get(id)) throw new SettlementConflict("automatic payout must be resolved through its original channel");
    const current = row(sql, id, access.epayMerchantId), status = command.decision === "paid" ? "PAID" : "REJECTED";
    if (current.status !== "PENDING") {
      if (current.status === status && current.reference === command.reference && current.reviewed_by === access.userId) return publicSettlement(current);
      throw new SettlementConflict("settlement has already been processed");
    }
    if (now < Number(current.created_at)) throw new Error("settlement decision predates request");
    const amount = Number(current.amount_cents), balance = readLiveBalance(sql, access.epayMerchantId);
    if (balance.frozenCents < amount) throw new Error("settlement frozen balance is insufficient");
    const hold = sql.prepare("SELECT merchant_id,available_delta_cents,frozen_delta_cents FROM epay_balance_ledger WHERE entry_id=? AND entry_type='settlement_freeze' AND source='perpay_epay'").get(`epay_settlement_hold:${id}`);
    if (!hold || Number(hold.merchant_id) !== access.epayMerchantId || Number(hold.available_delta_cents) !== -amount || Number(hold.frozen_delta_cents) !== amount) throw new Error("settlement hold differs");
    sql.prepare("UPDATE epay_native_settlements SET status=?,reviewed_by=?,reviewed_at=?,reference=? WHERE settlement_id=? AND status='PENDING'").run(status, access.userId!, now, command.reference, id);
    post(sql, `epay_settlement_final:${id}`, access.epayMerchantId, status === "PAID" ? "manual_payout" : "settlement_unfreeze",
      status === "PAID" ? 0 : amount, -amount, current.note, access.userId!, now);
    readLiveBalance(sql, access.epayMerchantId);
    appendAuditEvent(sql, { occurredAt: now, actorType: "ADMIN", actorId: access.userId!, action: status === "PAID" ? "epay.settlement.paid" : "epay.settlement.rejected",
      outcome: "SUCCESS", subjectType: "epay_settlement", subjectId: id, details: { amountCents: amount, reference: command.reference } });
    return publicSettlement(row(sql, id, access.epayMerchantId));
  });
}

export function listSettlements(database: Database, access: Access, page: number) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 100_000) throw new Error("invalid settlement page");
  return database.read(sql => {
    requireAccess(sql, access);
    const rows = sql.prepare("SELECT s.*,EXISTS(SELECT 1 FROM epay_payouts p WHERE p.settlement_id=s.settlement_id) automatic_payout FROM epay_native_settlements s WHERE merchant_id=? ORDER BY created_at DESC,settlement_id DESC LIMIT 21 OFFSET ?").all(access.epayMerchantId, (page - 1) * 20) as Row[];
    return { settlements: rows.slice(0, 20).map(publicSettlement), hasNext: rows.length > 20 };
  });
}

export function auditNativeSettlements(sql: DatabaseSync) {
  const audit = sql.prepare(`SELECT count(*) settlements,coalesce(sum(CASE WHEN s.status='PENDING' THEN 1 ELSE 0 END),0) pending,
    coalesce(sum(CASE WHEN h.entry_id IS NULL OR h.merchant_id<>s.merchant_id OR h.entry_type<>'settlement_freeze' OR h.source<>'perpay_epay' OR
      h.available_delta_cents<>-s.amount_cents OR h.frozen_delta_cents<>s.amount_cents OR
      (s.status='PENDING' AND f.entry_id IS NOT NULL) OR
      (s.status<>'PENDING' AND (f.entry_id IS NULL OR f.merchant_id<>s.merchant_id OR f.source<>'perpay_epay' OR
        f.frozen_delta_cents<>-s.amount_cents OR f.entry_type<>CASE s.status WHEN 'PAID' THEN 'manual_payout' ELSE 'settlement_unfreeze' END OR
        f.available_delta_cents<>CASE s.status WHEN 'PAID' THEN 0 ELSE s.amount_cents END)) THEN 1 ELSE 0 END),0) inconsistent
    FROM epay_native_settlements s LEFT JOIN epay_balance_ledger h ON h.entry_id='epay_settlement_hold:'||s.settlement_id
    LEFT JOIN epay_balance_ledger f ON f.entry_id='epay_settlement_final:'||s.settlement_id`).get()!;
  return { settlements: Number(audit.settlements), pending: Number(audit.pending), inconsistent: Number(audit.inconsistent) };
}
