import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { appendAuditEvent } from "../database/identity-store.ts";
import type { RuntimeSecretCipher } from "../settings/crypto.ts";
import { payoutAccess, payoutDestination, payoutRequestId, payoutText, payoutTime, payoutPage, PayoutConflict, type PayoutAccess, type PayoutChannel, type PayoutDatabase } from "./payout-model.ts";

type AccountRow = { account_id: string; request_id: string; merchant_id: number | bigint; kind: PayoutChannel; masked_label: string;
  nonce: Uint8Array; ciphertext: Uint8Array; authentication_tag: Uint8Array; status: "PENDING" | "APPROVED" | "REJECTED" | "REVOKED";
  created_by: string; created_at: number | bigint; reviewed_by: string | null; reviewed_at: number | bigint | null; review_reference: string | null };
const accountCommand = z.object({ requestId: payoutRequestId }).passthrough();
const reviewCommand = z.object({ decision: z.enum(["approve", "reject", "revoke"]), reference: payoutText(200) }).strict();
const secretName = (merchant: number, id: string) => `epay:config:payout-account:${merchant}:${id}` as const;
const project = (row: AccountRow) => ({ id: row.account_id, kind: row.kind, label: row.masked_label, status: row.status,
  createdAt: Number(row.created_at), reviewedBy: row.reviewed_by, reviewReference: row.review_reference });

export function payoutAccount(sql: DatabaseSync, id: string, merchantId: number): AccountRow {
  const row = sql.prepare("SELECT * FROM epay_payout_accounts WHERE account_id=? AND merchant_id=?").get(id, merchantId) as AccountRow | undefined;
  if (!row) throw new PayoutConflict("payout account not found");
  return row;
}

export function readPayoutDestination(sql: DatabaseSync, cipher: RuntimeSecretCipher, id: string, merchantId: number) {
  const row = payoutAccount(sql, id, merchantId);
  const bytes = cipher.decrypt(secretName(merchantId, id), 1, { cipherVersion: 1, nonce: Buffer.from(row.nonce), ciphertext: Buffer.from(row.ciphertext), authenticationTag: Buffer.from(row.authentication_tag) });
  try {
    const destination = payoutDestination.parse(JSON.parse(bytes.toString("utf8")));
    if (destination.kind !== row.kind) throw new Error("payout account kind differs");
    return destination;
  } finally { bytes.fill(0); }
}

export function addPayoutAccount(database: PayoutDatabase, cipher: RuntimeSecretCipher, access: PayoutAccess, input: unknown, now: number) {
  payoutTime(now);
  const { requestId, ...fields } = accountCommand.parse(input), destination = payoutDestination.parse(fields);
  return database.write(sql => {
    payoutAccess(sql, access, "owner");
    const prior = sql.prepare("SELECT * FROM epay_payout_accounts WHERE merchant_id=? AND request_id=?").get(access.epayMerchantId, requestId) as AccountRow | undefined;
    if (prior) {
      if (prior.created_by !== access.userId || JSON.stringify(readPayoutDestination(sql, cipher, prior.account_id, access.epayMerchantId)) !== JSON.stringify(destination)) throw new PayoutConflict("payout account request conflict");
      return project(prior);
    }
    const count = Number(sql.prepare("SELECT count(*) n FROM epay_payout_accounts WHERE merchant_id=? AND status IN ('PENDING','APPROVED')").get(access.epayMerchantId)?.n);
    if (count >= 10) throw new PayoutConflict("too many active payout accounts");
    const id = randomUUID(), encrypted = cipher.encrypt(secretName(access.epayMerchantId, id), 1, JSON.stringify(destination));
    const label = `${destination.kind === "bank" ? destination.bankName : destination.kind === "alipay" ? "支付宝" : "微信零钱"} · ${destination.holderName.slice(0, 1)}*** · 尾号 ${destination.account.slice(-4)}`;
    sql.prepare(`INSERT INTO epay_payout_accounts(account_id,request_id,merchant_id,kind,masked_label,nonce,ciphertext,authentication_tag,status,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?,'PENDING',?,?)`).run(id, requestId, access.epayMerchantId, destination.kind, label, encrypted.nonce, encrypted.ciphertext, encrypted.authenticationTag, access.userId!, now);
    appendAuditEvent(sql, { occurredAt: now, actorType: access.role === "admin" ? "ADMIN" : "SYSTEM", actorId: access.userId!, action: "epay.payout_account.submitted", outcome: "SUCCESS", subjectType: "payout_account", subjectId: id, details: { merchantId: access.epayMerchantId, kind: destination.kind } });
    return project(payoutAccount(sql, id, access.epayMerchantId));
  });
}

export function reviewPayoutAccount(database: PayoutDatabase, access: PayoutAccess, id: string, input: unknown, now: number) {
  payoutTime(now); const command = reviewCommand.parse(input);
  return database.write(sql => {
    payoutAccess(sql, access, "admin");
    const row = payoutAccount(sql, id, access.epayMerchantId), status = command.decision === "approve" ? "APPROVED" : command.decision === "reject" ? "REJECTED" : "REVOKED";
    if (row.status === status && row.reviewed_by === access.userId && row.review_reference === command.reference) return project(row);
    if (row.status !== (status === "REVOKED" ? "APPROVED" : "PENDING") || now < Number(row.created_at)) throw new PayoutConflict("payout account already reviewed");
    sql.prepare("UPDATE epay_payout_accounts SET status=?,reviewed_by=?,reviewed_at=?,review_reference=? WHERE account_id=?").run(status, access.userId!, now, command.reference, id);
    appendAuditEvent(sql, { occurredAt: now, actorType: "ADMIN", actorId: access.userId!, action: "epay.payout_account.reviewed", outcome: "SUCCESS", subjectType: "payout_account", subjectId: id, details: { decision: command.decision, reference: command.reference } });
    return project(payoutAccount(sql, id, access.epayMerchantId));
  });
}

export function listPayoutAccounts(database: PayoutDatabase, access: PayoutAccess, page: number) {
  const offset = payoutPage(page);
  return database.read(sql => {
    payoutAccess(sql, access, "read");
    const rows = sql.prepare("SELECT * FROM epay_payout_accounts WHERE merchant_id=? ORDER BY created_at DESC,account_id LIMIT 21 OFFSET ?").all(access.epayMerchantId, offset) as AccountRow[];
    return { accounts: rows.slice(0, 20).map(project), hasNext: rows.length > 20 };
  });
}

export function revealPayoutAccount(database: PayoutDatabase, cipher: RuntimeSecretCipher, access: PayoutAccess, id: string, now: number) {
  payoutTime(now);
  return database.write(sql => {
    payoutAccess(sql, access, "admin");
    const destination = readPayoutDestination(sql, cipher, id, access.epayMerchantId);
    appendAuditEvent(sql, { occurredAt: now, actorType: "ADMIN", actorId: access.userId!, action: "epay.payout_account.viewed", outcome: "SUCCESS", subjectType: "payout_account", subjectId: id, details: { merchantId: access.epayMerchantId } });
    return destination;
  });
}
