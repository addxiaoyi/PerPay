import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { createMerchantSecretReader, pinOrderSigningKey } from "../src/epay-compat/merchant-secret.ts";
import { EPayCallbackOutbox } from "../src/epay-compat/outbox.ts";
import { EPayCallbackProcessor } from "../src/epay-compat/callback-processor.ts";
import { verifyEPaySign } from "../src/epay-compat/sign.ts";
import { recordSyntheticAlipayConfirmation } from "./epay-payment-fixture.ts";

it("uses authenticated merchant-bound keys for callbacks and rejects copied or damaged ciphertext", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-secret-"));
  const key = randomBytes(32);
  const db = await AppDatabase.open(join(dir, "db.sqlite"), { masterKey: key });
  try {
    const cipher = new RuntimeSecretCipher(key, db.instanceId());
    const sealed = cipher.encrypt("epay:merchant:1:api_key", 2, "isolated-key");
    db.write((sql) => {
      sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'a',0,1,0,0),(2,'b',0,1,0,0);
        INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES ('a','a',1,'item',100,100,'https://example.test','PAID','PENDING',0,0,0), ('b','b',2,'item',100,100,'https://example.test','PAID','PENDING',0,0,0)`);
      const insert = sql.prepare("INSERT INTO epay_merchant_secrets VALUES (?,2,1,?,?,?,?,0)");
      const fingerprint = createHash("sha256").update("isolated-key").digest("hex");
      for (const id of [1, 2]) insert.run(id, sealed.nonce, sealed.ciphertext, sealed.authenticationTag, fingerprint);
      recordSyntheticAlipayConfirmation(sql, "a", 1);
      recordSyntheticAlipayConfirmation(sql, "b", 2);
      pinOrderSigningKey(sql, 1, "a");
      pinOrderSigningKey(sql, 2, "b");
    });
    const secret = createMerchantSecretReader(db, key);
    assert.equal(secret(1), "isolated-key");
    assert.throws(() => secret(2), /key invalid/);
    assert.throws(() => createMerchantSecretReader(db, randomBytes(32))(1), /key invalid/);
    assert.throws(() => secret(3), /unavailable/);
    const queue = new EPayCallbackOutbox(db);
    queue.enqueue("a", 1, 100);
    queue.enqueue("b", 2, 100);
    let deliveries = 0;
    let now = 100;
    const processor = new EPayCallbackProcessor({ database: db, secret, clock: () => now, transport: () => ({ async post(request) {
      deliveries++;
      assert.equal(verifyEPaySign(Object.fromEntries(new URLSearchParams(request.body.toString())), "isolated-key"), true);
      return { status: 200, body: Buffer.from("success"), contentType: null, contentEncoding: null, responseFingerprint: "", resolvedAddressesFingerprint: "", connectedAddress: "" };
    } }) });
    const policy = { timeoutMilliseconds: 1000, leaseMilliseconds: 2000, maximumAttempts: 2, retryDelayMilliseconds: 10 };
    await processor.processOne(policy);
    await processor.processOne(policy);
    assert.equal(deliveries, 1);
    let jobs = db.read((sql) => sql.prepare("SELECT trade_no,status FROM epay_callback_jobs ORDER BY trade_no").all());
    assert.deepEqual(jobs.map((row) => [row.trade_no, row.status]), [["a", "SUCCEEDED"], ["b", "PENDING"]]);
    now = 110;
    assert.equal(await processor.processOne(policy), true);
    assert.equal(deliveries, 1);
    jobs = db.read((sql) => sql.prepare("SELECT trade_no,status FROM epay_callback_jobs ORDER BY trade_no").all());
    assert.deepEqual(jobs.map((row) => [row.trade_no, row.status]), [["a", "SUCCEEDED"], ["b", "FAILED"]]);
    db.write((sql) => sql.prepare("UPDATE epay_merchant_secrets SET secret_fingerprint=? WHERE merchant_id=1").run("0".repeat(64)));
    assert.throws(() => secret(1), /key invalid/);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("retains the order's pinned merchant key on a durable callback retry after rotation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-secret-rotation-"));
  const masterKey = randomBytes(32);
  const db = await AppDatabase.open(join(dir, "db.sqlite"), { masterKey });
  try {
    const cipher = new RuntimeSecretCipher(masterKey, db.instanceId());
    const storeSecret = (version: number, value: string) => {
      const encrypted = cipher.encrypt("epay:merchant:1:api_key", version, value);
      const fingerprint = createHash("sha256").update(value).digest("hex");
      db.write((sql) => sql.prepare(`INSERT INTO epay_merchant_secrets VALUES (?,?,1,?,?,?,?,0)
        ON CONFLICT(merchant_id) DO UPDATE SET secret_version=excluded.secret_version, nonce=excluded.nonce,
        ciphertext=excluded.ciphertext, authentication_tag=excluded.authentication_tag, secret_fingerprint=excluded.secret_fingerprint`)
        .run(1, version, encrypted.nonce, encrypted.ciphertext, encrypted.authenticationTag, fingerprint));
    };
    db.write((sql) => sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'merchant',0,1,0,0);
      INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES ('trade','external',1,'item',100,100,'https://example.test','PAID','PENDING',0,0,0)`));
    db.write((sql) => recordSyntheticAlipayConfirmation(sql, "trade", 1));
    storeSecret(1, "old-key");
    db.write(sql => pinOrderSigningKey(sql, 1, "trade"));
    new EPayCallbackOutbox(db).enqueue("trade", 1, 100);
    let now = 100;
    const signedRequests: Record<string, string>[] = [];
    const processor = new EPayCallbackProcessor({ database: db, secret: createMerchantSecretReader(db, masterKey), clock: () => now, transport: () => ({ async post(request) {
      signedRequests.push(Object.fromEntries(new URLSearchParams(request.body.toString())));
      return { status: 200, body: Buffer.from(signedRequests.length === 1 ? "retry" : "success"), contentType: null, contentEncoding: null, responseFingerprint: "", resolvedAddressesFingerprint: "", connectedAddress: "" };
    } }) });
    const policy = { timeoutMilliseconds: 1000, leaseMilliseconds: 2000, maximumAttempts: 2, retryDelayMilliseconds: 10 };
    assert.equal(await processor.processOne(policy), true);
    storeSecret(2, "new-key");
    now = 110;
    assert.equal(await processor.processOne(policy), true);
    assert.equal(signedRequests.length, 2);
    assert.equal(verifyEPaySign(signedRequests[0]!, "old-key"), true);
    assert.equal(verifyEPaySign(signedRequests[0]!, "new-key"), false);
    assert.equal(verifyEPaySign(signedRequests[1]!, "new-key"), false);
    assert.equal(verifyEPaySign(signedRequests[1]!, "old-key"), true);
    assert.equal(createMerchantSecretReader(db, masterKey)(1), "new-key");
    const job = db.read((sql) => sql.prepare("SELECT status FROM epay_callback_jobs WHERE trade_no='trade'").get());
    assert.equal(job?.status, "SUCCEEDED");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
