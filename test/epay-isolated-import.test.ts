import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";

import { assertMappedSourceMetadata, createEncryptedEPayRehearsal, importEPaySnapshotIntoMemory, importEPaySnapshotInTransaction, MAPPED_COLUMNS } from "../src/epay-compat/isolated-import.ts";
import { importCombinedIsolatedSnapshot } from "../src/epay-compat/isolated-combined-import.ts";
import { deriveMerchantFeeCandidates } from "../src/epay-compat/merchant-fee-candidates.ts";
import { readEncryptedMainOrder } from "../src/epay-compat/main-order-source.ts";
import { readEncryptedMainLedgerSource } from "../src/epay-compat/main-ledger-source.ts";
import { readEncryptedMainRefund } from "../src/epay-compat/main-refund-source.ts";
import { readMainActivity } from "../src/epay-compat/main-activity-source.ts";
import { readMainPaymentArchive, preserveMainPaymentArchive } from "../src/epay-compat/main-payment-archive.ts";
import { projectMerchantLedgerBalance } from "../src/epay-compat/ledger-balance.ts";
import { AppDatabase } from "../src/database/database.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { EPAY_COMPATIBILITY_SCHEMA_SQL } from "../src/epay-compat/schema.ts";
import { captureEPaySnapshot, SOURCE_TABLES, type SnapshotSource } from "../src/epay-compat/snapshot.ts";
import { restoreRehearsalArtifact, writeRehearsalArtifact } from "../src/epay-compat/rehearsal-artifact.ts";
import { rehearseCombinedImport } from "../scripts/epay-combined-import-rehearsal.ts";
import { createMerchantWorkspace } from "../src/epay-compat/merchant-workspace.ts";
import { stageUnresolvedIsolatedSnapshot } from "../src/epay-compat/isolated-unresolved-stage.ts";
import { importCandidate, verifyCandidateArchive } from "../src/epay-compat/candidate-import.ts";

const date = "2024-01-02 03:04:05";
const merchant = { id: 17, name: "Fixture", money: "12.34", status: 1, apiKey: "fixture-secret", createdAt: date, updatedAt: date };

it("persists a candidate, quarantines unbound collection and rejects destructive reimport", async () => {
  const binding = { id: "binding", mainApiId: "api", mainMerchantId: "main", epayMerchantId: 17, createdAt: date, updatedAt: date };
  const source = await fixture({ Merchant: [merchant, { ...merchant, id: 18 }], MerchantBinding: [binding] }, true, true);
  const payment = { merchants: [{ id: "main", apiId: "api", feeRate: 0.05 }], ledger: [], orders: [], refunds: [], settlements: [], callbacks: [], syncJobs: [], balanceSummaryVersion: 1, balanceSummaries: {} };
  const directory = mkdtempSync(join(tmpdir(), "perpay-persistent-candidate-"));
  const path = join(directory,"candidate.sqlite");
  let target: AppDatabase | undefined;
  try {
    target = await AppDatabase.open(path, { masterKey: source.options.masterKey });
    const report = importCandidate(target, source.options, source.snapshot.snapshotId, payment);
    assert.equal(report.candidate.quarantinedMerchants, 1);
    assert.equal(report.candidate.acceptingOrders, false);
    assert.throws(() => importCandidate(target!, source.options, source.snapshot.snapshotId, payment), /already imported/);
    target.close();
    target = await AppDatabase.open(path, { masterKey: source.options.masterKey });
    assert.equal(verifyCandidateArchive(target, source.options.masterKey, payment).archiveVerified, true);
    assert.throws(() => verifyCandidateArchive(target!, randomBytes(32), payment));
    const accounts = target.read(sql => sql.prepare("SELECT merchant_id,enabled,balance_cents,fee_rate_bps FROM epay_merchant_accounts ORDER BY merchant_id").all());
    assert.deepEqual(accounts.map(row => ({...row})), [
      { merchant_id: 17n, enabled: 1n, balance_cents: 1234n, fee_rate_bps: 500n },
      { merchant_id: 18n, enabled: 0n, balance_cents: 1234n, fee_rate_bps: 0n },
    ]);
    assert.equal(target.integrityCheck().ok, true);
  } finally {
    target?.close(); source.sql.close(); source.options.masterKey.fill(0);
    rmSync(directory,{recursive:true,force:true});
  }
});

it("checks source column metadata even for empty tables", () => {
  const columns = Object.entries(MAPPED_COLUMNS).flatMap(([TABLE_NAME, names]) => names.map((COLUMN_NAME) => ({ TABLE_NAME, COLUMN_NAME })));
  assert.doesNotThrow(() => assertMappedSourceMetadata(columns));
  assert.throws(() => assertMappedSourceMetadata(columns.filter((row) => row.TABLE_NAME !== "Invoice" || row.COLUMN_NAME !== "taxId")), /missing column in Invoice: taxId/);
  assert.throws(() => assertMappedSourceMetadata([...columns, { TABLE_NAME: "Invoice", COLUMN_NAME: "newField" }]), /unmapped column in Invoice: newField/);
  assert.throws(() => assertMappedSourceMetadata([...columns, columns[0]]), /duplicate source column/);
  assert.throws(() => assertMappedSourceMetadata(null), /invalid source column metadata/);
});

const nullableFields: Record<string, string[]> = {
  Channel: ["typeId", "payMin", "payMax", "config"],
  Order: ["apiTradeNo", "typeId", "channelId", "typeCode", "channelCode", "realMoney", "getMoney", "returnUrl", "param", "domain", "ip", "device", "buyer", "payUrl", "qrCode", "urlScheme", "providerResult", "notifyLastAt", "paidAt", "buyerEmail"],
  NotifyLog: ["params", "responseCode", "responseBody", "error"],
  Invoice: ["taxId", "email", "externalId", "receiptPdfPath", "providerMessage", "issuedAt", "chargedAt"],
  InvoiceApplication: ["invoiceNo", "invoiceUrl", "issuedAt", "errorCode", "errorMessage", "emailError"],
  Config: ["value"],
};

