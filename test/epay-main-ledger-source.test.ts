import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { EPAY_MAIN_LEDGER_SOURCE_SCHEMA_SQL, readEncryptedMainLedgerSource, writeEncryptedMainLedgerSource } from "../src/epay-compat/main-ledger-source.ts";
import { EPAY_COMPATIBILITY_SCHEMA_SQL } from "../src/epay-compat/schema.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";

it("protects full main ledger records and binds ciphertext to the entry and merchant", () => {
  const directory = mkdtempSync(join(tmpdir(), "epay-main-ledger-source-"));
  const file = join(directory, "db.sqlite");
  const key = randomBytes(32);
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: true });
  const cipher = new RuntimeSecretCipher(key, "fixture-instance");
  const raw = JSON.stringify({ id: "entry-a", merchantId: "main-a", type: "payment_paid", availableDelta: 100, frozenDelta: 0, at: "1970-01-01T00:00:00.001Z", privateMemo: "fixture-private-ledger-memo" });
  const other = JSON.stringify({ id: "entry-b", merchantId: "main-a", type: "payment_paid", availableDelta: 200, frozenDelta: 0, at: "1970-01-01T00:00:00.001Z", privateMemo: "fixture-other-memo" });
  try {
    {
      const sql = db;
      sql.exec(`${EPAY_COMPATIBILITY_SCHEMA_SQL} ${EPAY_MAIN_LEDGER_SOURCE_SCHEMA_SQL}`);
      sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'fixture',0,1,0,0);
        INSERT INTO epay_merchant_bindings(binding_id,main_api_id,main_merchant_id,epay_merchant_id,created_at,updated_at) VALUES ('binding','api','main-a',1,0,0);
        INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,frozen_delta_cents,occurred_at,source) VALUES ('entry-a',1,'payment_paid',100,0,1,'main_site'),('entry-b',1,'payment_paid',200,0,1,'main_site')`);
      writeEncryptedMainLedgerSource(sql, cipher, "entry-a", raw);
      writeEncryptedMainLedgerSource(sql, cipher, "entry-b", other);
    }
    assert.equal(readEncryptedMainLedgerSource(db, cipher, "entry-a"), raw);
    assert.throws(() => readEncryptedMainLedgerSource(db, new RuntimeSecretCipher(randomBytes(32), "fixture-instance"), "entry-a"));
    assert.throws(() => writeEncryptedMainLedgerSource(db, cipher, "entry-a", JSON.stringify({ id: "entry-a", merchantId: "other" })), /identity mismatch/);
    db.exec("UPDATE epay_balance_ledger SET available_delta_cents=101 WHERE entry_id='entry-a'");
    assert.throws(() => readEncryptedMainLedgerSource(db, cipher, "entry-a"), /values mismatch/);
    db.exec("UPDATE epay_balance_ledger SET available_delta_cents=100 WHERE entry_id='entry-a'");
    db.exec(`UPDATE epay_main_ledger_sources SET
      nonce=(SELECT nonce FROM epay_main_ledger_sources WHERE entry_id='entry-a'),
      ciphertext=(SELECT ciphertext FROM epay_main_ledger_sources WHERE entry_id='entry-a'),
      authentication_tag=(SELECT authentication_tag FROM epay_main_ledger_sources WHERE entry_id='entry-a') WHERE entry_id='entry-b'`);
    assert.throws(() => readEncryptedMainLedgerSource(db, cipher, "entry-b"));
  } finally {
    db.close();
    key.fill(0);
  }
  try {
    for (const path of [file, `${file}-wal`, `${file}-journal`]) {
      if (existsSync(path)) assert.equal(readFileSync(path).includes(Buffer.from("fixture-private-ledger-memo")), false);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
