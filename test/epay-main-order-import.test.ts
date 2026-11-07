import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { EPAY_COMPATIBILITY_SCHEMA_SQL } from "../src/epay-compat/schema.ts";
import { EPAY_MAIN_ORDER_SOURCE_SCHEMA_SQL, readEncryptedMainOrder } from "../src/epay-compat/main-order-source.ts";
import { importMainOrdersInTransaction, preserveMainOrdersAndRefundsInTransaction } from "../src/epay-compat/main-order-import.ts";
import { EPAY_MAIN_REFUND_SOURCE_SCHEMA_SQL } from "../src/epay-compat/main-refund-source.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";

for (const readBigInts of [false, true]) it(`imports historical orders transactionally and recovers them after reopening (readBigInts=${readBigInts})`, () => {
  const directory = mkdtempSync(join(tmpdir(), "epay-order-import-"));
  const file = join(directory, "fixture.sqlite"), key = randomBytes(32), cipher = new RuntimeSecretCipher(key, "instance");
  let db = new DatabaseSync(file, { enableForeignKeyConstraints: true, readBigInts });
  const order = { id: "order", merchantId: "main", merchantOrderId: "external", status: "paid", paidAt: "2024-01-02T03:04:05Z", amountCents: 100, platformFeeCents: 5, merchantNetCents: 95, createdAt: "2024-01-02T03:04:05Z", paymentHtml: "fixture-persistent-secret" };
  const entry = { id: "ledger", merchantId: "main", type: "payment_paid", orderId: "order", availableDelta: 95, frozenDelta: 0, grossCents: 100, platformFeeCents: 5, merchantNetCents: 95 };
  const payment = { merchants: [{ id: "main", apiId: "api", feeRate: 0.05 }], ledger: [entry], orders: [order], refunds: [], balanceSummaryVersion: 1, balanceSummaries: { main: { availableCents: 95, frozenCents: 0 } } };
  try {
    db.exec(`${EPAY_COMPATIBILITY_SCHEMA_SQL} ${EPAY_MAIN_ORDER_SOURCE_SCHEMA_SQL} ${EPAY_MAIN_REFUND_SOURCE_SCHEMA_SQL}
      CREATE TABLE runtime_master_key_guard(singleton_key INTEGER PRIMARY KEY,cipher_version INTEGER,nonce BLOB,ciphertext BLOB,authentication_tag BLOB);
      INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES(1,'merchant',0,1,0,0);
      INSERT INTO epay_merchant_bindings VALUES('binding','api','main',1,0,0)`);
    const guard = cipher.createGuard();
    db.prepare("INSERT INTO runtime_master_key_guard VALUES(1,1,?,?,?)").run(guard.nonce, guard.ciphertext, guard.authenticationTag);
    assert.throws(() => importMainOrdersInTransaction(db, cipher, payment), /requires a transaction/);
    db.exec("BEGIN IMMEDIATE");
    const refund = { id: "refund", merchantId: "main", orderId: "missing", amountCents: 50, status: "processing" };
    assert.throws(() => preserveMainOrdersAndRefundsInTransaction(db, cipher, { ...payment, refunds: [refund] }), /order link is inconsistent/);
    assert.equal(Number(db.prepare("SELECT count(*) AS count FROM epay_main_order_sources").get()?.count), 0);
    assert.equal(Number(db.prepare("SELECT count(*) AS count FROM epay_main_order_import_runs").get()?.count), 0);
    assert.equal(Number(db.prepare("SELECT count(*) AS count FROM epay_main_refund_sources").get()?.count), 0);
    assert.equal(Number(db.prepare("SELECT count(*) AS count FROM epay_main_refund_import_runs").get()?.count), 0);
    assert.throws(() => importMainOrdersInTransaction(db, new RuntimeSecretCipher(randomBytes(32), "instance"), payment), /MASTER_KEY/);
    assert.throws(() => importMainOrdersInTransaction(db, cipher, { ...payment, balanceSummaries: {} }), /ledger is not suitable/);
    assert.throws(() => importMainOrdersInTransaction(db, cipher, { ...payment, merchants: [{ ...payment.merchants[0], apiId: "other" }] }), /binding is unresolved/);
    const absentSourceMerchant = { ...payment, merchants: [], ledger: [], balanceSummaries: {}, orders: [{ ...order, status: "pending_payment" }] };
    assert.throws(() => importMainOrdersInTransaction(db, cipher, absentSourceMerchant), /order and ledger links are inconsistent/);
    assert.throws(() => importMainOrdersInTransaction(db, cipher, { ...payment, orders: [{ ...order, status: "PAID" }], ledger: [], balanceSummaries: { main: { availableCents: 0, frozenCents: 0 } } }), /order and ledger links are inconsistent/);
    assert.throws(() => importMainOrdersInTransaction(db, cipher, { ...payment, orders: [{ ...order, status: "expired", paidAt: "2024-01-02T03:05:00Z" }], ledger: [], balanceSummaries: { main: { availableCents: 0, frozenCents: 0 } } }), /order and ledger links are inconsistent/);
    for (const changes of [{ amountCents: 0 }, { platformFeeCents: undefined }, { merchantNetCents: 96 }]) {
      const pending = { ...order, ...changes, status: "pending_payment", paidAt: null };
      assert.throws(() => importMainOrdersInTransaction(db, cipher, { ...payment, orders: [pending], ledger: [], balanceSummaries: { main: { availableCents: 0, frozenCents: 0 } } }), /order and ledger links are inconsistent/);
    }
    for (const status of ["refund_processing", "refunded"]) {
      assert.throws(() => importMainOrdersInTransaction(db, cipher, { ...payment, orders: [{ ...order, status }] }), /order and ledger links are inconsistent/);
    }
    assert.throws(() => importMainOrdersInTransaction(db, cipher, { ...payment, orders: [{ ...order, refundStatus: "pending" }] }), /order and ledger links are inconsistent/);
    assert.throws(() => importMainOrdersInTransaction(db, cipher, { ...payment, refunds: [{ id: "manual-refund" }] }), /order and ledger links are inconsistent/);
    assert.throws(() => importMainOrdersInTransaction(db, cipher, { ...payment, refunds: undefined }), /refunds are invalid/);
    assert.throws(() => importMainOrdersInTransaction(db, cipher, { ...payment, orders: [{ ...order, paidAt: null }] }), /order and ledger links are inconsistent/);
    const invalid = { ...order, id: "invalid", merchantOrderId: "invalid", status: "pending_payment", paidAt: null, createdAt: "2024-02-30T00:00:00Z" };
    assert.throws(() => importMainOrdersInTransaction(db, cipher, { ...payment, orders: [order, invalid] }), /invalid main order timestamp/);
    assert.equal(Number(db.prepare("SELECT count(*) AS count FROM epay_main_order_sources").get()?.count), 0);
    assert.equal(importMainOrdersInTransaction(db, cipher, payment), 1);
    db.exec("COMMIT");
    db.close();
    assert.equal(readFileSync(file).includes(Buffer.from("fixture-persistent-secret")), false);
    db = new DatabaseSync(file, { enableForeignKeyConstraints: true, readBigInts });
    assert.equal(readEncryptedMainOrder(db, cipher, "order"), JSON.stringify(order));
    assert.throws(() => readEncryptedMainOrder(db, new RuntimeSecretCipher(randomBytes(32), "instance"), "order"));
    db.exec("BEGIN IMMEDIATE");
    assert.throws(() => importMainOrdersInTransaction(db, cipher, payment), /target is not empty/);
    db.exec("ROLLBACK");
  } finally { db.close(); key.fill(0); rmSync(directory, { recursive: true, force: true }); }
});

it("records an empty import so it cannot be silently run a second time", () => {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  const key = randomBytes(32), cipher = new RuntimeSecretCipher(key, "empty-instance");
  try {
    db.exec(`${EPAY_COMPATIBILITY_SCHEMA_SQL} ${EPAY_MAIN_ORDER_SOURCE_SCHEMA_SQL}
      CREATE TABLE runtime_master_key_guard(singleton_key INTEGER PRIMARY KEY,cipher_version INTEGER,nonce BLOB,ciphertext BLOB,authentication_tag BLOB)`);
    const guard = cipher.createGuard();
    db.prepare("INSERT INTO runtime_master_key_guard VALUES(1,1,?,?,?)").run(guard.nonce, guard.ciphertext, guard.authenticationTag);
    const payment = { merchants: [], ledger: [], orders: [], refunds: [], balanceSummaryVersion: 1, balanceSummaries: {} };
    db.exec("BEGIN IMMEDIATE");
    assert.equal(importMainOrdersInTransaction(db, cipher, payment), 0);
    assert.throws(() => importMainOrdersInTransaction(db, cipher, payment), /already imported/);
    db.exec("COMMIT");
  } finally { db.close(); key.fill(0); }
});
