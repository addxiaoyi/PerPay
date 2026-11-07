import type { DatabaseSync } from "node:sqlite";
import type { PayoutRow } from "./payout-model.ts";
import { readLiveBalance } from "./live-balance.ts";

export function finalizePayoutBalance(sql: DatabaseSync, payout: PayoutRow, paid: boolean, actor: string, reference: string, now: number): void {
  if (!sql.isTransaction) throw new Error("payout posting requires a transaction");
  const id = payout.settlement_id, merchant = Number(payout.merchant_id), amount = Number(payout.amount_cents);
  const settlement = sql.prepare("SELECT * FROM epay_native_settlements WHERE settlement_id=? AND merchant_id=?").get(id, merchant);
  const hold = sql.prepare("SELECT * FROM epay_balance_ledger WHERE entry_id=?").get(`epay_settlement_hold:${id}`);
  if (!settlement || settlement.status !== "PENDING" || Number(settlement.amount_cents) !== amount || !hold ||
      Number(hold.merchant_id) !== merchant || Number(hold.available_delta_cents) !== -amount || Number(hold.frozen_delta_cents) !== amount ||
      hold.entry_type !== "settlement_freeze" || hold.source !== "perpay_epay") throw new Error("payout frozen ledger differs");
  const before = readLiveBalance(sql, merchant);
  if (before.frozenCents < amount) throw new Error("payout frozen balance is insufficient");
  sql.prepare("UPDATE epay_native_settlements SET status=?,reviewed_by=?,reviewed_at=?,reference=? WHERE settlement_id=? AND status='PENDING'")
    .run(paid ? "PAID" : "REJECTED", actor, now, reference, id);
  // Keep the historical settlement projection intact; channel proof and attempts live in the payout tables.
  sql.prepare(`INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,frozen_delta_cents,reason,actor_id,occurred_at,source)
    VALUES(?,?,?,?,?,?,?,?,'perpay_epay')`).run(`epay_settlement_final:${id}`, merchant, paid ? "manual_payout" : "settlement_unfreeze", paid ? 0 : amount, -amount, String(settlement.note), actor, now);
  const after = readLiveBalance(sql, merchant);
  if (after.frozenCents !== before.frozenCents - amount || after.availableCents !== before.availableCents + (paid ? 0 : amount)) throw new Error("payout posting differs");
}