async function fixture(rows: Record<string, unknown[]> = { Merchant: [merchant] }, fillNulls = true, withColumns = false, extraInvoiceColumn = false) {
  const sql = new DatabaseSync(":memory:");
  sql.exec(`PRAGMA temp_store=MEMORY; PRAGMA foreign_keys=ON; ${EPAY_COMPATIBILITY_SCHEMA_SQL}`);
  const database = { read: <T>(fn: (db: DatabaseSync) => T) => fn(sql), write: <T>(fn: (db: DatabaseSync) => T) => fn(sql) };
  const source: SnapshotSource = { async query(query) {
    const table = /^SELECT \* FROM `([^`]+)`/.exec(query)?.[1];
    const selected = table ? rows[table] ?? [] : [];
    const defaults = Object.fromEntries((nullableFields[table ?? ""] ?? []).map((key) => [key, null]));
    const columns = table ? [...(MAPPED_COLUMNS[table] ?? [SOURCE_TABLES[table as keyof typeof SOURCE_TABLES]])] : [];
    if (table === "Invoice" && extraInvoiceColumn) columns.push("futureField");
    return [fillNulls ? selected.map((row) => ({ ...defaults, ...(row as object) })) : selected, columns.map(name => ({ name }))];
  } };
  const options = { database, source, masterKey: randomBytes(32), instanceId: "fixture", sourceName: "fixture", merchantFeeBps: { "17": 500 }, sourceOffsetMinutes: 480, requireColumnMetadata: withColumns };
  const snapshot = await captureEPaySnapshot(options);
  return { sql, options, snapshot };
}

it("derives fee candidates only from authenticated exact bindings", async () => {
  const binding = { id: "binding", mainApiId: "api", mainMerchantId: "main", epayMerchantId: "17", createdAt: date, updatedAt: date };
  const source = await fixture({ Merchant: [merchant, { ...merchant, id: 18 }], MerchantBinding: [binding] }, true, true);
  const old = await fixture({ Merchant: [merchant], MerchantBinding: [binding] });
  const payment = { merchants: [{ id: "main", apiId: "api", feeRate: 0.05 }], ledger: [] };
  try {
    const candidates = deriveMerchantFeeCandidates(source.options, source.snapshot.snapshotId, payment);
    assert.deepEqual({ ...candidates.rates }, { "17": 500 });
    assert.deepEqual(candidates.unresolved, [{ merchantId: 18, reason: "unbound" }]);
    assert.equal(candidates.sharedCutoffVerified, false);
    assert.equal(candidates.historicalFeesVerified, false);
    assert.equal(deriveMerchantFeeCandidates(source.options, source.snapshot.snapshotId, { ...payment, merchants: [{ id: "main", apiId: "other", feeRate: 0.05 }] }).unresolved[0]?.reason, "identity_mismatch");
    assert.equal(deriveMerchantFeeCandidates(source.options, source.snapshot.snapshotId, { ...payment, merchants: [] }).unresolved[0]?.reason, "missing_main");
    assert.equal(deriveMerchantFeeCandidates(source.options, source.snapshot.snapshotId, { ...payment, merchants: [{ id: "main", apiId: "api", feeRate: 0.00001 }] }).unresolved[0]?.reason, "unsupported_precision");
    assert.equal(deriveMerchantFeeCandidates(source.options, source.snapshot.snapshotId, { ...payment, merchants: [...payment.merchants, { id: "other", apiId: "api", feeRate: 0 }] }).unresolved[0]?.reason, "ambiguous_api");
    assert.throws(() => deriveMerchantFeeCandidates({ ...source.options, masterKey: randomBytes(32) }, source.snapshot.snapshotId, payment), /authentication failed/);
    assert.throws(() => deriveMerchantFeeCandidates(old.options, old.snapshot.snapshotId, payment), /missing authenticated column metadata/);
  } finally {
    source.sql.close();
    old.sql.close();
    source.options.masterKey.fill(0);
    old.options.masterKey.fill(0);
  }
});

it("rehearses candidate fee application in an isolated tmpfs database", { skip: process.platform !== "linux" }, async () => {
  const binding = { id: "binding", mainApiId: "api", mainMerchantId: "main", epayMerchantId: 17, createdAt: date, updatedAt: date };
  const source = await fixture({ Merchant: [merchant], MerchantBinding: [binding] }, true, true);
  const payment = { merchants: [{ id: "main", apiId: "api", feeRate: 0.05 }], orders: [], ledger: [], refunds: [], settlements: [], callbacks: [], syncJobs: [], balanceSummaryVersion: 1, balanceSummaries: { main: { availableCents: 0, frozenCents: 0 } } };
  const original = process.env.EPAY_ISOLATED_TEST;
  process.env.EPAY_ISOLATED_TEST = "1";
  try {
    const options = { ...source.options, merchantFeeBps: { "17": 0 } };
    const assumed = await rehearseCombinedImport(options, source.snapshot.snapshotId, payment);
    assert.equal(assumed.merchantFees.mismatched, 1);
    assert.equal(assumed.feeCandidates.applied, false);
    const derived = await rehearseCombinedImport(options, source.snapshot.snapshotId, payment, true);
    assert.equal(derived.merchantFees.mismatched, 0);
    assert.equal(derived.feeCandidates.applied, true);
    assert.equal(derived.feeCandidates.derived, 1);
    assert.equal(derived.reopenedVerified, true);
    assert.equal(derived.financiallyReconciled, false);
    assert.equal(derived.productionReady, false);
  } finally {
    if (original === undefined) delete process.env.EPAY_ISOLATED_TEST;
    else process.env.EPAY_ISOLATED_TEST = original;
    source.sql.close();
    source.options.masterKey.fill(0);
  }
});

it("retains unbound EPay history without exposing it through another merchant binding", async () => {
  const binding = { id: "binding", mainApiId: "api", mainMerchantId: "main", epayMerchantId: 17, createdAt: date, updatedAt: date };
  const unbound = { ...merchant, id: 18, name: "unbound fixture" };
  const order = { tradeNo: "unbound-trade", outTradeNo: "unbound-external", merchantId: 18, name: "private item", money: "12.34", notifyUrl: "https://example.test", status: "PAID", notifyStatus: "SUCCESS", notifyCount: 1, createdAt: date, updatedAt: date };
  const invoice = { id: "unbound-invoice", tradeNo: "unbound-trade", kind: "normal", merchantId: 18, title: "private invoice", amount: "12.34", serviceFee: "0.25", status: "ISSUED", provider: "fixture", createdAt: date, updatedAt: date };
  const notify = { id: 42, tradeNo: "unbound-trade", url: "https://example.test/callback", params: {}, status: "SUCCESS", createdAt: date };
  const source = await fixture({ Merchant: [merchant, unbound], MerchantBinding: [binding], Order: [order], Invoice: [invoice], NotifyLog: [notify] }, true, true);
  const directory = mkdtempSync(join(tmpdir(), "epay-unbound-history-"));
  const path = join(directory, "target.sqlite");
  let target = await AppDatabase.open(path, { masterKey: source.options.masterKey });
  try {
    const cipher = new RuntimeSecretCipher(source.options.masterKey, target.instanceId());
    const guard = cipher.createGuard();
    target.write(sql => sql.prepare("INSERT INTO runtime_master_key_guard(singleton_key,cipher_version,nonce,ciphertext,authentication_tag,created_at) VALUES(1,1,?,?,?,0)").run(guard.nonce, guard.ciphertext, guard.authenticationTag));
    const payment = { merchants: [{ id: "main", apiId: "api", feeRate: 0.05 }], orders: [], ledger: [], refunds: [], settlements: [], callbacks: [], syncJobs: [], balanceSummaryVersion: 1, balanceSummaries: { main: { availableCents: 0, frozenCents: 0 } } };
    const report = importCombinedIsolatedSnapshot(target, { ...source.options, merchantFeeBps: { "17": 500, "18": 0 } }, source.snapshot.snapshotId, payment);
    assert.equal(report.merchantFees.unbound, 1);
    assert.equal(report.financiallyReconciled, false);
    target.close();
    target = await AppDatabase.open(path, { masterKey: source.options.masterKey });
    assert.equal(target.integrityCheck().ok, true);
    target.read(sql => {
      assert.equal(Number(sql.prepare("SELECT merchant_id FROM epay_orders WHERE trade_no='unbound-trade'").get()?.merchant_id), 18);
      assert.equal(Number(sql.prepare("SELECT merchant_id FROM epay_invoices WHERE invoice_id='unbound-invoice'").get()?.merchant_id), 18);
      assert.equal(Number(sql.prepare("SELECT count(*) AS n FROM epay_notify_logs WHERE notify_id=42 AND trade_no='unbound-trade'").get()?.n), 1);
      assert.equal(Number(sql.prepare("SELECT count(*) AS n FROM epay_merchant_bindings WHERE epay_merchant_id=18").get()?.n), 0);
    });
    const identityFetch: typeof fetch = async () => Response.json({ ok: true, merchantId: "main", apiId: "api", role: "owner" });
    const workspace = createMerchantWorkspace({ database: target, identityOrigin: "http://127.0.0.1:8787", identityFetch });
    for (const [view, status] of [["/orders?merchantId=main", 200], ["/invoices?merchantId=main", 200], ["/notifications?merchantId=main&tradeNo=unbound-trade", 404]] as const) {
      const response = await workspace.request(view, { headers: { cookie: "session=fixture" } });
      assert.equal(response.status, status);
      assert.doesNotMatch(await response.text(), /unbound-trade|unbound-invoice|private item|private invoice/);
    }
  } finally {
    target.close();
    source.sql.close();
    source.options.masterKey.fill(0);
    rmSync(directory, { recursive: true, force: true });
  }
});

it("quarantines the full main source when a merchant binding is unresolved", async () => {
  const binding = { id: "binding", mainApiId: "api", mainMerchantId: "main", epayMerchantId: 17, createdAt: date, updatedAt: date };
  const source = await fixture({ Merchant: [merchant], MerchantBinding: [binding] }, true, true);
  const directory = mkdtempSync(join(tmpdir(), "epay-unresolved-stage-"));
  const path = join(directory, "target.sqlite");
  let target = await AppDatabase.open(path, { masterKey: source.options.masterKey });
  const payment = { merchants: [{ id: "main", apiId: "api", feeRate: 0.05 }, { id: "missing", apiId: "missing-api", feeRate: 0.02 }], orders: [], ledger: [], refunds: [], settlements: [], callbacks: [], syncJobs: [], accessTokens: [{ id: "secret-fixture", value: "private-stage-value" }], balanceSummaryVersion: 1, balanceSummaries: {} };
  try {
    const cipher = new RuntimeSecretCipher(source.options.masterKey, target.instanceId());
    const guard = cipher.createGuard();
    target.write(db => db.prepare("INSERT INTO runtime_master_key_guard(singleton_key,cipher_version,nonce,ciphertext,authentication_tag,created_at) VALUES(1,1,?,?,?,0)").run(guard.nonce, guard.ciphertext, guard.authenticationTag));
    assert.throws(() => importCombinedIsolatedSnapshot(target, source.options, source.snapshot.snapshotId, payment), /binding is unresolved/);
    assert.throws(() => stageUnresolvedIsolatedSnapshot(target, { ...source.options, merchantFeeBps: {} }, source.snapshot.snapshotId, payment), /explicit merchant fee/);
    assert.equal(Number(target.read(db => db.prepare("SELECT count(*) AS n FROM epay_main_payment_archive").get())?.n), 0);
    assert.throws(() => stageUnresolvedIsolatedSnapshot(target, { ...source.options, mainPayment: payment }, source.snapshot.snapshotId, payment), /cannot import main-site accounting/);
    const report = stageUnresolvedIsolatedSnapshot(target, source.options, source.snapshot.snapshotId, payment);
    assert.equal(report.unresolvedMainMerchants, 1);
    assert.equal(report.mainAccountingImported, false);
    assert.equal(report.sourceSnapshotMustBeRetained, true);
    assert.equal(report.productionReady, false);
    const instanceId = target.instanceId();
    target.close();
    assert.doesNotMatch(readFileSync(path).toString("latin1"), /private-stage-value/);
    target = await AppDatabase.open(path, { masterKey: source.options.masterKey });
    assert.equal(target.integrityCheck().ok, true);
    target.read(db => {
      assert.equal(readMainPaymentArchive(db, new RuntimeSecretCipher(source.options.masterKey, instanceId)), JSON.stringify(payment));
      assert.throws(() => readMainPaymentArchive(db, new RuntimeSecretCipher(randomBytes(32), instanceId)));
      assert.equal(Number(db.prepare("SELECT count(*) AS n FROM epay_balance_ledger").get()?.n), 0);
      assert.equal(Number(db.prepare("SELECT count(*) AS n FROM epay_main_order_sources").get()?.n), 0);
      assert.equal(Number(db.prepare("SELECT count(*) AS n FROM epay_merchant_bindings WHERE main_merchant_id='missing'").get()?.n), 0);
    });
  } finally {
    target.close();
    source.sql.close();
    source.options.masterKey.fill(0);
    rmSync(directory, { recursive: true, force: true });
  }
});

it("imports an authenticated snapshot into a guarded application transaction and rolls back failures", async () => {
  const source = await fixture(undefined, true, true);
  const old = await fixture();
  const changed = await fixture(undefined, true, true, true);
  const directory = mkdtempSync(join(tmpdir(), "epay-app-target-"));
  const target = await AppDatabase.open(join(directory, "target.sqlite"), { masterKey: source.options.masterKey });
  try {
    const targetCipher = new RuntimeSecretCipher(source.options.masterKey, target.instanceId());
    const guard = targetCipher.createGuard();
    target.write(db => db.prepare("INSERT INTO runtime_master_key_guard(singleton_key,cipher_version,nonce,ciphertext,authentication_tag,created_at) VALUES(1,1,?,?,?,0)").run(guard.nonce, guard.ciphertext, guard.authenticationTag));
    assert.throws(() => target.write(db => importEPaySnapshotInTransaction(old.options, old.snapshot.snapshotId, { database: db, instanceId: target.instanceId() })), /missing authenticated column metadata/);
    assert.throws(() => target.write(db => importEPaySnapshotInTransaction(changed.options, changed.snapshot.snapshotId, { database: db, instanceId: target.instanceId() })), /unmapped column in Invoice: futureField/);
    assert.equal(target.read(db => db.prepare("SELECT count(*) AS n FROM epay_merchant_accounts").get()!.n), 0n);
    assert.throws(() => target.read(db => importEPaySnapshotInTransaction(source.options, source.snapshot.snapshotId, { database: db, instanceId: target.instanceId() })), /requires a target transaction/);
    assert.throws(() => target.write(db => importEPaySnapshotInTransaction({ ...source.options, merchantFeeBps: {} }, source.snapshot.snapshotId, { database: db, instanceId: target.instanceId() })), /explicit merchant fee/);
    assert.equal(target.read(db => db.prepare("SELECT count(*) AS n FROM epay_merchant_accounts").get()!.n), 0n);
    assert.throws(() => target.write(db => importEPaySnapshotInTransaction(source.options, source.snapshot.snapshotId, { database: db, instanceId: "wrong-instance" })), /instance mismatch/);
    const report = target.write(db => importEPaySnapshotInTransaction(source.options, source.snapshot.snapshotId, { database: db, instanceId: target.instanceId() }));
    assert.equal(report.productionReady, false);
    assert.equal(target.read(db => db.prepare("SELECT balance_cents FROM epay_merchant_accounts WHERE merchant_id=17").get()!.balance_cents), 1234n);
    assert.equal(target.read(db => db.prepare("SELECT count(*) AS n FROM epay_compat_import_runs").get()!.n), 1n);
    assert.throws(() => target.write(db => importEPaySnapshotInTransaction(source.options, source.snapshot.snapshotId, { database: db, instanceId: target.instanceId() })), /target is not empty/);
    assert.equal(target.integrityCheck().ok, true);
  } finally {
    target.close();
    source.sql.close();
    old.sql.close();
    changed.sql.close();
    source.options.masterKey.fill(0);
    old.options.masterKey.fill(0);
    changed.options.masterKey.fill(0);
    rmSync(directory, { recursive: true, force: true });
  }
});

it("rolls back a partially imported application transaction and requires foreign keys", async () => {
  const source = await fixture({ Merchant: [merchant, { ...merchant, id: 18 }] }, true, true);
  const directory = mkdtempSync(join(tmpdir(), "epay-app-rollback-"));
  const target = await AppDatabase.open(join(directory, "target.sqlite"), { masterKey: source.options.masterKey });
  try {
    const cipher = new RuntimeSecretCipher(source.options.masterKey, target.instanceId());
    const guard = cipher.createGuard();
    target.write(db => db.prepare("INSERT INTO runtime_master_key_guard(singleton_key,cipher_version,nonce,ciphertext,authentication_tag,created_at) VALUES(1,1,?,?,?,0)").run(guard.nonce, guard.ciphertext, guard.authenticationTag));
    const importSnapshot = (db: DatabaseSync) => importEPaySnapshotInTransaction(source.options, source.snapshot.snapshotId, { database: db, instanceId: target.instanceId() });
    target.read(db => db.exec("PRAGMA foreign_keys=OFF"));
    assert.throws(() => target.write(importSnapshot), /foreign keys enabled/);
    target.read(db => db.exec("PRAGMA foreign_keys=ON"));
    assert.throws(() => target.write(importSnapshot), /explicit merchant fee/);
    for (const table of ["epay_merchant_accounts", "epay_merchant_secrets", "epay_compat_import_runs"]) {
      assert.equal(target.read(db => db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n), 0n);
    }
  } finally {
    target.close();
    source.sql.close();
    source.options.masterKey.fill(0);
    rmSync(directory, { recursive: true, force: true });
  }
});

it("imports the EPay snapshot, main orders, ledger and refunds in one transaction", async () => {
  const binding = { id: "binding", mainApiId: "api", mainMerchantId: "main-merchant", epayMerchantId: 17, createdAt: date, updatedAt: date };
  const source = await fixture({ Merchant: [merchant], MerchantBinding: [binding] }, true, true);
  const directory = mkdtempSync(join(tmpdir(), "epay-combined-import-"));
  const path = join(directory, "target.sqlite");
  let target = await AppDatabase.open(path, { masterKey: source.options.masterKey });
  const order = { id: "order", merchantId: "main-merchant", merchantOrderId: "external", status: "paid", paidAt: "2024-01-02T03:04:05Z", amountCents: 100, platformFeeCents: 5, merchantNetCents: 95, createdAt: "2024-01-02T03:04:05Z" };
  const entry = { id: "ledger", merchantId: "main-merchant", type: "payment_paid", orderId: "order", at: "2024-01-02T03:04:05Z", availableDelta: 95, frozenDelta: 0, grossCents: 100, platformFeeCents: 5, merchantNetCents: 95 };
  const refund = { id: "refund", merchantId: "main-merchant", orderId: "order", amountCents: 50, status: "recorded" };
  const settlement = { id: "settlement", merchantId: "main-merchant", amountCents: 10, status: "pending" };
  const callback = { id: "callback", merchantId: "main-merchant", orderId: "order" };
  const syncJob = { id: "sync", orderId: "order" };
  const payment = { merchants: [{ id: "main-merchant", apiId: "api", feeRate: 0.05 }], orders: [order], ledger: [entry], refunds: [refund], settlements: [settlement], callbacks: [callback], syncJobs: [syncJob], accessTokens: [{ id: "token", secret: "private-archive-fixture" }], paymentEvents: [{ id: "event" }], balanceSummaryVersion: 1, balanceSummaries: { "main-merchant": { availableCents: 95, frozenCents: 0 } } };
  try {
    const cipher = new RuntimeSecretCipher(source.options.masterKey, target.instanceId());
    const guard = cipher.createGuard();
    target.write(db => db.prepare("INSERT INTO runtime_master_key_guard(singleton_key,cipher_version,nonce,ciphertext,authentication_tag,created_at) VALUES(1,1,?,?,?,0)").run(guard.nonce, guard.ciphertext, guard.authenticationTag));
    const candidates = deriveMerchantFeeCandidates(source.options, source.snapshot.snapshotId, payment);
    const importOptions = { ...source.options, merchantFeeBps: { "17": 0, ...candidates.rates } };
    const importAll = (invalid: boolean) => importCombinedIsolatedSnapshot(target, importOptions, source.snapshot.snapshotId, invalid ? { ...payment, ledger: [{ ...entry, at: "2024-02-30T00:00:00Z" }] } : payment);
    assert.throws(() => importCombinedIsolatedSnapshot(target, source.options, source.snapshot.snapshotId, { ...payment, unrecognized: { missing: undefined } }), /not lossless JSON/);
    assert.throws(() => importAll(true), /invalid main ledger timestamp/);
    assert.throws(() => importCombinedIsolatedSnapshot(target, source.options, source.snapshot.snapshotId, { ...payment, refunds: [refund, { ...refund, id: "invalid", orderId: "missing" }] }), /order link is inconsistent/);
    assert.throws(() => importCombinedIsolatedSnapshot(target, source.options, source.snapshot.snapshotId, { ...payment, syncJobs: [syncJob, { ...syncJob, id: "bad", orderId: "missing" }] }), /order binding is unresolved/);
    assert.throws(() => importCombinedIsolatedSnapshot(target, source.options, source.snapshot.snapshotId, { ...payment, callbacks: undefined }), /invalid main payment collection/);
    assert.throws(() => importCombinedIsolatedSnapshot(target, source.options, source.snapshot.snapshotId, { ...payment, settlements: [{ ...settlement, amountCents: 0 }] }), /invalid or duplicate main settlement/);
    for (const table of ["epay_merchant_accounts", "epay_merchant_bindings", "epay_compat_import_runs", "epay_main_order_sources", "epay_balance_ledger", "epay_main_refund_sources", "epay_main_refund_import_runs", "epay_main_activity_sources", "epay_main_activity_import_runs", "epay_main_payment_archive"]) {
      assert.equal(target.read(db => db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n), 0n);
    }
    const report = importAll(false);
    assert.deepEqual(report.merchantFees, { merchants: 1, mainMerchants: 1, mainUnmapped: 0, mainAmbiguousBindings: 0, compared: 1, mismatched: 0, unbound: 0, missingMain: 0, identityMismatch: 0, ambiguousApi: 0, unsupportedPrecision: 0, sharedCutoffVerified: false, historicalFeesVerified: false });
    assert.throws(() => target.write(db => projectMerchantLedgerBalance(db, cipher, 17)), /refund archive is inconsistent/);
    assert.throws(() => target.write(db => preserveMainPaymentArchive(db, cipher, payment)), /already exists/);
    assert.equal(report.productionReady, false);
    assert.equal(report.financiallyReconciled, false);
    assert.equal(report.mainOrders, 1);
    assert.equal(report.mainLedger.count, 1);
    assert.equal(report.mainRefunds, 1);
    assert.deepEqual(report.mainActivity.counts, { settlements: 1, callbacks: 1, syncJobs: 1 });
    assert.equal(report.mainActivity.replayEnabled, false);
    assert.equal(report.mainRefundAudit.refundCount, 1);
    assert.equal(report.mainRefundAudit.missingManualPostings, 1);
    assert.equal(report.mainRefundAudit.channelRefundsVerified, false);
    assert.equal(report.mainRefundAudit.financiallyReconciled, false);
    assert.equal(report.mainSettlementAudit.issueCount, 1);
    assert.equal(report.mainSettlementAudit.issueCounts.main_settlement_posting_count_mismatch, 1);
    assert.equal(report.mainSettlementAudit.payoutVerified, false);
    assert.doesNotMatch(JSON.stringify(report.mainSettlementAudit), /settlement\"|main-merchant/);
    const instanceId = target.instanceId();
    target.close();
    assert.doesNotMatch(readFileSync(path).toString("latin1"), /private-archive-fixture/);
    target = await AppDatabase.open(path, { masterKey: source.options.masterKey });
    assert.equal(target.integrityCheck().ok, true);
    const reopened = new RuntimeSecretCipher(source.options.masterKey, instanceId);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(readEncryptedMainOrder(db, reopened, order.id), JSON.stringify(order));
      assert.equal(readEncryptedMainLedgerSource(db, reopened, entry.id), JSON.stringify(entry));
      assert.equal(readEncryptedMainRefund(db, reopened, refund.id), JSON.stringify(refund));
      assert.equal(readMainActivity(db, reopened, "settlements", settlement.id), JSON.stringify(settlement));
      assert.equal(readMainActivity(db, reopened, "callbacks", callback.id), JSON.stringify(callback));
      assert.equal(readMainActivity(db, reopened, "syncJobs", syncJob.id), JSON.stringify(syncJob));
      assert.equal(readMainPaymentArchive(db, reopened), JSON.stringify(payment));
      assert.throws(() => readMainPaymentArchive(db, new RuntimeSecretCipher(randomBytes(32), instanceId)));
      assert.deepEqual({ ...db.prepare("SELECT settlement_count,callback_count,sync_job_count FROM epay_main_activity_import_runs").get() }, { settlement_count: 1, callback_count: 1, sync_job_count: 1 });
      assert.equal(db.prepare("SELECT count(*) AS count FROM epay_main_activity_sources").get()!.count, 3);
      assert.throws(() => readMainActivity(db, new RuntimeSecretCipher(randomBytes(32), instanceId), "callbacks", callback.id));
      assert.equal(Number(db.prepare("SELECT balance_cents FROM epay_merchant_accounts WHERE merchant_id=17").get()!.balance_cents), 1234);
      assert.equal(db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
      assert.equal(db.prepare("PRAGMA foreign_key_check").get(), undefined);
    } finally { db.close(); }
  } finally {
    target.close();
    source.sql.close();
    source.options.masterKey.fill(0);
    rmSync(directory, { recursive: true, force: true });
  }
});

it("rejects a missing nullable source field instead of treating it as null", async () => {
  const channel = { id: 1, typeId: null, provider: "fixture", code: "fixture", name: "Fixture", product: "fixture", enabled: 1, rate: "0.05", payMin: null, payMax: null, config: null, createdAt: date, updatedAt: date };
  const valid = await fixture({ Merchant: [merchant], Channel: [channel] }, false);
  try { assert.equal(importEPaySnapshotIntoMemory(valid.options, valid.snapshot.snapshotId).identifiersVerified, true); }
  finally { valid.sql.close(); }
  const { payMin: _payMin, ...missing } = channel;
  const invalid = await fixture({ Merchant: [merchant], Channel: [missing] }, false);
  try { assert.throws(() => importEPaySnapshotIntoMemory(invalid.options, invalid.snapshot.snapshotId), /missing payMin/); }
  finally { invalid.sql.close(); }
});

it("rejects source columns that are not included in the migration mapping", async () => {
  const { sql, options, snapshot } = await fixture({ Merchant: [{ ...merchant, futureBalance: "1.00" }] });
  try { assert.throws(() => importEPaySnapshotIntoMemory(options, snapshot.snapshotId), /unmapped column in Merchant: futureBalance/); }
  finally { sql.close(); }
});

it("rehearses an import without writing to the snapshot database", async () => {
  const { sql, options, snapshot } = await fixture();
  try {
    const database = { ...options.database, write: () => { throw new Error("snapshot is read-only"); } };
    const report = importEPaySnapshotIntoMemory({ ...options, database }, snapshot.snapshotId);
    assert.equal(report.productionReady, false);
    assert.equal(report.identifiersVerified, true);
    assert.equal(report.counts.Merchant, 1);
    assert.equal((sql.prepare("SELECT count(*) AS count FROM epay_merchant_accounts").get() as { count: number }).count, 0);
    assert.equal(importEPaySnapshotIntoMemory({ ...options, database }, snapshot.snapshotId).identifiersVerified, true);
  } finally { sql.close(); }
});

it("preserves invoice configuration as encrypted source data bound to its original merchant", async () => {
  const config = { merchantId: 17, encryptedSettings: "old-encrypted-settings-fixture", createdAt: date, updatedAt: date };
  const { sql, options, snapshot } = await fixture({ Merchant: [merchant], MerchantInvoiceConfig: [config] });
  try {
    const { encrypted, report } = createEncryptedEPayRehearsal(options, snapshot.snapshotId);
    assert.equal(report.preservedInvoiceConfigCount, 1);
    assert.equal(report.productionReady, false);
    const cipher = new RuntimeSecretCipher(options.masterKey, options.instanceId);
    const bytes = cipher.decrypt(`epay:config:isolated-import:${snapshot.snapshotId}`, 1, encrypted);
    const restored = new DatabaseSync(":memory:");
    try {
      restored.deserialize(bytes);
      assert.equal(bytes.includes(Buffer.from(config.encryptedSettings)), false);
      const row = restored.prepare("SELECT merchant_id,nonce,ciphertext,authentication_tag FROM epay_legacy_invoice_config_source").get() as { merchant_id: number; nonce: Uint8Array; ciphertext: Uint8Array; authentication_tag: Uint8Array };
      const sealed = { cipherVersion: 1 as const, nonce: Buffer.from(row.nonce), ciphertext: Buffer.from(row.ciphertext), authenticationTag: Buffer.from(row.authentication_tag) };
      const clear = cipher.decrypt("epay:config:legacy-invoice:17", 1, sealed);
      try { assert.deepEqual(JSON.parse(clear.toString("utf8")), config); } finally { clear.fill(0); }
      assert.throws(() => cipher.decrypt("epay:config:legacy-invoice:18", 1, sealed));
      sealed.ciphertext[0] = sealed.ciphertext[0]! ^ 1;
      assert.throws(() => cipher.decrypt("epay:config:legacy-invoice:17", 1, sealed));
    } finally { restored.close(); bytes.fill(0); }
  } finally { sql.close(); }
  const orphan = await fixture({ Merchant: [merchant], MerchantInvoiceConfig: [{ ...config, merchantId: 18 }] });
  try { assert.throws(() => importEPaySnapshotIntoMemory(orphan.options, orphan.snapshot.snapshotId), /FOREIGN KEY/); }
  finally { orphan.sql.close(); }
});

it("encrypts the complete rehearsal database and restores it only in memory", async () => {
  const { sql, options, snapshot } = await fixture();
  try {
    const { encrypted, report } = createEncryptedEPayRehearsal(options, snapshot.snapshotId);
    assert.equal(report.productionReady, false);
    assert.equal(report.financiallyReconciled, false);
    assert.equal(encrypted.ciphertext.includes(Buffer.from("Fixture")), false);
    assert.equal(encrypted.ciphertext.includes(Buffer.from("fixture-secret")), false);
    const name = `epay:config:isolated-import:${snapshot.snapshotId}` as const;
    const cipher = new RuntimeSecretCipher(options.masterKey, options.instanceId);
    assert.throws(() => new RuntimeSecretCipher(randomBytes(32), options.instanceId).decrypt(name, 1, encrypted));
    const altered = { ...encrypted, ciphertext: Buffer.from(encrypted.ciphertext) };
    altered.ciphertext[0] = altered.ciphertext[0]! ^ 1;
    assert.throws(() => cipher.decrypt(name, 1, altered));
    const bytes = cipher.decrypt(name, 1, encrypted);
    const restored = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
    try {
      restored.deserialize(bytes);
      assert.equal(restored.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
      assert.deepEqual({ ...restored.prepare("SELECT merchant_id,name,balance_cents FROM epay_merchant_accounts").get() }, { merchant_id: 17, name: "Fixture", balance_cents: 1234 });
      assert.equal(restored.prepare("SELECT count(*) AS count FROM epay_merchant_secrets").get()?.count, 1);
    } finally {
      restored.close();
      bytes.fill(0);
    }
    assert.equal(sql.prepare("SELECT count(*) AS count FROM epay_merchant_accounts").get()?.count, 0);
  } finally { sql.close(); }
});

it("persists an encrypted rehearsal without overwriting and restores a read-only database", async () => {
  const { sql, options, snapshot } = await fixture();
  const dir = mkdtempSync(join(tmpdir(), "epay-encrypted-rehearsal-"));
  const path = join(dir, "rehearsal.enc");
  try {
    const { encrypted } = createEncryptedEPayRehearsal(options, snapshot.snapshotId);
    writeRehearsalArtifact(path, encrypted);
    const original = readFileSync(path);
    assert.equal(original.includes(Buffer.from("Fixture")), false);
    assert.equal(original.includes(Buffer.from("fixture-secret")), false);
    assert.throws(() => writeRehearsalArtifact(path, encrypted), /exist/i);
    assert.deepEqual(readFileSync(path), original);
    assert.throws(() => restoreRehearsalArtifact(path, snapshot.snapshotId, randomBytes(32), options.instanceId));
    assert.throws(() => restoreRehearsalArtifact(path, "different-id", options.masterKey, options.instanceId));
    assert.throws(() => restoreRehearsalArtifact(path, snapshot.snapshotId, options.masterKey, "different-instance"));
    const restored = restoreRehearsalArtifact(path, snapshot.snapshotId, options.masterKey, options.instanceId);
    try {
      assert.equal(restored.prepare("SELECT balance_cents FROM epay_merchant_accounts WHERE merchant_id=17").get()?.balance_cents, 1234);
      assert.throws(() => restored.exec("DELETE FROM epay_merchant_accounts"), /readonly/i);
    } finally { restored.close(); }
    const changed = Buffer.from(original);
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    writeFileSync(path, changed);
    assert.throws(() => restoreRehearsalArtifact(path, snapshot.snapshotId, options.masterKey, options.instanceId));
    writeFileSync(path, original.subarray(0, 20));
    assert.throws(() => restoreRehearsalArtifact(path, snapshot.snapshotId, options.masterKey, options.instanceId), /invalid rehearsal artifact/);
  } finally { sql.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("rejects an import when a later merchant lacks an explicit rate", async () => {
  const { sql, options, snapshot } = await fixture({ Merchant: [merchant, { ...merchant, id: 18 }] });
  try {
    assert.throws(() => importEPaySnapshotIntoMemory(options, snapshot.snapshotId), /explicit merchant fee/);
    assert.equal((sql.prepare("SELECT count(*) AS count FROM epay_merchant_accounts").get() as { count: number }).count, 0);
    assert.equal((sql.prepare("SELECT count(*) AS count FROM epay_merchant_secrets").get() as { count: number }).count, 0);
  } finally { sql.close(); }
});

it("preserves null, empty and encrypted configuration values distinctly", async () => {
  const { sql, options, snapshot } = await fixture({ Merchant: [merchant], Config: [
    { key: "null-value", value: null, updatedAt: date },
    { key: "empty-value", value: "", updatedAt: date },
    { key: "secret-value", value: "secret", updatedAt: date },
  ] });
  try { assert.equal(importEPaySnapshotIntoMemory(options, snapshot.snapshotId).counts.Config, 3); }
  finally { sql.close(); }
});

it("round-trips encrypted channel config without treating JSON null as SQL null", async () => {
  const channel = { id: 1, provider: "fixture", code: "fixture", name: "Fixture", product: "fixture", enabled: 1, rate: "0.05", config: { nested: { key: "fixture-secret" } }, createdAt: date, updatedAt: date };
  const { sql, options, snapshot } = await fixture({ Merchant: [merchant], Channel: [channel, { ...channel, id: 2, code: "other", config: "null" }, { ...channel, id: 3, code: "empty", config: null }] });
  try { assert.equal(importEPaySnapshotIntoMemory(options, snapshot.snapshotId).counts.Channel, 3); }
  finally { sql.close(); }
});

it("checks merchant binding, payment type and channel mapping together", async () => {
  const binding = { id: "binding", mainApiId: "api", mainMerchantId: "main-merchant", epayMerchantId: 17, createdAt: date, updatedAt: date };
  const payType = { id: 4, code: "wxpay", name: "Wechat", enabled: 1, sort: 3, createdAt: date, updatedAt: date };
  const channel = { id: 7, typeId: 4, provider: "wechat", code: "fixture", name: "Fixture", product: "native", enabled: 1, rate: "0.05", payMin: "0.01", payMax: "999.99", config: { key: "fixture-secret" }, createdAt: date, updatedAt: date };
  const { sql, options, snapshot } = await fixture({ Merchant: [merchant], MerchantBinding: [binding], PayType: [payType], Channel: [channel] });
  try {
    const report = importEPaySnapshotIntoMemory(options, snapshot.snapshotId);
    assert.equal(report.counts.MerchantBinding, 1);
    assert.equal(report.counts.PayType, 1);
    assert.equal(report.counts.Channel, 1);
    assert.equal(report.productionReady, false);
  } finally { sql.close(); }
});

it("rejects imprecise amounts and invalid dates", async () => {
  const { sql, options, snapshot } = await fixture({ Merchant: [{ ...merchant, money: "12.345" }] });
  try {
    assert.throws(() => importEPaySnapshotIntoMemory(options, snapshot.snapshotId), /amount|decimal|money/i);
  } finally { sql.close(); }
  const badDate = await fixture({ Merchant: [{ ...merchant, createdAt: "2024-02-30 00:00:00" }] });
  try { assert.throws(() => importEPaySnapshotIntoMemory(badDate.options, badDate.snapshot.snapshotId), /invalid createdAt/); }
  finally { badDate.sql.close(); }
});

it("checks the full historical order mapping with nonempty provider and callback fields", async () => {
  const order = {
    tradeNo: "fixture-trade", outTradeNo: "fixture-external", apiTradeNo: "fixture-provider", merchantId: 17,
    typeId: null, channelId: null, typeCode: "alipay", channelCode: "fixture-channel", name: "item",
    money: "12.34", realMoney: "12.34", getMoney: "12.34", notifyUrl: "https://merchant.example/notify",
    returnUrl: "https://merchant.example/return", param: "fixture", domain: "merchant.example", ip: "127.0.0.1",
    device: "pc", buyer: "fixture-buyer", payUrl: "https://pay.example/fixture", qrCode: "fixture-qr",
    urlScheme: "fixture://pay", providerResult: { state: "success" }, status: "PAID", notifyStatus: "SUCCESS",
    notifyCount: 2, notifyLastAt: date, createdAt: date, paidAt: date, updatedAt: date, buyerEmail: "buyer@example.test",
  };
  const { sql, options, snapshot } = await fixture({ Merchant: [merchant], Order: [order] });
  try {
    const report = importEPaySnapshotIntoMemory(options, snapshot.snapshotId);
    assert.equal(report.counts.Order, 1);
    assert.equal(report.financiallyReconciled, false);
    assert.equal(report.productionReady, false);
  } finally { sql.close(); }
});

it("verifies invoice application ownership and integer fee in the isolated mapping", async () => {
  const order = { tradeNo: "trade", outTradeNo: "external", merchantId: 17, name: "item", money: "12.34", notifyUrl: "https://example.test", status: "PAID", notifyStatus: "SUCCESS", notifyCount: 1, createdAt: date, updatedAt: date };
  const application = { id: "invoice-application", merchantId: 17, tradeNo: "trade", outTradeNo: "external", title: "Fixture", taxId: "123", email: "test@example.test", feeCents: 25, status: "ISSUED", emailSent: 0, createdAt: date, updatedAt: date };
  const invoice = { id: "invoice", tradeNo: "trade", kind: "normal", merchantId: 17, title: "Fixture", taxId: "123", email: "test@example.test", amount: "12.34", serviceFee: "0.25", status: "ISSUED", provider: "fixture", externalId: "external-invoice", receiptPdfPath: "/fixture.pdf", providerMessage: "issued", issuedAt: date, chargedAt: date, createdAt: date, updatedAt: date };
  const notify = { id: 1, tradeNo: "trade", url: "https://example.test/callback", params: { fixture: "value" }, responseCode: 200, responseBody: "success", status: "SUCCESS", error: null, createdAt: date };
  const valid = await fixture({ Merchant: [merchant], Order: [order], NotifyLog: [notify], Invoice: [invoice], InvoiceApplication: [application] });
  try {
    const report = importEPaySnapshotIntoMemory(valid.options, valid.snapshot.snapshotId);
    assert.equal(report.counts.InvoiceApplication, 1);
    assert.equal(report.counts.Invoice, 1);
    assert.equal(report.counts.NotifyLog, 1);
  }
  finally { valid.sql.close(); }
  const invalid = await fixture({ Merchant: [merchant], Order: [order], InvoiceApplication: [{ ...application, outTradeNo: "different" }] });
  try { assert.throws(() => importEPaySnapshotIntoMemory(invalid.options, invalid.snapshot.snapshotId), /invoice order or merchant mismatch/); }
  finally { invalid.sql.close(); }
  const fractional = await fixture({ Merchant: [merchant], Order: [order], InvoiceApplication: [{ ...application, feeCents: 25.5 }] });
  try { assert.throws(() => importEPaySnapshotIntoMemory(fractional.options, fractional.snapshot.snapshotId), /invalid feeCents/); }
  finally { fractional.sql.close(); }
});

it("rolls back inserted rows when post-insert invoice verification fails", async (t) => {
  const order = { tradeNo: "trade", outTradeNo: "external", merchantId: 17, name: "item", money: "12.34", notifyUrl: "https://example.test", status: "PAID", notifyStatus: "SUCCESS", notifyCount: 1, createdAt: date, updatedAt: date };
  const application = { id: "application", merchantId: 17, tradeNo: "trade", outTradeNo: "different", title: "Fixture", taxId: "123", email: "test@example.test", feeCents: 25, status: "ISSUED", emailSent: 0, createdAt: date, updatedAt: date };
  const { sql, options, snapshot } = await fixture({ Merchant: [merchant], Order: [order], InvoiceApplication: [application] });
  const exec = DatabaseSync.prototype.exec;
  let before: number | undefined;
  let after: number | undefined;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, statement: string) {
    if (statement.startsWith("ROLLBACK TO SAVEPOINT epay_isolated_import")) {
      before = Number(this.prepare("SELECT count(*) AS count FROM epay_orders").get()?.count);
      exec.call(this, statement);
      after = Number(this.prepare("SELECT count(*) AS count FROM epay_orders").get()?.count);
      return;
    }
    return exec.call(this, statement);
  });
  try {
    assert.throws(() => importEPaySnapshotIntoMemory(options, snapshot.snapshotId), /invoice order or merchant mismatch/);
    assert.equal(before, 1);
    assert.equal(after, 0);
  } finally { sql.close(); }
});

it("rolls back when mapped merchant secret verification fails", async (t) => {
  const { sql, options, snapshot } = await fixture();
  const exec = DatabaseSync.prototype.exec;
  const decrypt = RuntimeSecretCipher.prototype.decrypt;
  let before: number | undefined;
  let after: number | undefined;
  t.mock.method(RuntimeSecretCipher.prototype, "decrypt", function (this: RuntimeSecretCipher, ...args: Parameters<RuntimeSecretCipher["decrypt"]>) {
    if (args[0] === "epay:merchant:17:api_key") return Buffer.from("mismatched fixture secret");
    return decrypt.apply(this, args);
  });
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, statement: string) {
    if (statement.startsWith("ROLLBACK TO SAVEPOINT epay_isolated_import")) {
      before = Number(this.prepare("SELECT count(*) AS count FROM epay_merchant_accounts").get()?.count);
      exec.call(this, statement);
      after = Number(this.prepare("SELECT count(*) AS count FROM epay_merchant_accounts").get()?.count);
      return;
    }
    return exec.call(this, statement);
  });
  try {
    assert.throws(() => importEPaySnapshotIntoMemory(options, snapshot.snapshotId), /merchant secret mismatch/);
    assert.equal(before, 1);
    assert.equal(after, 0);
  } finally { sql.close(); }
});

it("rehearses the original main-site ledger only for an exact merchant binding", async () => {
  const binding = { id: "binding", mainApiId: "api", mainMerchantId: "main-merchant", epayMerchantId: 17, createdAt: date, updatedAt: date };
  const { sql, options, snapshot } = await fixture({ Merchant: [merchant], MerchantBinding: [binding] });
  const mainPayment = { merchants: [{ id: "main-merchant", apiId: "api", feeRate: 0.05 }], ledger: [
    { id: "main-ledger-1", merchantId: "main-merchant", type: "payment_paid", at: "2024-01-02T03:04:05.000Z", availableDelta: 1000, frozenDelta: 0, grossCents: 1050, orderId: "original-order" },
    { id: "main-ledger-2", merchantId: "main-merchant", type: "settlement_freeze", at: "2024-01-02T03:05:05.000Z", availableDelta: -300, frozenDelta: 300, reason: "settlement", actorId: "actor" },
  ] };
  try {
    const report = importEPaySnapshotIntoMemory({ ...options, mainPayment }, snapshot.snapshotId);
    assert.equal(report.mainLedgerCount, 2);
    assert.equal(report.mainBalanceSummaryVerified, false);
    assert.equal(report.mainPaymentsVerified, false);
    assert.equal(report.financiallyReconciled, false);
    assert.equal(report.productionReady, false);
    const cached = { ...mainPayment, balanceSummaryVersion: 1, balanceSummaries: { "main-merchant": { availableCents: 700, frozenCents: 300 } } };
    const cachedReport = importEPaySnapshotIntoMemory({ ...options, mainPayment: cached }, snapshot.snapshotId);
    assert.equal(cachedReport.mainLedgerCount, 2);
    assert.equal(cachedReport.mainBalanceSummaryVerified, true);
    assert.throws(() => importEPaySnapshotIntoMemory({ ...options, mainPayment: { ...cached, balanceSummaries: { "main-merchant": { availableCents: 701, frozenCents: 300 } } } }, snapshot.snapshotId), /balance summary differences/);
    assert.throws(() => importEPaySnapshotIntoMemory({ ...options, mainPayment: { ...mainPayment, merchants: [{ ...mainPayment.merchants[0], apiId: "wrong-api" }] } }, snapshot.snapshotId), /binding is unresolved/);
    assert.throws(() => importEPaySnapshotIntoMemory({ ...options, mainPayment: { ...mainPayment, ledger: [...mainPayment.ledger, { ...mainPayment.ledger[0], id: "orphan", merchantId: "other" }] } }, snapshot.snapshotId), /unresolved merchants/);
    assert.throws(() => importEPaySnapshotIntoMemory({ ...options, mainPayment: { ...mainPayment, ledger: [{ ...mainPayment.ledger[0], at: "2024-01-02 03:04:05" }] } }, snapshot.snapshotId), /timestamp or binding/);
    assert.throws(() => importEPaySnapshotIntoMemory({ ...options, mainPayment: { ...mainPayment, ledger: [{ ...mainPayment.ledger[0], at: "2024-02-30T03:04:05Z" }] } }, snapshot.snapshotId), /invalid main ledger timestamp/);
    assert.throws(() => importEPaySnapshotIntoMemory({ ...options, mainPayment: { ...mainPayment, ledger: [mainPayment.ledger[0], mainPayment.ledger[0]] } }, snapshot.snapshotId), /duplicate ledger ID/);
  } finally { sql.close(); }
});

it("checks main-site paid orders against postings before completing the rehearsal", async () => {
  const binding = { id: "binding", mainApiId: "api", mainMerchantId: "main-merchant", epayMerchantId: 17, createdAt: date, updatedAt: date };
  const { sql, options, snapshot } = await fixture({ Merchant: [merchant], MerchantBinding: [binding] });
  const order = { id: "order", merchantId: "main-merchant", merchantOrderId: "original-order", status: "paid", paidAt: "2024-01-02T03:04:05Z", createdAt: "2024-01-02T03:04:05Z", amountCents: 100, platformFeeCents: 5, merchantNetCents: 95 };
  const entry = { id: "ledger", merchantId: "main-merchant", type: "payment_paid", orderId: "order", at: "2024-01-02T03:04:05Z", availableDelta: 95, frozenDelta: 0, grossCents: 100, platformFeeCents: 5, merchantNetCents: 95 };
  const mainPayment = { merchants: [{ id: "main-merchant", apiId: "api", feeRate: 0.05 }], orders: [order], ledger: [entry], refunds: [] };
  try {
    const report = importEPaySnapshotIntoMemory({ ...options, mainPayment }, snapshot.snapshotId);
    assert.equal(report.mainPaymentsVerified, true);
    assert.equal(report.mainBalanceSummaryVerified, false);
    assert.equal(report.mainOrderCount, 1);
    assert.throws(() => importEPaySnapshotIntoMemory({ ...options, mainPayment: { ...mainPayment, orders: [{ ...order, paidAt: null }] } }, snapshot.snapshotId), /order and ledger links are inconsistent/);
    assert.throws(() => importEPaySnapshotIntoMemory({ ...options, mainPayment: { ...mainPayment, orders: [{ ...order, merchantId: "unknown", status: "pending_payment" }], ledger: [] } }, snapshot.snapshotId), /order and ledger links are inconsistent/);
    assert.throws(() => importEPaySnapshotIntoMemory({ ...options, mainPayment: { ...mainPayment, ledger: [] } }, snapshot.snapshotId), /order and ledger links are inconsistent/);
    assert.throws(() => importEPaySnapshotIntoMemory({ ...options, mainPayment: { ...mainPayment, orders: [{ ...order, status: "PAID" }], ledger: [] } }, snapshot.snapshotId), /order and ledger links are inconsistent/);
    assert.throws(() => importEPaySnapshotIntoMemory({ ...options, mainPayment: { ...mainPayment, orders: [{ ...order, status: "expired", paidAt: "2024-01-02T03:05:00Z" }], ledger: [] } }, snapshot.snapshotId), /order and ledger links are inconsistent/);
    for (const changes of [{ amountCents: 0 }, { platformFeeCents: undefined }, { merchantNetCents: 96 }]) {
      const pending = { ...order, ...changes, status: "pending_payment", paidAt: null };
      assert.throws(() => importEPaySnapshotIntoMemory({ ...options, mainPayment: { ...mainPayment, orders: [pending], ledger: [] } }, snapshot.snapshotId), /order and ledger links are inconsistent/);
    }
    for (const status of ["refunded", "refund_processing"]) {
      assert.throws(() => importEPaySnapshotIntoMemory({ ...options, mainPayment: { ...mainPayment, orders: [{ ...order, status }], ledger: [] } }, snapshot.snapshotId), /order and ledger links are inconsistent/);
      assert.throws(() => importEPaySnapshotIntoMemory({ ...options, mainPayment: { ...mainPayment, orders: [{ ...order, status }] } }, snapshot.snapshotId), /order and ledger links are inconsistent/);
    }
    assert.throws(() => importEPaySnapshotIntoMemory({ ...options, mainPayment: { ...mainPayment, orders: [{ ...order, refundStatus: "pending" }] } }, snapshot.snapshotId), /order and ledger links are inconsistent/);
    assert.throws(() => importEPaySnapshotIntoMemory({ ...options, mainPayment: { ...mainPayment, refunds: [{ id: "manual-refund" }] } }, snapshot.snapshotId), /order and ledger links are inconsistent/);
    const refund = { id: "refund", merchantId: "main-merchant", orderId: "order", amountCents: 50, status: "pending" };
    const refundPayment = { ...mainPayment, orders: [{ ...order, refundStatus: "pending" }], refunds: [refund] };
    const preserved = importEPaySnapshotIntoMemory({ ...options, mainPayment: refundPayment, preserveRefundsForRehearsal: true }, snapshot.snapshotId);
    assert.equal(preserved.mainRefundCount, 1);
    assert.equal(preserved.mainOrderCount, 1);
    assert.equal(preserved.mainRefundAudit?.channelRefundsVerified, false);
    assert.equal(preserved.mainRefundAudit?.financiallyReconciled, false);
    assert.equal(preserved.mainPaymentsVerified, false);
    assert.equal(preserved.financiallyReconciled, false);
    assert.equal(preserved.productionReady, false);
    assert.throws(() => importEPaySnapshotIntoMemory({ ...options, mainPayment: { ...refundPayment, orders: [{ ...refundPayment.orders[0], createdAt: "2024-02-30T00:00:00Z" }] }, preserveRefundsForRehearsal: true }, snapshot.snapshotId), /invalid main order timestamp/);
    assert.throws(() => importEPaySnapshotIntoMemory({ ...options, mainPayment: { ...refundPayment, refunds: [refund, { ...refund, id: "bad", orderId: "missing" }] }, preserveRefundsForRehearsal: true }, snapshot.snapshotId), /order link is inconsistent/);
    assert.throws(() => importEPaySnapshotIntoMemory({ ...options, mainPayment: { ...mainPayment, ledger: [{ ...entry, merchantNetCents: 94 }] } }, snapshot.snapshotId), /order and ledger links are inconsistent/);
    assert.throws(() => importEPaySnapshotIntoMemory({ ...options, mainPayment: { ...mainPayment, orders: null } }, snapshot.snapshotId), /missing orders or ledger/);
    assert.throws(() => importEPaySnapshotIntoMemory({ ...options, mainPayment: { ...mainPayment, orders: [{ ...order, createdAt: "2024-02-30T00:00:00Z" }] } }, snapshot.snapshotId), /invalid main order timestamp/);
  } finally { sql.close(); }
});

it("rolls back the complete rehearsal when a later main ledger record is invalid", async (t) => {
  const binding = { id: "binding", mainApiId: "api", mainMerchantId: "main-merchant", epayMerchantId: 17, createdAt: date, updatedAt: date };
  const { sql, options, snapshot } = await fixture({ Merchant: [merchant], MerchantBinding: [binding] });
  const entry = { id: "first", merchantId: "main-merchant", type: "payment_paid", at: "2024-01-02T03:04:05Z", availableDelta: 100, frozenDelta: 0 };
  const mainPayment = { merchants: [{ id: "main-merchant", apiId: "api", feeRate: 0.05 }], ledger: [entry, { ...entry, id: "second", at: "2024-02-30T03:04:05Z" }] };
  const exec = DatabaseSync.prototype.exec;
  let before: number | undefined;
  let after: number | undefined;
  let ledgerBefore: number | undefined;
  let ledgerAfter: number | undefined;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, statement: string) {
    if (statement.startsWith("ROLLBACK TO SAVEPOINT epay_main_ledger_import")) {
      ledgerBefore = Number(this.prepare("SELECT count(*) AS count FROM epay_balance_ledger").get()?.count);
      exec.call(this, statement);
      ledgerAfter = Number(this.prepare("SELECT count(*) AS count FROM epay_balance_ledger").get()?.count);
      return;
    }
    if (statement.startsWith("ROLLBACK TO SAVEPOINT epay_isolated_import")) {
      before = Number(this.prepare("SELECT count(*) AS count FROM epay_balance_ledger").get()?.count);
      exec.call(this, statement);
      after = Number(this.prepare("SELECT count(*) AS count FROM epay_balance_ledger").get()?.count);
      return;
    }
    return exec.call(this, statement);
  });
  try {
    assert.throws(() => importEPaySnapshotIntoMemory({ ...options, mainPayment }, snapshot.snapshotId), /invalid main ledger timestamp/);
    assert.equal(ledgerBefore, 1);
    assert.equal(ledgerAfter, 0);
    assert.equal(before, 0);
    assert.equal(after, 0);
  } finally { sql.close(); }
});
