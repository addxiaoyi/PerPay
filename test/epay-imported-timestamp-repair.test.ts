import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { captureEPaySnapshot, SOURCE_TABLES, type SnapshotSource } from "../src/epay-compat/snapshot.ts";
import { MAPPED_COLUMNS } from "../src/epay-compat/isolated-import.ts";
import { importCandidate } from "../src/epay-compat/candidate-import.ts";
import { planImportedTimestampRepair, repairImportedTimestamps, timestampRepairInvariants } from "../src/epay-compat/imported-timestamp-repair.ts";
import { parseSourceTimestamp } from "../src/epay-compat/source-timestamp.ts";

const date = "2026-10-20 12:34:56.789";
const created = { createdAt: date, updatedAt: date };
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "epay-timestamp-repair-"));
  const masterKey = randomBytes(32);
  const snapshotDb = await AppDatabase.open(join(directory, "snapshot.sqlite"), { masterKey });
  const target = await AppDatabase.open(join(directory, "target.sqlite"), { masterKey });
  const rows: Record<string, Record<string, unknown>[]> = {
    Merchant: [{ id: 17, name: "fixture", money: "12.34", status: 1, apiKey: "fixture-only", ...created }],
    MerchantBinding: [{ id: "binding", mainApiId: "api", mainMerchantId: "main", epayMerchantId: 17, ...created }],
    PayType: [{ id: 1, code: "alipay", name: "支付宝", enabled: 1, sort: 1, ...created }],
    Channel: [{ id: 1, typeId: 1, provider: "alipay", code: "alipay", name: "fixture", product: "face", enabled: 1, rate: "0.05", ...created }],
    Order: [{ tradeNo: "trade", outTradeNo: "external", merchantId: 17, typeId: 1, channelId: 1, name: "fixture", money: "12.34", notifyUrl: "https://example.com/notify", status: "PAID", notifyStatus: "SUCCESS", notifyCount: 1, paidAt: date, ...created }],
    NotifyLog: [{ id: 1, tradeNo: "trade", url: "https://example.com/notify", params: {}, status: "SUCCESS", createdAt: date }],
    Invoice: [{ id: "invoice", tradeNo: "trade", kind: "normal", merchantId: 17, title: "fixture", amount: "12.34", status: "ISSUED", provider: "fixture", serviceFee: "0.01", issuedAt: date, chargedAt: date, ...created }],
    InvoiceApplication: [{ id: "application", merchantId: 17, tradeNo: "trade", outTradeNo: "external", title: "fixture", taxId: "fixture", email: "fixture@example.com", feeCents: 1, status: "ISSUED", emailSent: 1, issuedAt: date, ...created }],
    Config: [{ key: "empty", value: null, updatedAt: date }, { key: "secret", value: "fixture-only", updatedAt: date }],
  };
  const source: SnapshotSource = { async query(sql) {
    const name = /^SELECT \* FROM `([^`]+)`/.exec(sql)?.[1];
    if (!name) return [[], []];
    const columns = MAPPED_COLUMNS[name] ?? [SOURCE_TABLES[name as keyof typeof SOURCE_TABLES]];
    return [(rows[name] ?? []).map(row => Object.fromEntries(columns.map(column => [column, row[column] ?? null]))), columns.map(name => ({ name }))];
  } };
  const options = { source, database: snapshotDb, masterKey, instanceId: snapshotDb.instanceId(), sourceName: "fixture", requireColumnMetadata: true, sourceOffsetMinutes: 480 };
  const snapshot = await captureEPaySnapshot(options);
  importCandidate(target, options, snapshot.snapshotId, { merchants: [{ id: "main", apiId: "api", feeRate: 0.05 }], ledger: [], orders: [], refunds: [], settlements: [], callbacks: [], syncJobs: [], balanceSummaryVersion: 1, balanceSummaries: {} });
  return { target, snapshotDb, options: { ...options, snapshotId: snapshot.snapshotId, evidenceSha256: "a".repeat(64) }, close() {
    target.close(); snapshotDb.close(); masterKey.fill(0); rmSync(directory, { recursive: true, force: true });
  } };
}

it("corrects every imported mapping from the encrypted archive and keeps financial/config records intact", async () => {
  const f = await fixture();
  try {
    f.target.write(db => db.prepare("INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,frozen_delta_cents,occurred_at,source) VALUES('later',17,'manual_adjustment',10,0,?,'main_site')").run(Date.now()));
    const before = f.target.read(timestampRepairInvariants);
    const plan = f.target.read(db => planImportedTimestampRepair(db, f.options));
    assert.equal(plan.summary.changedValues, 22);
    assert.equal(Object.keys(plan.summary.tables).length, 11);
    const report = f.target.write(db => repairImportedTimestamps(db, f.options, plan.summary.planSha256));
    assert.equal(report.nonDateFieldsUnchanged, true);
    assert.equal(f.target.read(timestampRepairInvariants), before);
    const order = f.target.read(db => db.prepare("SELECT created_at,paid_at,notify_last_at FROM epay_orders").get());
    assert.equal(order?.created_at, BigInt(Date.parse("2026-10-20T12:34:56.789Z")));
    assert.equal(order?.notify_last_at, null);
    const repeat = f.target.read(db => planImportedTimestampRepair(db, f.options));
    assert.equal(repeat.changes.length, 0);
    assert.equal(f.target.write(db => repairImportedTimestamps(db, f.options, repeat.summary.planSha256)).changedValues, 0);
    assert.equal(f.target.integrityCheck().ok, true);
  } finally { f.close(); }
});

it("rejects changed imported dates without modifying any record", async () => {
  const f = await fixture();
  try {
    f.target.write(db => db.prepare("UPDATE epay_orders SET updated_at=updated_at+1").run());
    assert.throws(() => f.target.read(db => planImportedTimestampRepair(db, f.options)), /changed target date/);
    assert.equal(f.target.read(db => db.prepare("SELECT created_at FROM epay_merchant_accounts").get()?.created_at), BigInt(parseSourceTimestamp(date, 480)));
  } finally { f.close(); }
});

it("rolls back all date changes when a trigger alters a protected amount", async () => {
  const f = await fixture();
  try {
    const plan = f.target.read(db => planImportedTimestampRepair(db, f.options));
    f.target.write(db => db.exec("CREATE TRIGGER bad_repair AFTER UPDATE OF created_at ON epay_orders BEGIN UPDATE epay_merchant_accounts SET balance_cents=0; END"));
    assert.throws(() => f.target.write(db => repairImportedTimestamps(db, f.options, plan.summary.planSha256)), /protected non-date fields/);
    assert.equal(f.target.read(db => db.prepare("SELECT balance_cents FROM epay_merchant_accounts").get()?.balance_cents), 1234n);
    assert.equal(f.target.read(db => planImportedTimestampRepair(db, f.options)).summary.planSha256, plan.summary.planSha256);
  } finally { f.close(); }
});

it("requires authenticated source, matching import, transaction and reviewed plan", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.target.read(db => planImportedTimestampRepair(db, { ...f.options, masterKey: randomBytes(32) })), /authentication failed/);
    assert.throws(() => f.target.read(db => planImportedTimestampRepair(db, { ...f.options, snapshotId: "wrong" })), /provenance mismatch/);
    assert.throws(() => f.target.read(db => repairImportedTimestamps(db, f.options, "wrong")), /transaction/);
    assert.throws(() => f.target.write(db => repairImportedTimestamps(db, f.options, "wrong")), /plan changed/);
    f.target.write(db => db.prepare("INSERT INTO system_metadata VALUES('epay_cutover','{}',0)").run());
    assert.throws(() => f.target.read(db => planImportedTimestampRepair(db, f.options)), /uncut candidate/);
  } finally { f.close(); }
});

it("uses explicit UTC semantics and rejects invalid calendar values", () => {
  assert.equal(parseSourceTimestamp(date, 0), Date.parse("2026-10-20T12:34:56.789Z"));
  assert.equal(parseSourceTimestamp(date, 480), Date.parse("2026-10-20T04:34:56.789Z"));
  for (const invalid of ["2026-02-30 12:00:00", "2026-10-20 24:00:00", "2026-10-20T12:00:00Z", null]) assert.throws(() => parseSourceTimestamp(invalid, 0));
});
