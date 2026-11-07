import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { EPAY_COMPATIBILITY_SCHEMA_SQL } from "../src/epay-compat/schema.ts";
import { EPAY_MAIN_ORDER_SOURCE_SCHEMA_SQL, writeEncryptedMainOrder } from "../src/epay-compat/main-order-source.ts";
import { EPAY_MAIN_ACTIVITY_SOURCE_SCHEMA_SQL, preserveMainActivityInTransaction, readMainActivity } from "../src/epay-compat/main-activity-source.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";

for (const readBigInts of [false, true]) it(`preserves linked activity atomically without replay (readBigInts=${readBigInts})`, () => {
  const directory = mkdtempSync(join(tmpdir(), "epay-activity-")), path = join(directory, "fixture.sqlite");
  const key = randomBytes(32), cipher = new RuntimeSecretCipher(key, "fixture");
  let db = new DatabaseSync(path, { enableForeignKeyConstraints: true, readBigInts });
  const order = { id: "order-a", merchantId: "main-a", merchantOrderId: "external", amountCents: 100, status: "paid", createdAt: "2024-01-01T00:00:00Z" };
  const payment = { merchants: [{ id: "main-a", apiId: "api-a" }, { id: "main-b", apiId: "api-b" }], orders: [order],
    settlements: [{ id: "settlement", merchantId: "main-a", amountCents: 50, reference: "private-settlement" }],
    callbacks: [{ id: "callback", merchantId: "main-a", orderId: "order-a", url: "https://private.invalid", payload: { secret: "private-callback" } }],
    syncJobs: [{ id: "job", orderId: "order-a", status: "pending", lastError: "private-error" }] };
  try {
    db.exec(`${EPAY_COMPATIBILITY_SCHEMA_SQL} ${EPAY_MAIN_ORDER_SOURCE_SCHEMA_SQL} ${EPAY_MAIN_ACTIVITY_SOURCE_SCHEMA_SQL}
      CREATE TABLE runtime_master_key_guard(singleton_key INTEGER PRIMARY KEY,cipher_version INTEGER,nonce BLOB,ciphertext BLOB,authentication_tag BLOB);
      INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES(1,'a',0,1,0,0),(2,'b',0,1,0,0);
      INSERT INTO epay_merchant_bindings VALUES('a','api-a','main-a',1,0,0),('b','api-b','main-b',2,0,0)`);
    const guard = cipher.createGuard();
    db.prepare("INSERT INTO runtime_master_key_guard VALUES(1,1,?,?,?)").run(guard.nonce, guard.ciphertext, guard.authenticationTag);
    writeEncryptedMainOrder(db, cipher, JSON.stringify(order));
    assert.throws(() => preserveMainActivityInTransaction(db, cipher, payment), /requires a transaction/);
    db.exec("BEGIN IMMEDIATE");
    assert.throws(() => preserveMainActivityInTransaction(db, new RuntimeSecretCipher(randomBytes(32), "fixture"), payment), /MASTER_KEY/);
    assert.throws(() => preserveMainActivityInTransaction(db, cipher, { ...payment, callbacks: [{ ...payment.callbacks[0], merchantId: "main-b" }] }), /merchant and order mismatch/);
    assert.throws(() => preserveMainActivityInTransaction(db, cipher, { ...payment, syncJobs: [{ ...payment.syncJobs[0], orderId: "missing" }] }), /order binding is unresolved/);
    assert.throws(() => preserveMainActivityInTransaction(db, cipher, { ...payment, syncJobs: [{ ...payment.syncJobs[0], merchantId: "main-b" }] }), /merchant and order mismatch/);
    assert.throws(() => preserveMainActivityInTransaction(db, cipher, { ...payment, callbacks: [payment.callbacks[0], payment.callbacks[0]] }), /UNIQUE/);
    assert.equal(Number(db.prepare("SELECT count(*) AS n FROM epay_main_activity_sources").get()?.n), 0);
    assert.equal(Number(db.prepare("SELECT count(*) AS n FROM epay_main_activity_import_runs").get()?.n), 0);
    const report = preserveMainActivityInTransaction(db, cipher, payment);
    assert.deepEqual(report.counts, { settlements: 1, callbacks: 1, syncJobs: 1 });
    assert.equal(report.replayEnabled, false);
    assert.equal(report.financiallyReconciled, false);
    assert.throws(() => preserveMainActivityInTransaction(db, cipher, payment), /already imported/);
    db.exec("COMMIT");
    db.close();
    assert.doesNotMatch(readFileSync(path).toString("latin1"), /private-callback|private-settlement|private-error/);
    db = new DatabaseSync(path, { enableForeignKeyConstraints: true, readBigInts });
    for (const kind of ["settlements", "callbacks", "syncJobs"] as const) assert.equal(readMainActivity(db, cipher, kind, payment[kind][0]!.id), JSON.stringify(payment[kind][0]));
    assert.throws(() => readMainActivity(db, new RuntimeSecretCipher(randomBytes(32), "fixture"), "callbacks", "callback"));
    db.prepare("UPDATE epay_main_activity_sources SET order_id=NULL WHERE kind='callbacks'").run();
    assert.throws(() => readMainActivity(db, cipher, "callbacks", "callback"), /identity mismatch/);
  } finally { db.close(); key.fill(0); rmSync(directory, { recursive: true, force: true }); }
});
