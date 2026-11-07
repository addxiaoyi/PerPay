import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { EPAY_COMPATIBILITY_SCHEMA_SQL } from "../src/epay-compat/schema.ts";
import { EPAY_MAIN_REFUND_SOURCE_SCHEMA_SQL, readEncryptedMainRefund } from "../src/epay-compat/main-refund-source.ts";
import { importMainRefundsInTransaction } from "../src/epay-compat/main-refund-import.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";

for (const readBigInts of [false, true]) it(`preserves refund batches atomically without claiming financial reconciliation (readBigInts=${readBigInts})`, () => {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true, readBigInts });
  const key = randomBytes(32), cipher = new RuntimeSecretCipher(key, "fixture");
  const refund = { id: "refund", merchantId: "main", orderId: "order", amountCents: 50, status: "processing" };
  const source = { merchants: [{ id: "main", apiId: "api" }], orders: [{ id: "order", merchantId: "main", amountCents: 100 }], refunds: [refund] };
  try {
    db.exec(`${EPAY_COMPATIBILITY_SCHEMA_SQL} ${EPAY_MAIN_REFUND_SOURCE_SCHEMA_SQL}
      CREATE TABLE runtime_master_key_guard(singleton_key INTEGER PRIMARY KEY,cipher_version INTEGER,nonce BLOB,ciphertext BLOB,authentication_tag BLOB);
      INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES(1,'merchant',0,1,0,0),(2,'other',0,1,0,0);
      INSERT INTO epay_merchant_bindings VALUES('binding','api','main',1,0,0),('binding2','api2','other',2,0,0)`);
    const guard = cipher.createGuard();
    db.prepare("INSERT INTO runtime_master_key_guard VALUES(1,1,?,?,?)").run(guard.nonce, guard.ciphertext, guard.authenticationTag);
    assert.throws(() => importMainRefundsInTransaction(db, cipher, source), /requires a transaction/);
    db.exec("BEGIN IMMEDIATE");
    assert.throws(() => importMainRefundsInTransaction(db, new RuntimeSecretCipher(randomBytes(32), "fixture"), source), /MASTER_KEY/);
    assert.throws(() => importMainRefundsInTransaction(db, cipher, { ...source, refunds: [refund, { ...refund, id: "other", orderId: "missing" }] }), /order link is inconsistent/);
    assert.throws(() => importMainRefundsInTransaction(db, cipher, { ...source, refunds: [refund, { ...refund, id: "other", amountCents: 101 }] }), /order link is inconsistent/);
    assert.throws(() => importMainRefundsInTransaction(db, cipher, { ...source, merchants: [...source.merchants, { id: "other", apiId: "api2" }], orders: [...source.orders, { id: "other-order", merchantId: "other", amountCents: 100 }], refunds: [refund, { ...refund, id: "cross", orderId: "other-order" }] }), /order link is inconsistent/);
    assert.throws(() => importMainRefundsInTransaction(db, cipher, { ...source, refunds: [refund, refund] }), /UNIQUE/);
    assert.equal(Number(db.prepare("SELECT count(*) AS count FROM epay_main_refund_sources").get()?.count), 0);
    assert.equal(importMainRefundsInTransaction(db, cipher, source), 1);
    assert.equal(readEncryptedMainRefund(db, cipher, "refund"), JSON.stringify(refund));
    assert.throws(() => importMainRefundsInTransaction(db, cipher, source), /already imported/);
    db.exec("COMMIT");
  } finally { db.close(); key.fill(0); }
});
