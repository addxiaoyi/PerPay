import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AppDatabase } from "../dist/database/database.js";
import { auditConfirmedPayments } from "../dist/epay-compat/confirmation-audit.js";
import { auditBalanceMovements, captureBalanceCheckpoint } from "../dist/epay-compat/balance-checkpoint.js";

const containerMode = process.env.EPAY_CONTAINER_ISOLATED === "1";
const loopbackMode = process.env.EPAY_LOOPBACK_CHECK === "1";
if (containerMode === loopbackMode) throw new Error("select exactly one explicit shadow check mode");
const directory = mkdtempSync(join(tmpdir(), "perpay-shadow-"));
const dataDir = join(directory, "data"), backupDir = join(directory, "backup");
const key = randomBytes(32);
let identity, child;
try {
  const db = await AppDatabase.open(join(dataDir, "perpay.sqlite3"), { masterKey: key });
  try {
    db.write((sql) => sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'fixture',0,1,0,0);
      INSERT INTO epay_merchant_bindings(binding_id,main_api_id,main_merchant_id,epay_merchant_id,created_at,updated_at) VALUES ('binding','api','merchant',1,0,0);
      INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES ('trade','external',1,'fixture',100,'https://example.test','PENDING','PENDING',0,0,0)`));
    const baseline = db.write(captureBalanceCheckpoint);
    db.write((sql) => sql.exec(`INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,type_code,name,money_cents,real_money_cents,get_money_cents,api_trade_no,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES ('confirmed','synthetic',1,'alipay','fixture',100,100,100,'provider-fixture','https://example.test','PAID','PENDING',0,0,0);
      INSERT INTO epay_alipay_intents VALUES ('confirmed',1,'app','seller','fixture-key',100,5,0);
      INSERT INTO epay_alipay_confirmations VALUES ('confirmed','provider-fixture',1,100,5,0);
      INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,occurred_at,source) VALUES('epay_payment:confirmed',1,'payment_paid',95,0,'perpay_epay');
      INSERT INTO epay_callback_jobs(trade_no,merchant_id,status,next_attempt_at,created_at,updated_at) VALUES('confirmed',1,'PENDING',0,0,0)`));
    assert.deepEqual(db.read(auditConfirmedPayments), { confirmed: 1, inconsistent: 0, unconfirmedLedger: 0, unconfirmedCallbacks: 0, paidWithoutConfirmation: 0, intentPaidWithoutConfirmation: 0, paidWithoutIntent: 0 });
    assert.equal(auditBalanceMovements(baseline, db.write(captureBalanceCheckpoint)).balanceMismatches, 1);
  } finally { db.close(); }
  let permitted = true;
  let apiId = "api";
  identity = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.headers.cookie !== "session=fixture") { res.writeHead(401).end("{}"); return; }
    if (!permitted || req.url !== "/api/merchant/access?merchantId=merchant") { res.writeHead(404).end("{}"); return; }
    res.end(JSON.stringify({ ok: true, merchantId: "merchant", apiId, role: "owner" }));
  });
  await new Promise((resolve) => identity.listen(0, "127.0.0.1", resolve));
  const reserved = createServer();
  await new Promise((resolve) => reserved.listen(0, "127.0.0.1", resolve));
  const port = reserved.address().port;
  await new Promise((resolve, reject) => reserved.close((error) => error ? reject(error) : resolve()));
  child = spawn(process.execPath, ["dist/main.js"], {
    cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"],
    env: { PATH: process.env.PATH, HOME: directory, NODE_ENV: "production", PERPAY_HOST: "127.0.0.1", PERPAY_PORT: String(port),
      PERPAY_DATA_DIR: dataDir, PERPAY_BACKUP_DIR: backupDir, PERPAY_MASTER_KEY: key.toString("hex"),
      PERPAY_PUBLIC_URL: `http://127.0.0.1:${port}`, PERPAY_EPAY_SHADOW_IDENTITY_ORIGIN: `http://127.0.0.1:${identity.address().port}` },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000); });
  const target = `http://127.0.0.1:${port}/api/merchant/epay/orders?merchantId=merchant`;
  let response;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`shadow startup failed: ${stderr}`);
    try { response = await fetch(target, { headers: { cookie: "session=fixture" }, signal: AbortSignal.timeout(500) }); break; }
    catch { await delay(100); }
  }
  assert.ok(response, "shadow server did not start");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.total, 2);
  assert.deepEqual(new Set(body.data.orders.map((order) => order.tradeNo)), new Set(["trade", "confirmed"]));
  apiId = "different-api";
  assert.equal((await fetch(target, { headers: { cookie: "session=fixture" } })).status, 404);
  apiId = "api";
  permitted = false;
  assert.equal((await fetch(target, { headers: { cookie: "session=fixture" } })).status, 404);
  assert.equal((await fetch(target)).status, 401);
  console.log(JSON.stringify({ shadowStarted: true, networkIsolationClaimed: containerMode, syntheticOrders: 2, syntheticConfirmationAudit: true, syntheticBalanceMismatchDetected: true, providerVerification: false, accessRevoked: true, productionDataUsed: false }));
} finally {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
  if (identity) await new Promise((resolve, reject) => identity.close((error) => error ? reject(error) : resolve()));
  rmSync(directory, { recursive: true, force: true });
}
