import { randomUUID } from "node:crypto";
import { appendAuditEvent } from "../database/identity-store.ts";
import type { RuntimeSecretCipher } from "../settings/crypto.ts";
import { readLiveBalance } from "./live-balance.ts";
import { requirePayoutProof } from "./payout-evidence.ts";
import { readPayoutDestination } from "./payout-accounts.ts";
import { payoutRow, payoutTime, payoutAccess, type PayoutAccess, type PayoutDatabase, type PayoutProof, type PayoutRow, type PayoutLease, type PayoutChannel } from "./payout-model.ts";
import type { PayoutAdapter } from "./payout-worker.ts";

const DAY_MS = 86_400_000, CHINA_OFFSET_MS = 8 * 3_600_000;
export function payoutBusinessDay(day: string, now: number) {
  payoutTime(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("invalid payout reconciliation day");
  const date = Date.parse(day + "T00:00:00Z");
  if (!Number.isFinite(date) || new Date(date).toISOString().slice(0,10) !== day) throw new Error("invalid payout reconciliation day");
  const start = date - CHINA_OFFSET_MS, end = start + DAY_MS;
  if (start < 0 || end > now) throw new Error("payout reconciliation requires a completed business day");
  return { start, end };
}

function matches(row: PayoutRow, proof: PayoutProof, now: number) {
  requirePayoutProof(proof);
  if (proof.outNo !== row.out_no || proof.channel !== row.channel || proof.payer !== row.payer || proof.accountId !== row.account_id || proof.amountCents !== Number(row.amount_cents) ||
      (row.provider_id && row.provider_id !== proof.providerId) || now < proof.observedAt || now - proof.observedAt > 60000) throw new Error("payout reconciliation evidence differs");
}

export function postPayoutReturn(database: PayoutDatabase, id: string, proof: PayoutProof, now: number): boolean {
  payoutTime(now);
  return database.write(sql => {
    const row = payoutRow(sql, id); matches(row, proof, now);
    if (proof.state !== "RETURNED" || row.status !== "SUCCEEDED" || Number(row.updated_at) > now) throw new Error("returned payout has no completed original payment");
    const prior = sql.prepare("SELECT * FROM epay_payout_returns WHERE settlement_id=?").get(id);
    if (prior) {
      if (prior.channel !== proof.channel || prior.payer !== proof.payer || prior.provider_id !== proof.providerId || Number(prior.amount_cents) !== proof.amountCents) throw new Error("conflicting payout return");
      return false;
    }
    const original = sql.prepare("SELECT * FROM epay_balance_ledger WHERE entry_id=?").get(`epay_settlement_final:${id}`);
    if (!original || Number(original.merchant_id) !== Number(row.merchant_id) || original.entry_type !== "manual_payout" || original.source !== "perpay_epay" || Number(original.available_delta_cents) !== 0 || Number(original.frozen_delta_cents) !== -proof.amountCents) throw new Error("original payout posting differs");
    const before = readLiveBalance(sql, Number(row.merchant_id)), entryId = `epay_payout_return:${id}`;
    sql.prepare(`INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,frozen_delta_cents,reason,actor_id,occurred_at,source)
      VALUES(?,?,'payout_return',?,0,'verified_payout_return','payout-reconciliation',?,'perpay_epay')`).run(entryId, row.merchant_id, proof.amountCents, now);
    sql.prepare("INSERT INTO epay_payout_returns VALUES(?,?,?,?,?,?,?,?,?)").run(id, proof.channel, proof.payer, proof.providerId, proof.amountCents, proof.responseSha256, proof.observedAt, now, entryId);
    const after = readLiveBalance(sql, Number(row.merchant_id));
    if (BigInt(after.availableCents) !== BigInt(before.availableCents) + BigInt(proof.amountCents) || after.frozenCents !== before.frozenCents) throw new Error("returned payout did not credit exactly once");
    appendAuditEvent(sql, { occurredAt: now, actorType: "SYSTEM", actorId: "payout-reconciliation", action: "epay.payout.returned", outcome: "SUCCESS", subjectType: "payout", subjectId: id, details: { amountCents: proof.amountCents, responseSha256: proof.responseSha256 } });
    return true;
  });
}

type Options = { database: PayoutDatabase; cipher: RuntimeSecretCipher; day: string; adapters: Readonly<Partial<Record<PayoutChannel, PayoutAdapter>>>; clock?: () => number };
export async function reconcilePayoutDay(options: Options) {
  const clock = options.clock ?? Date.now, startedAt = clock(), { end } = payoutBusinessDay(options.day, startedAt);
  const runId = randomUUID();
  const rows = options.database.write(sql => {
    const selected = sql.prepare(`SELECT * FROM epay_payouts WHERE submitted_at IS NOT NULL AND submitted_at<?
      AND (submitted_at>=? OR status IN ('UNKNOWN','PROCESSING','WAIT_USER_CONFIRM')) ORDER BY submitted_at,settlement_id LIMIT 10001`).all(end, end - 30 * DAY_MS) as PayoutRow[];
    if (selected.length > 10000) throw new Error("daily payout reconciliation requires a bounded batch");
    sql.prepare("INSERT INTO epay_payout_reconciliations(run_id,business_day,started_at,status,expected_count,scope) VALUES(?,?,?,'RUNNING',?,'known_payout_queries')").run(runId, options.day, startedAt, selected.length);
    return selected;
  });
  let checked = 0, issues = 0;
  for (const row of rows) {
    let issue: string | null = null, proof: PayoutProof | undefined;
    try {
      const adapter = options.adapters[row.channel];
      if (!adapter || adapter.payer !== row.payer) throw new Error("payout query adapter unavailable");
      const lease: PayoutLease = { id: row.settlement_id, merchantId: Number(row.merchant_id), accountId: row.account_id, channel: row.channel, payer: row.payer!, outNo: row.out_no,
        amountCents: Number(row.amount_cents), action: "QUERY", token: runId, until: clock() + 30000 };
      const destination = options.database.read(sql => readPayoutDestination(sql, options.cipher, row.account_id, Number(row.merchant_id)));
      const signal = AbortSignal.timeout(20000);
      const observed = await Promise.race([adapter.execute(lease, destination, signal), new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("payout query timeout")), { once: true }))]);
      const current = options.database.read(sql => payoutRow(sql, row.settlement_id)); matches(current, observed, clock());
      proof = observed;
      if (proof.state === "RETURNED" && current.status === "SUCCEEDED") postPayoutReturn(options.database, row.settlement_id, proof, clock());
      else if (proof.state !== current.status) issue = "channel_state_differs";
      if (["UNKNOWN", "PROCESSING", "WAIT_USER_CONFIRM"].includes(current.status)) issue = "payout_incomplete";
      options.database.read(sql => readLiveBalance(sql, Number(row.merchant_id)));
      checked++;
    } catch { issue = "payout_verification_unavailable"; }
    if (issue) issues++;
    options.database.write(sql => sql.prepare("INSERT INTO epay_payout_reconciliation_rows VALUES(?,?,?,?,?,?)").run(runId, row.settlement_id, proof?.state ?? "UNKNOWN", issue, proof?.responseSha256 ?? null, clock()));
  }
  options.database.write(sql => sql.prepare("UPDATE epay_payout_reconciliations SET finished_at=?,status=?,checked_count=?,issue_count=? WHERE run_id=? AND status='RUNNING'").run(clock(), issues ? "ATTENTION" : "COMPLETE", checked, issues, runId));
  return { runId, day: options.day, expected: rows.length, checked, issues, status: issues ? "ATTENTION" : "COMPLETE", scope: "known_payout_queries", statementMatched: false as const };
}

