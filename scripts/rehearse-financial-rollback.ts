import assert from "node:assert/strict";
import { createCipheriv, createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { AppDatabase } from "../src/database/database.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { confirmAlipayPayment } from "../src/epay-compat/confirm-alipay.ts";
import { confirmWechatPayment } from "../src/epay-compat/confirm-wechat.ts";
import { auditConfirmedPayments } from "../src/epay-compat/confirmation-audit.ts";
import { EPayCallbackProcessor } from "../src/epay-compat/callback-processor.ts";
import { pauseEPayOrders } from "../src/epay-compat/pause-orders.ts";
import { readLiveBalance } from "../src/epay-compat/live-balance.ts";
import { verifyEPaySign } from "../src/epay-compat/sign.ts";

const FINANCIAL_TABLES = ["epay_orders", "epay_balance_ledger", "epay_live_balances", "epay_balance_openings", "epay_alipay_confirmations", "epay_wechat_confirmations", "epay_callback_jobs", "epay_callback_attempts", "epay_invoices", "epay_invoice_applications"] as const;
const [sourceRoot, reportPath] = process.argv.slice(2);
if (process.env.EPAY_ISOLATED_TEST !== "1" || !sourceRoot || !/^\/var\/lib\/perpay-candidate-[a-z0-9-]+$/.test(sourceRoot) || resolve(sourceRoot) !== sourceRoot || realpathSync(sourceRoot) !== sourceRoot || !reportPath || !reportPath.startsWith("/root/perpay-recovery-") || resolve(reportPath) !== reportPath) throw new Error("isolated rollback rehearsal requires explicit source and fresh report paths");
process.umask(0o077);
const directory = mkdtempSync("/dev/shm/perpay-financial-rollback-");
const source = new DatabaseSync(join(sourceRoot, "data/perpay.sqlite3"), { readOnly: true });
const masterKey = Buffer.from(readFileSync(join(sourceRoot, "secrets/master-key"), "utf8").trim(), "hex");
assert.equal(masterKey.length, 32);
let candidate: AppDatabase | undefined;

function fingerprint(sql: DatabaseSync) {
  const records = FINANCIAL_TABLES.map(table => {
    const query = sql.prepare(`SELECT * FROM ${table}`);
    query.setReadBigInts(true);
    return [table, query.all().map(row => JSON.stringify(row, (_, value: unknown) => typeof value === "bigint" ? value.toString() : value)).sort()];
  });
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}

try {
  source.exec("BEGIN");
  const productionBefore = fingerprint(source);
  source.exec("COMMIT");
  const path = join(directory, "rehearsal.sqlite3");
  await backup(source, path);
  const copy = new DatabaseSync(path);
  // Only the disposable copy loses its copied process lease.
  try { copy.exec("DELETE FROM app_lease"); } finally { copy.close(); }
  candidate = await AppDatabase.open(path, { masterKey });
  const db = candidate;
  const cipher = new RuntimeSecretCipher(masterKey, db.instanceId());
  const pairs = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const platformKey = pairs.publicKey.export({ type: "spki", format: "pem" }).toString();
  const apiV3Key = randomBytes(32).toString("base64url").slice(0, 32);
  const merchants = db.read(sql => sql.prepare("SELECT merchant_id,client_id FROM epay_site_bindings ORDER BY merchant_id").all());
  assert.ok(merchants.length >= 2);
  const balancesBefore = db.read(sql => merchants.map(row => readLiveBalance(sql, Number(row.merchant_id))));
  const auditBefore = db.read(auditConfirmedPayments);
  const expected: Array<{ tradeNo: string; merchantId: number; provider: "alipay" | "wxpay" }> = [];
  const now = Date.now();
  let clock = now + 100;
  db.write(sql => {
    for (const merchant of merchants) {
      const site = sql.prepare("SELECT configuration FROM sites WHERE client_id=?").get(merchant.client_id!)!;
      sql.prepare("UPDATE sites SET configuration=?,revision=revision+1,updated_at=? WHERE client_id=?")
        .run(JSON.stringify({ ...JSON.parse(String(site.configuration)), accepting_orders: true }), now, merchant.client_id!);
    }
  });
  function prepare(merchantId: number, provider: "alipay" | "wxpay") {
    const tradeNo = randomUUID().replaceAll("-", "");
    db.write(sql => {
      sql.prepare(`INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,type_code,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at)
        VALUES(?,?,?,?,'隔离资金回滚演练',101,'https://example.test/perpay-rehearsal','PENDING','PENDING',0,?,?)`).run(tradeNo, `rollback-${tradeNo}`, merchantId, provider, now, now);
      if (provider === "alipay") sql.prepare("INSERT INTO epay_alipay_intents VALUES(?,?,'rehearsal-app','rehearsal-seller',?,101,5,?)").run(tradeNo, merchantId, platformKey, now);
      else {
        const sealed = cipher.encrypt(`epay:config:wechat-intent:${tradeNo}`, 1, apiV3Key);
        sql.prepare("INSERT INTO epay_wechat_intents VALUES(?,?,'rehearsal-app','rehearsal-seller',?,'rehearsal-key',?,?,?,101,5,?)")
          .run(tradeNo, merchantId, platformKey, sealed.nonce, sealed.ciphertext, sealed.authenticationTag, now);
      }
    });
    const order = { tradeNo, merchantId, provider };
    expected.push(order);
    return order;
  }
  function confirm(order: typeof expected[number]) {
    if (order.provider === "alipay") {
      const fields: Record<string, string> = { app_id: "rehearsal-app", seller_id: "rehearsal-seller", out_trade_no: order.tradeNo, trade_no: `provider-${order.tradeNo}`, total_amount: "1.01", trade_status: "TRADE_SUCCESS" };
      const canonical = Object.keys(fields).sort().map(key => `${key}=${fields[key]}`).join("&");
      const signature = sign("RSA-SHA256", Buffer.from(canonical), pairs.privateKey).toString("base64");
      const params = { ...fields, sign_type: "RSA2", sign: signature };
      assert.deepEqual(confirmAlipayPayment(db, params, clock), { duplicate: false });
      assert.deepEqual(confirmAlipayPayment(db, params, clock + 1), { duplicate: true });
      return;
    }
    const nonce = randomBytes(12).toString("hex").slice(0, 12);
    const encrypted = createCipheriv("aes-256-gcm", Buffer.from(apiV3Key), Buffer.from(nonce));
    encrypted.setAAD(Buffer.from("transaction"));
    const transaction = { appid: "rehearsal-app", mchid: "rehearsal-seller", out_trade_no: order.tradeNo, transaction_id: `provider-${order.tradeNo}`, trade_state: "SUCCESS", amount: { total: 101, currency: "CNY" } };
    const ciphertext = Buffer.concat([encrypted.update(JSON.stringify(transaction)), encrypted.final(), encrypted.getAuthTag()]).toString("base64");
    const body = Buffer.from(JSON.stringify({ event_type: "TRANSACTION.SUCCESS", resource: { algorithm: "AEAD_AES_256_GCM", nonce, associated_data: "transaction", ciphertext } }));
    const timestamp = String(Math.floor(clock / 1000));
    const signature = sign("RSA-SHA256", Buffer.concat([Buffer.from(`${timestamp}\nnonce\n`), body, Buffer.from("\n")]), pairs.privateKey).toString("base64");
    const headers = new Headers({ "wechatpay-timestamp": timestamp, "wechatpay-nonce": "nonce", "wechatpay-serial": "rehearsal-key", "wechatpay-signature": signature });
    assert.deepEqual(confirmWechatPayment(db, masterKey, order.tradeNo, body, headers, clock), { duplicate: false });
    assert.deepEqual(confirmWechatPayment(db, masterKey, order.tradeNo, body, headers, clock + 1), { duplicate: true });
  }
  for (const merchant of merchants) for (const provider of ["alipay", "wxpay"] as const) confirm(prepare(Number(merchant.merchant_id), provider));
  const late = [prepare(Number(merchants[0]!.merchant_id), "alipay"), prepare(Number(merchants[0]!.merchant_id), "wxpay")];
  const beforePause = db.read(fingerprint);
  assert.equal(pauseEPayOrders(db, { actorId: "rollback-rehearsal", reason: "保全切换后财务记录" }, clock + 2).pausedSites, merchants.length);
  assert.equal(db.read(fingerprint), beforePause);
  clock += 10;
  for (const order of late) confirm(order);
  const retained = db.read(fingerprint);
  db.close();
  candidate = undefined;
  candidate = await AppDatabase.open(path, { masterKey });
  assert.equal(candidate.read(fingerprint), retained);
  assert.equal(candidate.read(sql => Number(sql.prepare("SELECT count(*) n FROM epay_site_bindings b JOIN sites s ON s.client_id=b.client_id WHERE json_extract(s.configuration,'$.accepting_orders')=1").get()?.n)), 0);
  const recovered = candidate;
  const attempts = new Map<string, number>();
  const processor = new EPayCallbackProcessor({ database: recovered, clock: () => clock, secret: () => "isolated-callback-secret", transport: () => ({ async post(request) {
    const params = Object.fromEntries(new URLSearchParams(request.body.toString()));
    assert.ok(verifyEPaySign(params, "isolated-callback-secret"));
    const order = expected.find(order => order.tradeNo === params.trade_no);
    assert.ok(order);
    assert.equal(params.pid, String(order.merchantId));
    const count = (attempts.get(order.tradeNo) ?? 0) + 1;
    attempts.set(order.tradeNo, count);
    return { status: 200, body: Buffer.from(count === 1 ? "retry" : "success"), contentType: null, contentEncoding: null, responseFingerprint: "", resolvedAddressesFingerprint: "", connectedAddress: "" };
  } }) });
  const policy = { timeoutMilliseconds: 1000, leaseMilliseconds: 2000, maximumAttempts: 3, retryDelayMilliseconds: 10 };
  for (let index = 0; index < expected.length; index++) assert.equal(await processor.processOne(policy), true);
  assert.equal(await processor.processOne(policy), false);
  clock += 20;
  for (let index = 0; index < expected.length; index++) assert.equal(await processor.processOne(policy), true);
  assert.equal(await processor.processOne(policy), false);
  recovered.read(sql => {
    for (const before of balancesBefore) {
      const balance = readLiveBalance(sql, before.merchantId);
      const paid = expected.filter(order => order.merchantId === before.merchantId).length;
      assert.equal(balance.availableCents, before.availableCents + paid * 96);
      assert.equal(balance.version, before.version + paid);
      for (const order of expected.filter(order => order.merchantId === before.merchantId)) {
        assert.equal(sql.prepare("SELECT status FROM epay_orders WHERE trade_no=?").get(order.tradeNo)?.status, "PAID");
        assert.equal(sql.prepare("SELECT status FROM epay_callback_jobs WHERE trade_no=?").get(order.tradeNo)?.status, "SUCCEEDED");
      }
    }
  });
  const audit = recovered.read(auditConfirmedPayments);
  assert.deepEqual(audit, { ...auditBefore, confirmed: auditBefore.confirmed + expected.length });
  source.exec("BEGIN");
  assert.equal(fingerprint(source), productionBefore);
  source.exec("COMMIT");
  const report = { version: 1, verifiedAt: new Date().toISOString(), isolated: true, sourceRoot, merchants: merchants.length, sameAmountOrders: expected.length, verifiedPayments: expected.length, latePaymentsAfterPause: late.length, retries: [...attempts.values()].reduce((sum, count) => sum + count, 0), providerRequests: 0, realCallbackRequests: 0, reopened: true, newFinancialRecordsPreserved: true, oldDatabaseNotRestored: true, productionFinancialRecordsUnchanged: true, confirmationAudit: audit };
  writeFileSync(reportPath, JSON.stringify(report), { flag: "wx", mode: 0o600, flush: true });
  console.log(JSON.stringify(report));
} finally {
  candidate?.close();
  source.close();
  masterKey.fill(0);
  assert.ok(directory.startsWith("/dev/shm/perpay-financial-rollback-"));
  rmSync(directory, { recursive: true, force: true });
}
