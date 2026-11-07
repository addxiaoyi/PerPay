import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { appendAuditEvent } from "../database/identity-store.ts";
import { payoutBusinessDay } from "./payout-reconciliation.ts";
import { payoutAccess, PayoutConflict, type PayoutAccess, type PayoutDatabase } from "./payout-model.ts";

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const statementInput = z.object({ day: z.string(), channel: z.enum(["bank", "alipay", "wechat"]), payer: identity, sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  rows: z.array(z.object({ entryId: identity, outNo: z.string().regex(/^[a-f0-9]{32}$/), providerId: identity,
    kind: z.enum(["PAYOUT", "RETURN"]), amountCents: z.number().int().safe().positive(), occurredAt: z.number().int().safe().nonnegative() }).strict()).max(1000) }).strict();

// A manually supplied statement is comparison evidence, never permission to credit a balance or resend a payment.
export function reconcilePayoutStatement(database: PayoutDatabase, access: PayoutAccess, input: unknown, now: number) {
  const command = statementInput.parse(input), { start, end } = payoutBusinessDay(command.day, now);
  if (command.rows.some(row => row.occurredAt < start || row.occurredAt >= end) || new Set(command.rows.map(row => row.entryId)).size !== command.rows.length) throw new PayoutConflict("statement day or entry references differ");
  const normalized = createHash("sha256").update(JSON.stringify(command)).digest("hex");
  return database.write(sql => {
    payoutAccess(sql, access, "admin");
    const prior = sql.prepare("SELECT * FROM epay_payout_statements WHERE business_day=? AND channel=? AND payer=? AND source_sha256=?").get(command.day, command.channel, command.payer, command.sourceSha256);
    if (prior) {
      if (prior.normalized_sha256 !== normalized) throw new PayoutConflict("same source statement has different normalized entries");
      return { id: String(prior.statement_id), rows: Number(prior.row_count), issues: Number(prior.issue_count), duplicate: true, provenance: "operator_supplied" as const };
    }
    const compared: Array<{ settlementId: string | null; entryId: string; kind: string; amount: number; issue: string | null }> = [];
    const seen = new Set<string>();
    for (const entry of command.rows) {
      const payout = sql.prepare("SELECT * FROM epay_payouts WHERE channel=? AND payer=? AND out_no=?").get(command.channel, command.payer, entry.outNo);
      let issue: string | null = null;
      const key = `${entry.kind}:${entry.outNo}`;
      if (seen.has(key)) issue = "duplicate_statement_payment";
      else if (!payout) issue = "unknown_channel_payment";
      else if (payout.provider_id !== entry.providerId || Number(payout.amount_cents) !== entry.amountCents) issue = "statement_identity_or_amount_differs";
      else if (payout.status !== "SUCCEEDED") issue = "local_payment_unconfirmed";
      else if (entry.kind === "RETURN" && !sql.prepare("SELECT 1 FROM epay_payout_returns WHERE settlement_id=? AND amount_cents=? AND provider_id=?").get(String(payout.settlement_id), entry.amountCents, entry.providerId)) issue = "return_requires_verified_query";
      else if (entry.kind === "PAYOUT" && !sql.prepare("SELECT 1 FROM epay_balance_ledger WHERE entry_id=? AND available_delta_cents=0 AND frozen_delta_cents=?").get(`epay_settlement_final:${payout.settlement_id}`, -entry.amountCents)) issue = "local_posting_differs";
      seen.add(key); compared.push({ settlementId: payout ? String(payout.settlement_id) : null, entryId: entry.entryId, kind: entry.kind, amount: entry.amountCents, issue });
    }
    const expected = sql.prepare(`SELECT p.settlement_id,p.out_no,p.amount_cents,'PAYOUT' kind FROM epay_payouts p WHERE p.channel=? AND p.payer=? AND p.status='SUCCEEDED' AND p.updated_at>=? AND p.updated_at<?
      UNION ALL SELECT p.settlement_id,p.out_no,r.amount_cents,'RETURN' kind FROM epay_payout_returns r JOIN epay_payouts p ON p.settlement_id=r.settlement_id WHERE p.channel=? AND p.payer=? AND r.posted_at>=? AND r.posted_at<?`)
      .all(command.channel, command.payer, start, end, command.channel, command.payer, start, end);
    for (const row of expected) if (!seen.has(`${row.kind}:${row.out_no}`)) compared.push({ settlementId: String(row.settlement_id), entryId: String(row.out_no), kind: String(row.kind), amount: Number(row.amount_cents), issue: "local_posting_missing_from_statement" });
    const id = randomUUID(), issues = compared.filter(row => row.issue !== null).length;
    sql.prepare("INSERT INTO epay_payout_statements VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, command.day, command.channel, command.payer, command.sourceSha256, normalized, access.userId!, now, command.rows.length, issues);
    for (const [ordinal, row] of compared.entries()) sql.prepare("INSERT INTO epay_payout_statement_rows VALUES(?,?,?,?,?,?,?)").run(id, ordinal, row.settlementId, row.entryId, row.kind, row.amount, row.issue);
    appendAuditEvent(sql, { occurredAt: now, actorType: "ADMIN", actorId: access.userId!, action: "epay.payout.statement_compared", outcome: "SUCCESS", subjectType: "payout_statement", subjectId: id, details: { sourceSha256: command.sourceSha256, normalizedSha256: normalized, issues } });
    return { id, rows: command.rows.length, issues, duplicate: false, provenance: "operator_supplied" as const };
  });
}