export function listPayoutReconciliations(database: PayoutDatabase, access: PayoutAccess) {
  return database.read(sql => {
    payoutAccess(sql, access, "admin");
    // A merchant detail page must not expose another merchant's payout IDs or totals, even to shared UI code.
    const rows = sql.prepare(`SELECT r.run_id,r.business_day,r.started_at,r.finished_at,r.status,
      count(d.settlement_id) checked_count,sum(CASE WHEN d.issue IS NOT NULL THEN 1 ELSE 0 END) issue_count
      FROM epay_payout_reconciliations r JOIN epay_payout_reconciliation_rows d ON d.run_id=r.run_id
      JOIN epay_payouts p ON p.settlement_id=d.settlement_id WHERE p.merchant_id=?
      GROUP BY r.run_id ORDER BY r.started_at DESC,r.run_id DESC LIMIT 20`).all(access.epayMerchantId);
    return { runs: rows.map(row => ({ id: String(row.run_id), day: String(row.business_day), startedAt: Number(row.started_at), finishedAt: row.finished_at === null ? null : Number(row.finished_at),
      checked: Number(row.checked_count), issues: Number(row.issue_count), status: row.status === "RUNNING" ? "RUNNING" : Number(row.issue_count) ? "ATTENTION" : "COMPLETE", statementMatched: false })) };
  });
}
