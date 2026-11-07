import assert from "node:assert/strict";
import { it } from "node:test";
import { balanceFixture } from "./epay-live-balance-fixture.ts";
import { installBalanceOpenings, planBalanceOpenings } from "../src/epay-compat/balance-opening.ts";
import { readLiveBalance } from "../src/epay-compat/live-balance.ts";
import { initializeLegacyCursor, applyLegacyDelta, readLegacyCursor, type LegacyTables } from "../src/epay-compat/legacy-delta.ts";
import { applySharedPaymentDelta } from "../src/epay-compat/shared-delta.ts";
import { readCurrentMainPayment } from "../src/epay-compat/main-delta-store.ts";
import { canonicalSource } from "../src/epay-compat/source-drift.ts";
import { createHash } from "node:crypto";

const CUTOFF = 1_800_000_000_000;

it("keeps late legacy liabilities unchanged when an enrolled zero-balance merchant joins the shared snapshot", async () => {
  const f = await fixture();
  try {
    f.db.write(sql => sql.exec(`INSERT INTO epay_merchant_accounts VALUES(4,'New',0,1,500,0,0);
      INSERT INTO epay_merchant_bindings VALUES('binding-new','api-new','main-new',4,0,0);
      INSERT INTO epay_merchant_creation_requests VALUES('00000000-0000-4000-8000-000000000001','new-user','New','https://new.example/notify','admin',0);
      INSERT INTO epay_merchant_enrollments VALUES('main-new','api-new',4,'00000000-0000-4000-8000-000000000001','new-user','${"a".repeat(64)}',0);
      INSERT INTO epay_balance_openings VALUES(4,'native:fixture',0,0,0,'${"a".repeat(64)}','${"b".repeat(64)}',0);
      INSERT INTO epay_live_balances VALUES(4,0,0,0)`));
    const payment = f.db.read(sql => structuredClone(readCurrentMainPayment(sql, f.cipher).payment));
    payment.merchants.push({ id: "main-new", apiId: "api-new", userId: "new-user", feeRate: 0.05, enabled: true });
    const capture = { version: 1 as const, sharedCutoff: true as const, cutoff: new Date(CUTOFF + 1000).toISOString(), lockedAt: CUTOFF + 999,
      lockCompletedAt: CUTOFF + 1001, tables: f.tables, columns: f.columns, mainPayment: payment, mainResponseSha256: "c".repeat(64),
      sourceSha256: createHash("sha256").update(canonicalSource({ tables: f.tables, columns: f.columns, payment })).digest("hex") };
    const synced = applySharedPaymentDelta(f.db, f.cipher, capture, CUTOFF + 1002);
    assert.equal(synced.mainPostedEntries, 0);
    assert.equal(synced.legacyPostedEntries, 0);
    assert.equal(f.db.read(sql => readLiveBalance(sql, 1)).availableCents, 950);
    assert.equal(f.db.read(sql => readLiveBalance(sql, 4)).availableCents, 0);
    assert.equal(applySharedPaymentDelta(f.db, f.cipher, capture, CUTOFF + 1003).duplicate, true);
  } finally { f.close(); }
});

