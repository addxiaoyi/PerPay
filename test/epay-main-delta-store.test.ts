import assert from "node:assert/strict";
import { it } from "node:test";
import { balanceFixture } from "./epay-live-balance-fixture.ts";
import { installBalanceOpenings, planBalanceOpenings } from "../src/epay-compat/balance-opening.ts";
import { applyMainPaymentDelta, readCurrentMainPayment } from "../src/epay-compat/main-delta-store.ts";
import { readLiveBalance } from "../src/epay-compat/live-balance.ts";
import { readMainPaymentArchive } from "../src/epay-compat/main-payment-archive.ts";
import { canonicalSource } from "../src/epay-compat/source-drift.ts";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { AppDatabase } from "../src/database/database.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";

const OPENED_AT = 1_800_000_000_000;
const hash = (value: unknown) => createHash("sha256").update(canonicalSource(value)).digest("hex");
type Snapshot = Record<string, unknown> & { merchants: Record<string, unknown>[]; orders: Record<string, unknown>[]; ledger: Record<string, unknown>[] };

async function fixture() {
  const f = await balanceFixture();
  const baseline = f.db.read(sql => JSON.parse(readMainPaymentArchive(sql, f.cipher)!)) as Snapshot;
  f.db.write(sql => {
    installBalanceOpenings(sql, f.cipher, planBalanceOpenings(sql, f.cipher, "a".repeat(64)), OPENED_AT);
  });
  const apply = (payment: unknown, expectedSha256 = hash(baseline), millis = OPENED_AT + 1000) =>
    f.db.write(sql => applyMainPaymentDelta(sql, f.cipher, { payment, expectedSha256, capturedAt: new Date(millis).toISOString(), responseSha256: "b".repeat(64), appliedAt: millis }));
  return { ...f, baseline, apply };
}

it("persists an encrypted cursor and posts each new legacy ledger entry once across reopen", async () => {
  const f = await fixture();
  let reopened: AppDatabase | undefined;
  try {
    const current = structuredClone(f.baseline);
    current.ledger.push({ id: "legacy-adjust-1", merchantId: "main-1", type: "manual_adjustment", availableDelta: 25, frozenDelta: 0, at: new Date(OPENED_AT + 500).toISOString(), actorId: "admin-1", reason: "synthetic adjustment" });
    current.balanceSummaries = { "main-1": { availableCents: 25, frozenCents: 0 } };
    const applied = f.apply(current);
    assert.equal(applied.postedEntries, 1);
    assert.equal(applied.sequence, 1);
    assert.equal(f.apply(current, hash(current)).duplicate, true);
    f.db.read(sql => {
      assert.equal(readLiveBalance(sql, 1).availableCents, 975);
      assert.equal(readLiveBalance(sql, 2).availableCents, 1900);
      assert.deepEqual(readCurrentMainPayment(sql, f.cipher).payment, current);
      assert.deepEqual(JSON.parse(readMainPaymentArchive(sql, f.cipher)!), f.baseline);
      assert.equal(Number(sql.prepare("SELECT count(*) n FROM epay_callback_jobs").get()?.n), 0);
      const row = sql.prepare("SELECT ciphertext FROM epay_main_sync_runs").get()!;
      assert.equal(Buffer.from(row.ciphertext as Uint8Array).includes(Buffer.from("synthetic adjustment")), false);
    });
    f.db.close();
    reopened = await AppDatabase.open(join(f.directory, "db.sqlite"), { masterKey: f.key });
    const cipher = new RuntimeSecretCipher(f.key, reopened.instanceId());
    reopened.read(sql => {
      assert.deepEqual(readCurrentMainPayment(sql, cipher).payment, current);
      assert.equal(readLiveBalance(sql, 1).availableCents, 975);
    });
  } finally { reopened?.close(); f.close(); }
});

it("rolls back the cursor, source records and balance together on a posting failure", async () => {
  const f = await fixture();
  try {
    const current = structuredClone(f.baseline);
    current.ledger.push(...[1, 2].map(n => ({ id: `legacy-adjust-${n}`, merchantId: "main-1", type: "manual_adjustment", availableDelta: 25, frozenDelta: 0, at: new Date(OPENED_AT + 500).toISOString(), actorId: "admin-1", reason: "synthetic" })));
    current.balanceSummaries = { "main-1": { availableCents: 50, frozenCents: 0 } };
    f.db.write(sql => sql.exec("CREATE TRIGGER fail_second_delta BEFORE INSERT ON epay_balance_ledger WHEN NEW.entry_id='legacy-adjust-2' BEGIN SELECT RAISE(ABORT,'injected posting failure'); END"));
    assert.throws(() => f.apply(current), /injected posting failure/);
    f.db.read(sql => {
      assert.equal(Number(sql.prepare("SELECT count(*) n FROM epay_main_sync_runs").get()?.n), 0);
      assert.equal(Number(sql.prepare("SELECT count(*) n FROM epay_balance_ledger WHERE source='main_site_delta'").get()?.n), 0);
      assert.equal(readLiveBalance(sql, 1).availableCents, 950);
    });
  } finally { f.close(); }
});

it("rejects stale cursors, foreign merchants, financial tampering and missing summary proof", async () => {
  const f = await fixture();
  try {
    const mutations = [
      (p: Snapshot) => { p.merchants[0]!.apiId = "other-api"; },
      (p: Snapshot) => { p.ledger.push({ id: "unknown", merchantId: "other", type: "manual_adjustment", availableDelta: 1, frozenDelta: 0 }); },
      (p: Snapshot) => { p.balanceSummaryVersion = 0; },
    ];
    for (const mutate of mutations) {
      const current = structuredClone(f.baseline);
      mutate(current);
      assert.throws(() => f.apply(current));
    }
    assert.throws(() => f.apply(f.baseline, "0".repeat(64)), /cursor/);
    assert.throws(() => f.apply(f.baseline, hash(f.baseline), OPENED_AT - 1), /cutoff/);
    f.db.read(sql => assert.equal(Number(sql.prepare("SELECT count(*) n FROM epay_main_sync_runs").get()?.n), 0));
  } finally { f.close(); }
});

