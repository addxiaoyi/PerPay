import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { AppDatabase } from "../src/database/database.ts";
import { balanceFixture } from "./epay-live-balance-fixture.ts";
import { installBalanceOpenings, planBalanceOpenings } from "../src/epay-compat/balance-opening.ts";
import { readLiveBalance } from "../src/epay-compat/live-balance.ts";
import { decideSettlement, auditNativeSettlements } from "../src/epay-compat/settlement-workflow.ts";
import { addPayoutAccount, reviewPayoutAccount, listPayoutAccounts, revealPayoutAccount } from "../src/epay-compat/payout-accounts.ts";
import { requestPayout, reviewPayout, listPayouts } from "../src/epay-compat/payout-workflow.ts";
import { claimPayout, completePayout, deferPayout } from "../src/epay-compat/payout-queue.ts";
import { processPayout } from "../src/epay-compat/payout-worker.ts";
import { disabledPayoutPolicy, type PayoutPolicy, type PayoutLease } from "../src/epay-compat/payout-model.ts";
import { verifyAlipayPayoutQuery } from "../src/epay-compat/payout-evidence.ts";
import { verifyAlipayQueryAccount } from "../src/epay-compat/alipay-query-account.ts";
import { createV3ResponseSignature } from "../src/infrastructure/alipay/v3.ts";
import { accountCertificate } from "./fixtures/alipay-account-certificate.ts";

let now = Date.now();
const owner = { merchantId: "main-1", mainApiId: "api-1", epayMerchantId: 1, userId: "owner", role: "owner" as const };
const admin = { ...owner, userId: "administrator", role: "admin" as const };
const member = { ...owner, userId: "member", role: "member" as const };
const policy: PayoutPolicy = { enabled: true, channels: { alipay: { account: "2088000000000000", maxSingleCents: 900, maxDailyCents: 1000 } } };
const destination = { kind: "alipay" as const, holderName: "合成收款人", account: "recipient@example.test" };
const signing = generateKeyPairSync("rsa", { modulusLength: 2048 }), platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKey = platform.publicKey.export({ type: "spki", format: "pem" }).toString();