async function fixture() {
  const f = await balanceFixture();
  const tables: LegacyTables = { Merchant: [], AdminSession: [], MerchantBinding: [], MerchantInvoiceConfig: [], PayType: [], Channel: [], Order: [], NotifyLog: [], Invoice: [], InvoiceApplication: [], Config: [] };
  tables.Merchant = [{ id: 1 }, { id: 2 }, { id: 3 }];
  tables.Order = [1, 2].map(id => ({ tradeNo: `legacy-${id}`, outTradeNo: `legacy-${id}`, merchantId: id,
    money: `${id}0.00`, getMoney: `${id}0.00`, status: "PAID", createdAt: "1970-01-01 00:00:00", paidAt: "1970-01-01 00:00:00", updatedAt: "1970-01-01 00:00:00",
    notifyStatus: "SUCCESS", notifyCount: 1, notifyLastAt: null }));
  tables.Order.push({ ...tables.Order[0], tradeNo: "late", outTradeNo: "late", money: "1.10", getMoney: null, status: "PENDING", paidAt: null, notifyCount: 0 });
  const columns = { Merchant: ["id"], AdminSession: ["id"], MerchantBinding: ["id"], MerchantInvoiceConfig: ["merchantId"], PayType: ["id"], Channel: ["id"], Order: Object.keys(tables.Order[0]!), NotifyLog: ["id"], Invoice: ["id"], InvoiceApplication: ["id"], Config: ["key"] };
  f.db.write(sql => {
    sql.exec(`INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at)
      VALUES('late','late',1,'late',110,'https://example.test','PENDING','SUCCESS',0,0,0)`);
    installBalanceOpenings(sql, f.cipher, planBalanceOpenings(sql, f.cipher, "a".repeat(64)), CUTOFF);
    initializeLegacyCursor(sql, f.cipher, { tables, columns, capturedAt: CUTOFF, sourceOffsetMinutes: 0 });
  });
  const apply = (next: LegacyTables) => f.db.write(sql => applyLegacyDelta(sql, f.cipher, {
    tables: next, columns, expectedSha256: readLegacyCursor(sql, f.cipher).sourceSha256,
    capturedAt: CUTOFF + 1000, appliedAt: CUTOFF + 1001, responseSha256: "b".repeat(64),
  }));
  return { ...f, tables, columns, apply };
}

it("synchronizes a late legacy payment once, keeps native orders and never queues its callback", async () => {
  const f = await fixture();
  try {
    const next = structuredClone(f.tables);
    Object.assign(next.Order[2]!, { status: "PAID", getMoney: "1.10", paidAt: "2027-01-15 08:00:00", updatedAt: "2027-01-15 08:00:00", notifyStatus: "FAILED", notifyCount: 1 });
    f.db.write(sql => sql.exec(`INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at)
      VALUES('native','native',1,'native',500,'https://example.test','PENDING','PENDING',0,0,0)`));
    assert.equal(f.apply(next).postedEntries, 1);
    assert.equal(f.apply(next).duplicate, true);
    f.db.read(sql => {
      assert.equal(readLiveBalance(sql, 1).availableCents, 1054);
      assert.equal(readLiveBalance(sql, 2).availableCents, 1900);
      assert.equal(sql.prepare("SELECT status FROM epay_orders WHERE trade_no='late'").get()?.status, "PAID");
      assert.equal(sql.prepare("SELECT status FROM epay_orders WHERE trade_no='native'").get()?.status, "PENDING");
      assert.equal(Number(sql.prepare("SELECT count(*) n FROM epay_callback_jobs").get()?.n), 0);
      assert.equal(readLegacyCursor(sql, f.cipher).tables.Order[2]!.status, "PAID");
    });
  } finally { f.close(); }
});

it("rejects reassignment, amount edits, deletion, new legacy orders and source configuration drift", async () => {
  const f = await fixture();
  try {
    for (const mutate of [
      (t: LegacyTables) => { t.Order[2]!.merchantId = 2; },
      (t: LegacyTables) => { t.Order[2]!.money = "2.00"; },
      (t: LegacyTables) => { t.Order.pop(); },
      (t: LegacyTables) => { t.Order.push({ ...t.Order[2], tradeNo: "unexpected" }); },
      (t: LegacyTables) => { t.Config.push({ key: "appId", value: "different" }); },
    ]) {
      const next = structuredClone(f.tables); mutate(next);
      assert.throws(() => f.apply(next));
    }
    f.db.read(sql => assert.equal(readLegacyCursor(sql, f.cipher).sequence, 1));
  } finally { f.close(); }
});