it("keeps source history immutable and never replays old callbacks", async () => {
  const f = await fixture();
  try {
    const first = f.apply(f.baseline);
    assert.equal(first.sequence, 1);
    assert.equal(first.postedEntries, 0);
    f.db.write(sql => {
      assert.throws(() => sql.exec("UPDATE epay_main_sync_runs SET source_sha256='0'"), /immutable/);
      assert.throws(() => sql.exec("DELETE FROM epay_main_sync_runs"), /immutable/);
      assert.equal(Number(sql.prepare("SELECT count(*) n FROM epay_callback_jobs").get()?.n), 0);
    });
  } finally { f.close(); }
});

it("accepts authoritative member and security changes without stopping legacy payment synchronization", async () => {
  const f = await fixture();
  try {
    const updated = structuredClone(f.baseline);
    Object.assign(updated.merchants[0]!, { members: [{ userId: "member-1", enabled: true }], enabled: false, updatedAt: new Date(OPENED_AT + 1).toISOString() });
    assert.equal(f.apply(updated).postedEntries, 0);
    assert.equal(Number(f.db.read(sql => sql.prepare("SELECT enabled FROM epay_merchant_accounts WHERE merchant_id=1").get()?.enabled)), 0);
    assert.equal(f.db.read(sql => readLiveBalance(sql, 1)).availableCents, 950);
    const changedFee = structuredClone(updated);
    changedFee.merchants[0]!.feeRate = 0.10;
    assert.throws(() => f.apply(changedFee, hash(updated)), /merchant/);
    const restored = structuredClone(updated);
    restored.merchants[0]!.enabled = true;
    restored.merchants[0]!.updatedAt = new Date(OPENED_AT + 2000).toISOString();
    assert.equal(f.apply(restored, hash(updated), OPENED_AT + 2000).postedEntries, 0);
    assert.equal(Number(f.db.read(sql => sql.prepare("SELECT enabled FROM epay_merchant_accounts WHERE merchant_id=1").get()?.enabled)), 1);
  } finally { f.close(); }
});

it("mirrors settlement decisions only with their matching ledger movement", async () => {
  const f = await fixture();
  try {
    const pending = structuredClone(f.baseline);
    pending.settlements = [{ id: "settlement", merchantId: "main-1", amountCents: 100, status: "pending", note: "synthetic" }];
    pending.ledger.push({ id: "freeze", merchantId: "main-1", type: "settlement_freeze", settlementId: "settlement", availableDelta: -100, frozenDelta: 100, at: new Date(OPENED_AT + 500).toISOString() });
    pending.balanceSummaries = { "main-1": { availableCents: -100, frozenCents: 100 } };
    f.apply(pending);
    const decided = structuredClone(pending);
    Object.assign((decided.settlements as Record<string, unknown>[])[0]!, { status: "rejected", reviewedBy: "admin", reviewedAt: new Date(OPENED_AT + 1500).toISOString(), reference: null });
    assert.throws(() => f.apply(decided, hash(pending), OPENED_AT + 2000), /settlement/);
    decided.ledger.push({ id: "unfreeze", merchantId: "main-1", type: "settlement_unfreeze", settlementId: "settlement", availableDelta: 100, frozenDelta: -100, at: new Date(OPENED_AT + 1500).toISOString() });
    decided.balanceSummaries = {};
    assert.equal(f.apply(decided, hash(pending), OPENED_AT + 2000).postedEntries, 1);
    f.db.read(sql => {
      assert.equal(readLiveBalance(sql, 1).availableCents, 950);
      assert.equal(readLiveBalance(sql, 1).frozenCents, 0);
    });
  } finally { f.close(); }
});

it("admits new main merchant metadata only after a recorded zero-balance enrollment", async () => {
  const f = await fixture();
  try {
    const next = structuredClone(f.baseline);
    next.merchants.push({ id: "main-new", apiId: "api-new", userId: "new-user", feeRate: 0.05, enabled: true });
    assert.throws(() => f.apply(next), /cannot admit/);
    f.db.write(sql => {
      sql.exec(`INSERT INTO epay_merchant_accounts VALUES(4,'New',0,1,500,0,0);
        INSERT INTO epay_merchant_bindings VALUES('binding-new','api-new','main-new',4,0,0);
        INSERT INTO epay_merchant_creation_requests VALUES('00000000-0000-4000-8000-000000000001','new-user','New','https://new.example/notify','admin',0);
        INSERT INTO epay_merchant_enrollments VALUES('main-new','api-new',4,'00000000-0000-4000-8000-000000000001','new-user','${"e".repeat(64)}',0);
        INSERT INTO epay_balance_openings VALUES(4,'native:fixture',0,0,0,'${"a".repeat(64)}','${"b".repeat(64)}',0);
        INSERT INTO epay_live_balances VALUES(4,0,0,0)`);
    });
    const tampered = structuredClone(next);
    tampered.merchants[2]!.apiId = "different";
    assert.throws(() => f.apply(tampered), /cannot admit/);
    assert.equal(f.apply(next).postedEntries, 0);
    assert.equal(f.db.read(sql => readLiveBalance(sql, 4)).availableCents, 0);
    assert.equal(f.db.read(sql => readLiveBalance(sql, 1)).availableCents, 950);
    assert.equal(f.apply(next, hash(next)).duplicate, true);
  } finally { f.close(); }
});
