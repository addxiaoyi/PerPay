import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";

import { importMainLedgerInTransaction } from "../src/epay-compat/isolated-import.ts";
import { EPAY_MAIN_LEDGER_SOURCE_SCHEMA_SQL, readEncryptedMainLedgerSource } from "../src/epay-compat/main-ledger-source.ts";
import { EPAY_COMPATIBILITY_SCHEMA_SQL } from "../src/epay-compat/schema.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";

for (const readBigInts of [false, true]) it(`imports a main-site ledger atomically and verifies it after reopening (readBigInts=${readBigInts})`, () => {
  const directory = mkdtempSync(join(tmpdir(), "epay-ledger-import-"));
  const file = join(directory, "ledger.sqlite");
  const key = randomBytes(32);
  const cipher = new RuntimeSecretCipher(key, "fixture");
  const entry = { id: "ledger-a", merchantId: "main-a", type: "payment_paid", at: "2024-01-02T03:04:05Z", availableDelta: 100, frozenDelta: 0 };
  const payment = { merchants: [{ id: "main-a", apiId: "api-a", feeRate: 0.05 }], ledger: [entry] };
  let db = new DatabaseSync(file, { enableForeignKeyConstraints: true, readBigInts });
  try {
    db.exec(`${EPAY_COMPATIBILITY_SCHEMA_SQL} ${EPAY_MAIN_LEDGER_SOURCE_SCHEMA_SQL}
      CREATE TABLE runtime_master_key_guard(singleton_key INTEGER PRIMARY KEY,cipher_version INTEGER,nonce BLOB,ciphertext BLOB,authentication_tag BLOB);
      INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES(1,'fixture',0,1,0,0);
      INSERT INTO epay_merchant_bindings VALUES('binding','api-a','main-a',1,0,0)`);
    const guard = cipher.createGuard();
    db.prepare("INSERT INTO runtime_master_key_guard VALUES(1,1,?,?,?)").run(guard.nonce, guard.ciphertext, guard.authenticationTag);
    assert.throws(() => importMainLedgerInTransaction(db, cipher, payment), /requires a transaction/);
    db.exec("BEGIN IMMEDIATE");
    assert.throws(() => importMainLedgerInTransaction(db, new RuntimeSecretCipher(randomBytes(32), "fixture"), payment));
    const invalid = { ...payment, ledger: [entry, { ...entry, id: "ledger-b", at: "2024-02-30T00:00:00Z" }] };
    assert.throws(() => importMainLedgerInTransaction(db, cipher, invalid), /invalid main ledger timestamp/);
    assert.equal(Number(db.prepare("SELECT count(*) AS count FROM epay_balance_ledger").get()?.count), 0);
    assert.equal(Number(db.prepare("SELECT count(*) AS count FROM epay_main_ledger_import_runs").get()?.count), 0);
    assert.equal(importMainLedgerInTransaction(db, cipher, payment).count, 1);
    db.exec("COMMIT");
    db.close();
    db = new DatabaseSync(file, { enableForeignKeyConstraints: true, readBigInts });
    assert.equal(readEncryptedMainLedgerSource(db, cipher, entry.id), JSON.stringify(entry));
    assert.equal(Number(db.prepare("SELECT entry_count FROM epay_main_ledger_import_runs").get()?.entry_count), 1);
    db.exec("BEGIN IMMEDIATE");
    assert.throws(() => importMainLedgerInTransaction(db, cipher, payment), /already imported/);
    db.exec("ROLLBACK");
  } finally {
    db.close();
    key.fill(0);
    rmSync(directory, { recursive: true, force: true });
  }
});