it("rolls back imported statuses, encrypted cursor and liability when a posting fails", async () => {
  const f = await fixture();
  try {
    const next = structuredClone(f.tables);
    Object.assign(next.Order[2]!, { status: "PAID", getMoney: "1.10", paidAt: "2027-01-15 08:00:00", updatedAt: "2027-01-15 08:00:00" });
    f.db.write(sql => sql.exec("CREATE TRIGGER reject_legacy_post BEFORE INSERT ON epay_balance_ledger WHEN NEW.source='legacy_epay_delta' BEGIN SELECT RAISE(ABORT,'injected legacy posting failure'); END"));
    assert.throws(() => f.apply(next), /injected legacy posting failure/);
    f.db.read(sql => {
      assert.equal(readLegacyCursor(sql, f.cipher).sequence, 1);
      assert.equal(sql.prepare("SELECT status FROM epay_orders WHERE trade_no='late'").get()?.status, "PENDING");
      assert.equal(readLiveBalance(sql, 1).availableCents, 950);
    });
  } finally { f.close(); }
});

it("keeps source cursors immutable and refuses stale capture proofs", async () => {
  const f = await fixture();
  try {
    f.db.write(sql => {
      assert.throws(() => sql.exec("DELETE FROM epay_legacy_sync_runs"), /immutable/);
      assert.throws(() => sql.exec("UPDATE epay_legacy_sync_runs SET captured_at=1"), /immutable/);
      assert.throws(() => applyLegacyDelta(sql, f.cipher, { tables: f.tables, columns: f.columns, expectedSha256: "0".repeat(64), capturedAt: CUTOFF + 1000, appliedAt: CUTOFF + 1001, responseSha256: "a".repeat(64) }), /cursor/);
    });
  } finally { f.close(); }
});

it("commits both legacy sources together and preserves both cursors on a downstream failure", async () => {
  const f = await fixture();
  try {
    const tables = structuredClone(f.tables);
    Object.assign(tables.Order[2]!, { status: "PAID", getMoney: "1.10", paidAt: "2027-01-15 08:00:00", updatedAt: "2027-01-15 08:00:00" });
    const payment = f.db.read(sql => structuredClone(readCurrentMainPayment(sql, f.cipher).payment));
    payment.ledger.push({ id: "main-late", merchantId: "main-1", type: "manual_adjustment", availableDelta: 25, frozenDelta: 0, actorId: "admin", reason: "synthetic", at: new Date(CUTOFF + 500).toISOString() });
    payment.balanceSummaries = { "main-1": { availableCents: 25, frozenCents: 0 } };
    const columns = f.columns;
    const capture = { version: 1 as const, sharedCutoff: true as const, cutoff: new Date(CUTOFF + 1000).toISOString(), lockedAt: CUTOFF + 999, lockCompletedAt: CUTOFF + 1001,
      tables, columns, mainPayment: payment, mainResponseSha256: "c".repeat(64), sourceSha256: createHash("sha256").update(canonicalSource({ tables, columns, payment })).digest("hex") };
    f.db.write(sql => sql.exec("CREATE TRIGGER fail_shared_legacy BEFORE INSERT ON epay_balance_ledger WHEN NEW.source='legacy_epay_delta' BEGIN SELECT RAISE(ABORT,'injected shared failure'); END"));
    assert.throws(() => applySharedPaymentDelta(f.db, f.cipher, capture, CUTOFF + 1002), /injected shared failure/);
    f.db.read(sql => {
      assert.equal(readCurrentMainPayment(sql, f.cipher).sequence, 0);
      assert.equal(readLegacyCursor(sql, f.cipher).sequence, 1);
      assert.equal(readLiveBalance(sql, 1).availableCents, 950);
      assert.equal(sql.prepare("SELECT value FROM system_metadata WHERE key='epay_source_sync'").get(), undefined);
    });
    f.db.write(sql => sql.exec("DROP TRIGGER fail_shared_legacy"));
    const applied = applySharedPaymentDelta(f.db, f.cipher, capture, CUTOFF + 1002);
    assert.equal(applied.mainPostedEntries, 1);
    assert.equal(applied.legacyPostedEntries, 1);
    f.db.read(sql => assert.equal(readLiveBalance(sql, 1).availableCents, 1079));
    assert.equal(applySharedPaymentDelta(f.db, f.cipher, capture, CUTOFF + 1003).duplicate, true);
  } finally { f.close(); }
});
