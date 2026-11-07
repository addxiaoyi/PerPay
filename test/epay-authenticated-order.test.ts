import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { createAuthenticatedOrderValidator, withAuthenticatedOrder } from "../src/epay-compat/authenticated-order.ts";
import { epaySign } from "../src/epay-compat/sign.ts";

it("validates signed orders only against an explicitly bound active merchant and site", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-order-auth-"));
  const masterKey = randomBytes(32);
  const db = await AppDatabase.open(join(dir, "db.sqlite"), { masterKey });
  try {
    const cipher = new RuntimeSecretCipher(masterKey, db.instanceId());
    const encrypted = cipher.encrypt("epay:merchant:1:api_key", 1, "fixture-key");
    db.write((sql) => {
      sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'a',0,1,0,0),(2,'b',0,1,0,0);
        INSERT INTO api_client_config(client_id,secret_fingerprint,key_version,enabled,created_at,updated_at) VALUES ('site-one','${"a".repeat(64)}',1,1,0,0);
        INSERT INTO sites(client_id,revision,configuration,created_at,updated_at) VALUES ('site-one',0,'{"accepting_orders":true}',0,0);
        INSERT INTO epay_site_bindings VALUES (1,'site-one',0)`);
      sql.prepare("INSERT INTO epay_merchant_secrets VALUES (1,1,1,?,?,?,?,0)").run(encrypted.nonce, encrypted.ciphertext, encrypted.authenticationTag, createHash("sha256").update("fixture-key").digest("hex"));
    });
    const fields = { pid: "1", type: "alipay", out_trade_no: "external", money: "1.00", name: "item", clientip: "127.0.0.1", notify_url: "https://example.test" };
    const signed = { ...fields, sign: epaySign(fields, "fixture-key"), sign_type: "MD5" };
    const validate = createAuthenticatedOrderValidator(db, masterKey);
    assert.equal(validate(signed, "api").siteClientId, "site-one");
    const insertOrder = (sql: import("node:sqlite").DatabaseSync, order: ReturnType<typeof validate>) => sql.prepare(`INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at)
      VALUES ('trade',?,?,?,?,?,'PENDING','PENDING',0,0,0)`).run(order.merchantOrderNo, order.merchantId, order.name, order.amountCents, order.notifyUrl);
    assert.throws(() => withAuthenticatedOrder(db, masterKey, signed, "api", (sql, order) => { insertOrder(sql, order); throw new Error("fixture failure"); }), /fixture failure/);
    assert.equal(Number(db.read((sql) => sql.prepare("SELECT count(*) AS count FROM epay_orders").get())?.count), 0);
    assert.throws(() => withAuthenticatedOrder(db, masterKey, signed, "api", (sql, order) => { insertOrder(sql, order); return Promise.resolve(); }), /synchronous/);
    assert.equal(Number(db.read((sql) => sql.prepare("SELECT count(*) AS count FROM epay_orders").get())?.count), 0);
    withAuthenticatedOrder(db, masterKey, signed, "api", insertOrder);
    assert.equal(Number(db.read((sql) => sql.prepare("SELECT count(*) AS count FROM epay_orders").get())?.count), 1);
    assert.throws(() => validate({ ...signed, money: "2.00" }, "api"), /authentication/);
    const other = { ...fields, pid: "2" };
    assert.throws(() => validate({ ...other, sign: epaySign(other, "fixture-key"), sign_type: "MD5" }, "api"), /authentication/);
    assert.throws(() => db.write((sql) => sql.prepare("INSERT INTO epay_site_bindings VALUES (2,'site-one',0)").run()), /UNIQUE/);
    assert.throws(() => db.write((sql) => sql.prepare("DELETE FROM epay_site_bindings WHERE merchant_id=1").run()), /immutable/);
    db.write((sql) => sql.prepare("UPDATE api_client_config SET enabled=0 WHERE client_id='site-one'").run());
    assert.throws(() => validate(signed, "api"), /authentication/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
