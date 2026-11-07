import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { writeEncryptedMainOrder } from "../src/epay-compat/main-order-source.ts";
import { writeEncryptedMainRefund } from "../src/epay-compat/main-refund-source.ts";

it("starts a loopback shadow process and checks fresh merchant access without production services", { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "perpay-shadow-process-"));
  const dataDir = join(directory, "data"), backupDir = join(directory, "backup");
  const key = randomBytes(32);
  const database = await AppDatabase.open(join(dataDir, "perpay.sqlite3"), { masterKey: key });
  database.write((db) => db.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'fixture',0,1,0,0);
    INSERT INTO epay_merchant_bindings(binding_id,main_api_id,main_merchant_id,epay_merchant_id,created_at,updated_at) VALUES ('binding','api','merchant',1,0,0);
    INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES ('trade','external',1,'fixture',100,'https://example.test','PAID','PENDING',0,0,0);
    INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,frozen_delta_cents,occurred_at,source) VALUES ('fixture-entry',1,'payment_paid',95,0,1,'perpay_epay');
    INSERT INTO epay_callback_jobs(trade_no,merchant_id,status,attempts,next_attempt_at,created_at,updated_at) VALUES ('trade',1,'SUCCEEDED',1,3,1,3);
    INSERT INTO epay_callback_attempts(attempt_id,trade_no,attempt_number,started_at,finished_at,outcome,http_status,method) VALUES ('attempt','trade',1,1,3,'SUCCESS',200,'POST')`));
  const cipher = new RuntimeSecretCipher(key, database.instanceId());
  database.write(db => {
    writeEncryptedMainOrder(db, cipher, JSON.stringify({ id: "historical", merchantId: "merchant", merchantOrderId: "legacy", amountCents: 100, status: "paid", createdAt: "2024-01-01T00:00:00Z", paymentHtml: "private-payment" }));
    writeEncryptedMainRefund(db, cipher, JSON.stringify({ id: "refund", merchantId: "merchant", orderId: "historical", amountCents: 50, status: "recorded", reference: "private-reference" }));
    const guard = cipher.createGuard();
    db.prepare("INSERT OR IGNORE INTO runtime_master_key_guard(singleton_key,cipher_version,nonce,ciphertext,authentication_tag,created_at) VALUES(1,1,?,?,?,0)").run(guard.nonce, guard.ciphertext, guard.authenticationTag);
    db.exec("INSERT INTO epay_main_order_import_runs VALUES(1,1); INSERT INTO epay_main_refund_import_runs VALUES(1,1)");
  });
  database.close();
  let permitted = true;
  const identity = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url !== "/api/merchant/access?merchantId=merchant" || req.headers.cookie !== "session=fixture") { res.writeHead(401).end("{}"); return; }
    if (!permitted) { res.writeHead(404).end("{}"); return; }
    res.end(JSON.stringify({ ok: true, merchantId: "merchant", apiId: "api", role: "owner" }));
  });
  await new Promise<void>((resolve) => identity.listen(0, "127.0.0.1", resolve));
  const identityAddress = identity.address();
  if (!identityAddress || typeof identityAddress === "string") throw new Error("invalid fixture identity address");
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("invalid fixture server address");
  const port = address.port;
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  const child = spawn(process.execPath, ["--experimental-strip-types", "src/main.ts"], {
    cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"],
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
      PERPAY_HOST: "127.0.0.1", PERPAY_PORT: String(port), PERPAY_DATA_DIR: dataDir, PERPAY_BACKUP_DIR: backupDir,
      PERPAY_MASTER_KEY: key.toString("hex"), PERPAY_PUBLIC_URL: `http://127.0.0.1:${port}`,
      PERPAY_EPAY_SHADOW_IDENTITY_ORIGIN: `http://127.0.0.1:${identityAddress.port}`, PERPAY_EPAY_SHADOW_MAIN_ORDERS: "true" },
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
  const exited = new Promise<void>((resolve) => { child.once("exit", () => resolve()); });
  const target = `http://127.0.0.1:${port}/api/merchant/epay/orders?merchantId=merchant`;
  try {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`shadow process exited during startup: ${stderr}`);
      try { response = await fetch(target, { headers: { cookie: "session=fixture" }, signal: AbortSignal.timeout(500) }); break; }
      catch { await delay(100); }
    }
    assert.ok(response, "shadow server did not start");
    assert.equal(response.status, 200);
    const body = await response.json() as { data: { total: number; orders: Array<{ tradeNo: string }> } };
    assert.equal(body.data.total, 1);
    assert.equal(body.data.orders[0]?.tradeNo, "trade");
    const legacyTarget = `${target}&format=legacy`;
    const legacyResponse = await fetch(legacyTarget, { headers: { cookie: "session=fixture" } });
    assert.equal(legacyResponse.status, 200);
    const legacy = await legacyResponse.json() as { data: { scope: string; invoiceAvailable: boolean; orders: Array<{ id: string; amount: string; status: string; canInvoice: boolean }> } };
    assert.equal(legacy.data.scope, "epay_only");
    assert.equal(legacy.data.invoiceAvailable, false);
    assert.deepEqual(legacy.data.orders.map((order) => [order.id, order.amount, order.status, order.canInvoice]), [["epay_trade", "1.00", "paid", false]]);
    const callbackTarget = `http://127.0.0.1:${port}/api/merchant/epay/callback-attempts?merchantId=merchant&tradeNo=trade`;
    const callbackResponse = await fetch(callbackTarget, { headers: { cookie: "session=fixture" } });
    assert.equal(callbackResponse.status, 200);
    const callbacks = await callbackResponse.json() as { data: { job: { status: string }; attempts: Array<{ id: string; outcome: string }> } };
    assert.equal(callbacks.data.job.status, "SUCCEEDED");
    assert.deepEqual(callbacks.data.attempts.map((attempt) => [attempt.id, attempt.outcome]), [["attempt", "SUCCESS"]]);
    const ledgerTarget = `http://127.0.0.1:${port}/api/merchant/epay/ledger-entries?merchantId=merchant`;
    const ledgerResponse = await fetch(ledgerTarget, { headers: { cookie: "session=fixture" } });
    assert.equal(ledgerResponse.status, 200);
    const ledger = await ledgerResponse.json() as { data: { reconciled: boolean; entries: Array<{ id: string; availableDeltaCents: number }> } };
    assert.equal(ledger.data.reconciled, false);
    assert.deepEqual(ledger.data.entries.map((entry) => [entry.id, entry.availableDeltaCents]), [["fixture-entry", 95]]);
    const historyTargets = ["main-orders", "main-refunds"].map(path => `http://127.0.0.1:${port}/api/merchant/epay/${path}?merchantId=merchant`);
    for (const historyTarget of historyTargets) {
      const history = await fetch(historyTarget, { headers: { cookie: "session=fixture" } });
      assert.equal(history.status, 200);
      const text = await history.text();
      assert.match(text, /historical|refund/);
      assert.match(text, /"reconciled":false/);
      assert.doesNotMatch(text, /private-payment|private-reference/);
    }
    permitted = false;
    for (const historyTarget of historyTargets) assert.equal((await fetch(historyTarget, { headers: { cookie: "session=fixture" } })).status, 404);
    assert.equal((await fetch(target, { headers: { cookie: "session=fixture" } })).status, 404);
    assert.equal((await fetch(legacyTarget, { headers: { cookie: "session=fixture" } })).status, 404);
    assert.equal((await fetch(callbackTarget, { headers: { cookie: "session=fixture" } })).status, 404);
    assert.equal((await fetch(ledgerTarget, { headers: { cookie: "session=fixture" } })).status, 404);
    assert.equal((await fetch(target)).status, 401);
  } finally {
    if (child.exitCode === null) child.kill();
    await exited;
    await new Promise<void>((resolve, reject) => identity.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
