import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { createIsolatedCheckoutStatus, issueCheckoutToken } from "../src/epay-compat/isolated-checkout-status.ts";
import { recordSyntheticAlipayConfirmation } from "./epay-payment-fixture.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { verifyEPaySign } from "../src/epay-compat/sign.ts";
import { PublicCheckoutRateLimiter } from "../src/http/public-checkout-rate-limit.ts";

it("reveals confirmed status only with a valid scoped, unexpired capability and matching ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-checkout-status-"));
  const key = randomBytes(32);
  const db = await AppDatabase.open(join(dir, "db.sqlite"), { masterKey: key });
  const trade = "a".repeat(32);
  let now = 100;
  try {
    db.write((sql) => {
      sql.exec("INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'m',0,1,0,0)");
      sql.prepare("INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES (?,'outside',1,'item',100,100,'https://example.test','PENDING','PENDING',0,0,0)").run(trade);
    });
    const app = createIsolatedCheckoutStatus(db, key, () => now);
    const token = issueCheckoutToken(key, db.instanceId(), trade, 1, now);
    const request = (value: string) => app.request("/checkout-status", { headers: { "x-checkout-token": value } });
    assert.deepEqual(await (await request(token)).json(), { status: "pending" });
    assert.equal((await request(token.replace(/.$/, token.endsWith("A") ? "B" : "A"))).status, 404);
    assert.equal((await request(issueCheckoutToken(key, db.instanceId(), trade, 2, now))).status, 409);
    db.write((sql) => {
      sql.prepare("UPDATE epay_orders SET status='PAID' WHERE trade_no=?").run(trade);
      recordSyntheticAlipayConfirmation(sql, trade, 1);
    });
    assert.deepEqual(await (await request(token)).json(), { status: "paid" });
    db.write((sql) => sql.prepare("UPDATE epay_orders SET return_url='https://merchant.example/return' WHERE trade_no=?").run(trade));
    assert.deepEqual(await (await request(token)).json(), { status: "paid", returnAvailable: false });
    const sealed = new RuntimeSecretCipher(key, db.instanceId()).encrypt("epay:merchant:1:api_key", 1, "fixture-key");
    db.write((sql) => sql.prepare("INSERT INTO epay_merchant_secrets VALUES (1,1,1,?,?,?,?,0)").run(sealed.nonce, sealed.ciphertext, sealed.authenticationTag, createHash("sha256").update("fixture-key").digest("hex")));
    const paid = await (await request(token)).json() as { status: string; returnUrl: string };
    assert.equal(paid.status, "paid");
    assert.equal(verifyEPaySign(Object.fromEntries(new URL(paid.returnUrl).searchParams), "fixture-key"), true);
    db.write((sql) => sql.prepare("UPDATE epay_orders SET return_url='https://merchant.example/return?trade_status=PAID' WHERE trade_no=?").run(trade));
    assert.deepEqual(await (await request(token)).json(), { status: "paid", returnAvailable: false });
    db.write((sql) => sql.prepare("UPDATE epay_balance_ledger SET available_delta_cents=100 WHERE entry_id=?").run(`epay_payment:${trade}`));
    assert.equal((await request(token)).status, 409);
    now += 2 * 60 * 60 * 1000;
    assert.equal((await request(token)).status, 404);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("applies a bounded process-wide budget before reading an order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-checkout-limit-"));
  const key = randomBytes(32);
  const db = await AppDatabase.open(join(dir, "db.sqlite"), { masterKey: key });
  try {
    const limiter = new PublicCheckoutRateLimiter({ sourceBurst: 1, sourceRequestsPerSecond: 0.001, globalBurst: 1, globalRequestsPerSecond: 0.001 });
    const app = createIsolatedCheckoutStatus(db, key, () => 100, limiter);
    assert.equal((await app.request("/checkout-status")).status, 404);
    const limited = await app.request("/checkout-status");
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "1");
    assert.equal(limited.headers.get("cache-control"), "no-store");
    assert.deepEqual(await limited.json(), { status: "rate_limited" });
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
