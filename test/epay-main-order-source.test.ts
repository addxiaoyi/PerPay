import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { EPAY_MAIN_ORDER_SOURCE_SCHEMA_SQL, readEncryptedMainOrder, writeEncryptedMainOrder } from "../src/epay-compat/main-order-source.ts";
import { EPAY_COMPATIBILITY_SCHEMA_SQL } from "../src/epay-compat/schema.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";

it("retains original order data encrypted and binds it to the mapped merchant and fields", () => {
  const directory = mkdtempSync(join(tmpdir(), "epay-main-orders-"));
  const file = join(directory, "db.sqlite"), key = randomBytes(32);
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: true });
  const cipher = new RuntimeSecretCipher(key, "fixture-instance");
  const order = { id: "order-a", merchantId: "main-a", merchantOrderId: "customer-order", amountCents: 100, status: "paid", createdAt: "2024-01-02T03:04:05Z", paymentHtml: "fixture-sensitive-payment-html" };
  const raw = JSON.stringify(order);
  try {
    db.exec(`${EPAY_COMPATIBILITY_SCHEMA_SQL} ${EPAY_MAIN_ORDER_SOURCE_SCHEMA_SQL}`);
    db.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'a',0,1,0,0),(2,'b',0,1,0,0);
      INSERT INTO epay_merchant_bindings(binding_id,main_api_id,main_merchant_id,epay_merchant_id,created_at,updated_at) VALUES ('a','api-a','main-a',1,0,0),('b','api-b','main-b',2,0,0)`);
    writeEncryptedMainOrder(db, cipher, raw);
    assert.equal(readEncryptedMainOrder(db, cipher, order.id), raw);
    const scope = { mainMerchantId: "main-a", mainApiId: "api-a", epayMerchantId: 1 };
    assert.equal(readEncryptedMainOrder(db, cipher, order.id, scope), raw);
    db.exec("UPDATE epay_merchant_bindings SET main_api_id='changed' WHERE main_merchant_id='main-a'");
    assert.equal(readEncryptedMainOrder(db, cipher, order.id, scope), null);
    db.exec("UPDATE epay_merchant_bindings SET main_api_id='api-a' WHERE main_merchant_id='main-a'");
    db.exec("UPDATE epay_merchant_accounts SET enabled=0 WHERE merchant_id=1");
    assert.equal(readEncryptedMainOrder(db, cipher, order.id, scope), null);
    db.exec("UPDATE epay_merchant_accounts SET enabled=1 WHERE merchant_id=1");
    assert.throws(() => readEncryptedMainOrder(db, new RuntimeSecretCipher(randomBytes(32), "fixture-instance"), order.id));
    assert.throws(() => writeEncryptedMainOrder(db, cipher, JSON.stringify({ ...order, id: "other", merchantId: "unknown" })), /binding is unresolved/);
    assert.throws(() => writeEncryptedMainOrder(db, cipher, JSON.stringify({ ...order, id: "other", createdAt: "2024-02-30T00:00:00Z" })), /timestamp/);
    db.exec("UPDATE epay_main_order_sources SET amount_cents=101 WHERE order_id='order-a'");
    assert.throws(() => readEncryptedMainOrder(db, cipher, order.id), /values mismatch/);
    db.exec("UPDATE epay_main_order_sources SET amount_cents=100,merchant_id=2 WHERE order_id='order-a'");
    assert.throws(() => readEncryptedMainOrder(db, cipher, order.id));
  } finally { db.close(); key.fill(0); }
  try {
    for (const path of [file, `${file}-wal`, `${file}-journal`]) if (existsSync(path)) assert.equal(readFileSync(path).includes(Buffer.from("fixture-sensitive-payment-html")), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