async function fixture() {
  const f = await balanceFixture();
  f.db.write(sql => installBalanceOpenings(sql, f.cipher, planBalanceOpenings(sql, f.cipher, "a".repeat(64)), now));
  const certificate = accountCertificate(f.directory, signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  now = Date.now();
  const account = verifyAlipayQueryAccount({ appId: "2026000000000000", sellerId: "2088000000000000", privateKey: signing.privateKey, platformPublicKey: publicKey, ...certificate }, now);
  const proof = (lease: PayoutLease, state: string, time: number) => {
    const body = JSON.stringify({ out_biz_no: lease.outNo, order_id: "verified-transfer", trans_amount: (lease.amountCents / 100).toFixed(2), status: state });
    const response = { status: 200, body: Buffer.from(body), headers: { "alipay-timestamp": String(time), "alipay-nonce": "test", "alipay-signature": createV3ResponseSignature(body, String(time), "test", platform.privateKey) } };
    return verifyAlipayPayoutQuery(lease, destination, response, account, publicKey, time);
  };
  return { ...f, proof };
}

it("encrypts reviewed payout destinations and never lets members, peers or client flags approve them", async () => {
  const f = await fixture();
  try {
    assert.throws(() => addPayoutAccount(f.db, f.cipher, member, { ...destination, requestId: "account-request-001" }, now), /forbidden/);
    assert.throws(() => addPayoutAccount(f.db, f.cipher, owner, { ...destination, requestId: "account-request-001", approved: true }, now));
    const saved = addPayoutAccount(f.db, f.cipher, owner, { ...destination, requestId: "account-request-001" }, now);
    assert.equal(saved.status, "PENDING");
    assert.equal(addPayoutAccount(f.db, f.cipher, owner, { ...destination, requestId: "account-request-001" }, now).id, saved.id);
    assert.throws(() => addPayoutAccount(f.db, f.cipher, owner, { ...destination, account: "other@example.test", requestId: "account-request-001" }, now));
    assert.equal(JSON.stringify(listPayoutAccounts(f.db, owner, 1)).includes(destination.account), false);
    assert.equal(JSON.stringify(f.db.read(sql => sql.prepare("SELECT * FROM epay_payout_accounts").all()), (_, value) => typeof value === "bigint" ? String(value) : value).includes(destination.account), false);
    assert.throws(() => revealPayoutAccount(f.db, f.cipher, owner, saved.id, now), /forbidden/);
    assert.throws(() => reviewPayoutAccount(f.db, owner, saved.id, { decision: "approve", reference: "ownership checked" }, now), /forbidden/);
    assert.throws(() => reviewPayoutAccount(f.db, { ...admin, merchantId: "main-2", mainApiId: "api-2", epayMerchantId: 2 }, saved.id, { decision: "approve", reference: "ownership checked" }, now));
    assert.deepEqual(revealPayoutAccount(f.db, f.cipher, admin, saved.id, now), destination);
    assert.equal(reviewPayoutAccount(f.db, admin, saved.id, { decision: "approve", reference: "verified synthetic owner" }, now + 1).status, "APPROVED");
  } finally { f.close(); }
});

it("keeps live payout disabled by default, freezes once, and blocks manual double payment", async () => {
  const f = await fixture();
  try {
    const account = addPayoutAccount(f.db, f.cipher, owner, { ...destination, requestId: "account-request-001" }, now);
    reviewPayoutAccount(f.db, admin, account.id, { decision: "approve", reference: "verified owner" }, now);
    const input = { requestId: "payout-request-001", accountId: account.id, amountCents: 600, note: "提现" };
    assert.throws(() => requestPayout(f.db, owner, input, disabledPayoutPolicy, now), /unavailable/);
    const payout = requestPayout(f.db, owner, input, policy, now);
    assert.equal(requestPayout(f.db, owner, input, policy, now).id, payout.id);
    assert.equal(f.db.read(sql => readLiveBalance(sql, 1)).availableCents, 350);
    assert.equal(f.db.read(sql => readLiveBalance(sql, 1)).frozenCents, 600);
    for (const decision of ["paid", "rejected"]) assert.throws(() => decideSettlement(f.db, admin, payout.id, { decision, reference: "manual" }, now), /automatic payout/);
    assert.throws(() => reviewPayout(f.db, owner, payout.id, { decision: "approve", reference: "forged" }, policy, now), /forbidden/);
    assert.equal(reviewPayout(f.db, admin, payout.id, { decision: "reject", reference: "cancelled before sending" }, policy, now + 1).status, "REJECTED");
    assert.equal(f.db.read(sql => readLiveBalance(sql, 1)).availableCents, 950);
    assert.deepEqual(f.db.read(auditNativeSettlements), { settlements: 1, pending: 0, inconsistent: 0 });
  } finally { f.close(); }
});

it("restarts an uncertain payout as a query, fences stale workers and commits one final debit", async () => {
  const f = await fixture(); let db = f.db;
  try {
    const account = addPayoutAccount(db, f.cipher, owner, { ...destination, requestId: "account-request-001" }, now);
    reviewPayoutAccount(db, admin, account.id, { decision: "approve", reference: "verified owner" }, now);
    const payout = requestPayout(db, owner, { requestId: "payout-request-001", accountId: account.id, amountCents: 600, note: "提现" }, policy, now);
    reviewPayout(db, admin, payout.id, { decision: "approve", reference: "approved transfer" }, policy, now);
    const first = claimPayout(db, policy, now)!;
    assert.equal(first.action, "SUBMIT");
    assert.equal(claimPayout(db, policy, now), null);
    db.close(); db = await AppDatabase.open(join(f.directory, "db.sqlite"), { masterKey: f.key });
    const recovered = claimPayout(db, policy, now + 30_001)!;
    assert.equal(recovered.action, "QUERY");
    assert.equal(recovered.outNo, first.outNo);
    const proof = f.proof(recovered, "SUCCESS", now + 30_002);
    assert.equal(completePayout(db, first, proof, now + 30_002), false);
    assert.throws(() => completePayout(db, recovered, { ...proof, amountCents: 601 }, now + 30_002), /evidence/);
    db.write(sql => sql.exec("CREATE TRIGGER deny_payout_audit BEFORE INSERT ON audit_events WHEN NEW.action='epay.payout.succeeded' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END"));
    assert.throws(() => completePayout(db, recovered, proof, now + 30_002), /audit failure/);
    assert.equal(db.read(sql => readLiveBalance(sql, 1)).frozenCents, 600);
    db.write(sql => sql.exec("DROP TRIGGER deny_payout_audit"));
    assert.equal(completePayout(db, recovered, proof, now + 30_002), true);
    assert.equal(completePayout(db, recovered, proof, now + 30_003), false);
    assert.equal(db.read(sql => readLiveBalance(sql, 1)).availableCents, 350);
    assert.equal(db.read(sql => readLiveBalance(sql, 1)).frozenCents, 0);
    assert.equal(listPayouts(db, owner, 1).payouts[0]?.status, "SUCCEEDED");
    assert.deepEqual(db.read(auditNativeSettlements), { settlements: 1, pending: 0, inconsistent: 0 });
  } finally { db.close(); f.close(); }
});

it("keeps funds frozen on timeout, queries instead of resending and releases only authenticated failure", async () => {
  const f = await fixture();
  try {
    const account = addPayoutAccount(f.db, f.cipher, owner, { ...destination, requestId: "account-request-001" }, now);
    reviewPayoutAccount(f.db, admin, account.id, { decision: "approve", reference: "verified owner" }, now);
    const payout = requestPayout(f.db, owner, { requestId: "payout-request-001", accountId: account.id, amountCents: 600, note: "提现" }, policy, now);
    reviewPayout(f.db, admin, payout.id, { decision: "approve", reference: "approved transfer" }, policy, now);
    const first = claimPayout(f.db, policy, now)!;
    assert.equal(deferPayout(f.db, first, now + 1, "transport_unavailable"), true);
    assert.equal(f.db.read(sql => readLiveBalance(sql, 1)).frozenCents, 600);
    const retry = claimPayout(f.db, policy, now + 60_001)!;
    assert.equal(retry.action, "QUERY");
    completePayout(f.db, retry, f.proof(retry, "FAIL", now + 60_002), now + 60_002);
    assert.equal(f.db.read(sql => readLiveBalance(sql, 1)).availableCents, 950);
    assert.equal(f.db.read(sql => readLiveBalance(sql, 1)).frozenCents, 0);
    let calls = 0;
    assert.equal(await processPayout({ database: f.db, cipher: f.cipher, policy: disabledPayoutPolicy, adapters: {}, clock: () => now, onError: () => calls++ }), false);
    assert.equal(calls, 0);
  } finally { f.close(); }
});

it("applies daily limits across merchants and prevents revoked recipients from receiving a queued payment", async () => {
  const f = await fixture();
  try {
    const peer = { ...owner, merchantId: "main-2", mainApiId: "api-2", epayMerchantId: 2, userId: "peer-owner" };
    const peerAdmin = { ...peer, userId: "administrator", role: "admin" as const };
    const account = addPayoutAccount(f.db, f.cipher, owner, { ...destination, requestId: "account-request-001" }, now);
    reviewPayoutAccount(f.db, admin, account.id, { decision: "approve", reference: "verified owner" }, now);
    const peerAccount = addPayoutAccount(f.db, f.cipher, peer, { ...destination, account: "peer@example.test", requestId: "account-request-002" }, now);
    reviewPayoutAccount(f.db, peerAdmin, peerAccount.id, { decision: "approve", reference: "verified owner" }, now);
    const first = requestPayout(f.db, owner, { requestId: "payout-request-001", accountId: account.id, amountCents: 600 }, policy, now);
    const second = requestPayout(f.db, peer, { requestId: "payout-request-002", accountId: peerAccount.id, amountCents: 500 }, policy, now);
    reviewPayout(f.db, admin, first.id, { decision: "approve", reference: "approved" }, policy, now);
    assert.throws(() => reviewPayout(f.db, peerAdmin, second.id, { decision: "approve", reference: "approved" }, policy, now), /daily limit/);
    reviewPayoutAccount(f.db, admin, account.id, { decision: "revoke", reference: "recipient changed" }, now + 1);
    assert.equal(claimPayout(f.db, policy, now + 2), null);
    reviewPayout(f.db, admin, first.id, { decision: "reject", reference: "cancel unsent payout" }, policy, now + 3);
    assert.equal(f.db.read(sql => readLiveBalance(sql, 1)).availableCents, 950);
    reviewPayout(f.db, peerAdmin, second.id, { decision: "approve", reference: "approved" }, policy, now + 4);
    const original = claimPayout(f.db, policy, now + 5)!;
    deferPayout(f.db, original, now + 6, "timeout");
    const closedForNewPayouts = { ...policy, enabled: false };
    const recovery = claimPayout(f.db, closedForNewPayouts, now + 60_006)!;
    assert.equal(recovery.action, "QUERY", "stopping new payouts must not stop reconciliation of an already sent instruction");
    assert.equal(recovery.outNo, original.outNo);
    assert.equal(f.db.read(sql => readLiveBalance(sql, 2)).frozenCents, 500);
  } finally { f.close(); }
});

it("never calls an unregistered payout adapter and recovers transport errors through the original job", async () => {
  const f = await fixture(); let clock = now, sends = 0;
  try {
    const account = addPayoutAccount(f.db, f.cipher, owner, { ...destination, requestId: "account-request-001" }, now);
    reviewPayoutAccount(f.db, admin, account.id, { decision: "approve", reference: "verified owner" }, now);
    const payout = requestPayout(f.db, owner, { requestId: "payout-request-001", accountId: account.id, amountCents: 600 }, policy, now);
    reviewPayout(f.db, admin, payout.id, { decision: "approve", reference: "approved" }, policy, now);
    const errors: string[] = [];
    const options = { database: f.db, cipher: f.cipher, policy, clock: () => clock, onError: (code: string) => errors.push(code) };
    assert.equal(await processPayout({ ...options, adapters: {} }), false);
    const adapter = { payer: "2088000000000000", execute: async (lease: PayoutLease) => {
      if (lease.action === "SUBMIT") { sends++; throw new Error("synthetic response lost"); }
      return f.proof(lease, "SUCCESS", clock);
    } };
    assert.equal(await processPayout({ ...options, adapters: { alipay: adapter } }), true);
    assert.equal(f.db.read(sql => readLiveBalance(sql, 1)).frozenCents, 600);
    clock += 60_001;
    assert.equal(await processPayout({ ...options, adapters: { alipay: adapter } }), true);
    assert.equal(sends, 1);
    assert.deepEqual(errors, ["payout_requires_query"]);
    assert.equal(f.db.read(sql => readLiveBalance(sql, 1)).frozenCents, 0);
    assert.equal(listPayouts(f.db, owner, 1).payouts[0]?.status, "SUCCEEDED");
  } finally { f.close(); }
});

it("rechecks current transfer limits at dispatch without consuming a send attempt", async () => {
  const f = await fixture();
  try {
    const account = addPayoutAccount(f.db, f.cipher, owner, { ...destination, requestId: "account-request-001" }, now);
    reviewPayoutAccount(f.db, admin, account.id, { decision: "approve", reference: "verified owner" }, now);
    const payout = requestPayout(f.db, owner, { requestId: "payout-request-001", accountId: account.id, amountCents: 600 }, policy, now);
    reviewPayout(f.db, admin, payout.id, { decision: "approve", reference: "approved" }, policy, now);
    const lower = { enabled: true, channels: { alipay: { account: "2088000000000000", maxSingleCents: 500, maxDailyCents: 500 } } };
    assert.equal(claimPayout(f.db, lower, now + 1), null);
    assert.equal(Number(f.db.read(sql => sql.prepare("SELECT count(*) n FROM epay_payout_attempts").get()?.n)), 0);
    assert.equal(f.db.read(sql => readLiveBalance(sql, 1)).frozenCents, 600);
    assert.equal(claimPayout(f.db, policy, now + 2)?.action, "SUBMIT");
  } finally { f.close(); }
});
