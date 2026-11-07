import type { DatabaseSync } from "node:sqlite";
import type { AppDatabase } from "../database/database.ts";
import { appendAuditEvent } from "../database/identity-store.ts";
import { canonicalSource } from "./source-drift.ts";

export class BalanceConflict extends Error {}
export class BalanceUnavailable extends Error {}
export class InsufficientBalance extends Error {}

export function safeCents(value: bigint | number): number {
  const cents = Number(value);
  if (!Number.isSafeInteger(cents)) throw new Error("merchant balance exceeds safe integer range");
  return cents;
}

export function readLiveBalance(db: DatabaseSync, merchantId: number) {
  if (!Number.isSafeInteger(merchantId) || merchantId < 1) throw new Error("invalid balance merchant");
  const query = db.prepare(`SELECT b.available_cents,b.frozen_cents,b.version,o.historical_extra_cents,o.opened_at,
    coalesce((SELECT sum(available_delta_cents) FROM epay_balance_ledger WHERE merchant_id=b.merchant_id),0) ledger_available,
    coalesce((SELECT sum(frozen_delta_cents) FROM epay_balance_ledger WHERE merchant_id=b.merchant_id),0) ledger_frozen
    FROM epay_live_balances b JOIN epay_balance_openings o ON o.merchant_id=b.merchant_id WHERE b.merchant_id=?`);
  query.setReadBigInts(true);
  const row = query.get(merchantId) as Record<string, bigint> | undefined;
  if (!row) throw new BalanceUnavailable("merchant balance has no verified migration opening");
  if (row.available_cents !== row.ledger_available! + row.historical_extra_cents! || row.frozen_cents !== row.ledger_frozen) {
    throw new BalanceUnavailable("merchant balance and ledger differ");
  }
  return { merchantId, availableCents: safeCents(row.available_cents!), frozenCents: safeCents(row.frozen_cents!), version: safeCents(row.version!), openedAt: safeCents(row.opened_at!), scope: "live_ledger" as const, migrationBaselineVerified: true as const };
}

type Adjustment = { merchantId: number; requestId: string; deltaCents: number; expectedVersion: number; reason: string; actor: string };

// The HTTP boundary supplies the authenticated actor. Client flags cannot authorize overdrafts.
export function adjustMerchantBalance(database: Pick<AppDatabase, "write">, input: Adjustment, now: number) {
  const { merchantId, requestId, deltaCents, expectedVersion, reason, actor } = input;
  if (!Number.isSafeInteger(merchantId) || merchantId < 1 || !/^[a-zA-Z0-9_-]{16,80}$/.test(requestId) || !Number.isSafeInteger(deltaCents) || deltaCents === 0 || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || !Number.isSafeInteger(now) || now < 0 || !reason || reason !== reason.trim() || reason.length > 512 || /[\x00-\x1f\x7f]/.test(reason) || !actor || actor !== actor.trim() || actor.length > 128 || /[\x00-\x1f\x7f]/.test(actor)) throw new Error("invalid merchant balance adjustment");
  return database.write(db => {
    if (!db.isTransaction) throw new Error("balance adjustment requires a transaction");
    db.exec("SAVEPOINT epay_balance_adjustment");
    try {
      const prior = db.prepare("SELECT * FROM epay_balance_adjustments WHERE request_id=?").get(requestId);
      if (prior) {
        const expected = [merchantId, actor, reason, deltaCents, expectedVersion];
        const actual = [Number(prior.merchant_id), prior.actor_id, prior.reason, Number(prior.delta_cents), Number(prior.expected_version)];
        if (canonicalSource(expected) !== canonicalSource(actual)) throw new BalanceConflict("adjustment request ID was already used");
        const balance = readLiveBalance(db, merchantId);
        db.exec("RELEASE SAVEPOINT epay_balance_adjustment");
        return { ...balance, entryId: String(prior.entry_id), duplicate: true };
      }
      const before = readLiveBalance(db, merchantId);
      if (before.version !== expectedVersion) throw new BalanceConflict("merchant balance changed");
      if (now < before.openedAt) throw new Error("adjustment predates opening balance");
      const available = safeCents(BigInt(before.availableCents) + BigInt(deltaCents));
      if (deltaCents < 0 && available < 0) throw new InsufficientBalance("merchant available balance is insufficient");
      const entryId = `epay_adjustment:${requestId}`;
      db.prepare(`INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,frozen_delta_cents,reason,actor_id,occurred_at,source)
        VALUES(?,?,'manual_adjustment',?,0,?,?,?,'perpay_admin')`).run(entryId, merchantId, deltaCents, reason, actor, now);
      const after = readLiveBalance(db, merchantId);
      if (after.availableCents !== available || after.version !== expectedVersion + 1) throw new BalanceUnavailable("balance adjustment did not post exactly once");
      db.prepare("INSERT INTO epay_balance_adjustments VALUES(?,?,?,?,?,?,?,?,?)")
        .run(requestId, entryId, merchantId, actor, reason, deltaCents, expectedVersion, available, now);
      appendAuditEvent(db, { occurredAt: now, actorType: "ADMIN", actorId: actor, action: "epay.merchant_balance.adjusted", outcome: "SUCCESS", subjectType: "epay_merchant", subjectId: String(merchantId), details: { entryId, reason, deltaCents, balanceBeforeCents: before.availableCents, balanceAfterCents: available } });
      db.exec("RELEASE SAVEPOINT epay_balance_adjustment");
      return { ...after, entryId, duplicate: false };
    } catch (error) {
      db.exec("ROLLBACK TO SAVEPOINT epay_balance_adjustment; RELEASE SAVEPOINT epay_balance_adjustment");
      throw error;
    }
  });
}
