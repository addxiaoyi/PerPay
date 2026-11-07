import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { EPAY_COMPATIBILITY_SCHEMA_SQL } from "../src/epay-compat/schema.ts";
import { EPAY_MAIN_REFUND_SOURCE_SCHEMA_SQL, readEncryptedMainRefund, writeEncryptedMainRefund } from "../src/epay-compat/main-refund-source.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";

it("preserves refund source records encrypted and fences merchant access", () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-refund-source-"));
  const path = join(dir, "fixture.sqlite"), key = randomBytes(32), cipher = new RuntimeSecretCipher(key, "fixture");
  let db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  const raw = JSON.stringify({ id: "refund-1", merchantId: "main-1", orderId: "order-1", amountCents: 100, status: "pending", reason: "fixture-sensitive-refund-reason" });
  try {
    db.exec(`${EPAY_COMPATIBILITY_SCHEMA_SQL} ${EPAY_MAIN_REFUND_SOURCE_SCHEMA_SQL}
      INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES(1,'one',0,1,0,0),(2,'two',0,1,0,0);
      INSERT INTO epay_merchant_bindings VALUES('b1','api-1','main-1',1,0,0),('b2','api-2','main-2',2,0,0)`);
    writeEncryptedMainRefund(db, cipher, raw);
    assert.throws(() => writeEncryptedMainRefund(db, cipher, raw), /UNIQUE/);
    assert.throws(() => writeEncryptedMainRefund(db, cipher, JSON.stringify({ id: "bad", merchantId: "missing", amountCents: 1, status: "pending" })), /binding is unresolved/);
    assert.throws(() => writeEncryptedMainRefund(db, cipher, JSON.stringify({ id: "bad", merchantId: "main-1", amountCents: 1.5, status: "pending" })), /invalid main refund fields/);
    db.close();
    assert.equal(readFileSync(path).includes(Buffer.from("fixture-sensitive-refund-reason")), false);
    db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    const own = { mainMerchantId: "main-1", mainApiId: "api-1", epayMerchantId: 1 };
    assert.equal(readEncryptedMainRefund(db, cipher, "refund-1", own), raw);
    assert.equal(readEncryptedMainRefund(db, cipher, "refund-1", { mainMerchantId: "main-2", mainApiId: "api-2", epayMerchantId: 2 }), null);
    assert.throws(() => readEncryptedMainRefund(db, new RuntimeSecretCipher(randomBytes(32), "fixture"), "refund-1", own));
    db.prepare("UPDATE epay_main_refund_sources SET authentication_tag=? WHERE refund_id=?").run(Buffer.alloc(16), "refund-1");
    assert.throws(() => readEncryptedMainRefund(db, cipher, "refund-1", own));
  } finally { db.close(); key.fill(0); rmSync(dir, { recursive: true, force: true }); }
});
