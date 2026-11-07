import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { it } from "node:test";
import { balanceFixture } from "./epay-live-balance-fixture.ts";
import { accountCertificate } from "./fixtures/alipay-account-certificate.ts";
import { verifyAlipayQueryAccount } from "../src/epay-compat/alipay-query-account.ts";
import { createV3ResponseSignature } from "../src/infrastructure/alipay/v3.ts";
import { processNativeRefund } from "../src/epay-compat/refund-provider.ts";
import { requestRefund, approveRefund, claimRefund, readRefund } from "../src/epay-compat/refund-workflow.ts";
import { readLiveBalance } from "../src/epay-compat/live-balance.ts";
import { registerWechatCredential } from "../src/epay-compat/wechat-credentials.ts";
import { registerWechatSigningKey } from "../src/epay-compat/wechat-signing-keys.ts";
import { EPayRefundScheduler } from "../src/epay-compat/refund-scheduler.ts";

const identity = { merchantId: "main-1", mainApiId: "api-1", epayMerchantId: 1, role: "admin" as const, userId: "admin" };
const appId = "2026000000000000", sellerId = "2088000000000000";
const merchantKey = generateKeyPairSync("rsa", { modulusLength: 2048 }), platformKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = platformKey.publicKey.export({ type: "spki", format: "pem" }).toString();
const merchantPem = merchantKey.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
async function fixture(provider: "alipay" | "wxpay") {
  const f = await balanceFixture(), now = Date.now();
  f.db.write(sql => {
    sql.exec(`INSERT INTO epay_balance_openings VALUES(1,'fixture',0,0,0,'${"a".repeat(64)}','${"b".repeat(64)}',0);
      INSERT INTO epay_live_balances VALUES(1,0,0,0)`);
    sql.prepare(`INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,get_money_cents,api_trade_no,type_code,notify_url,status,notify_status,notify_count,created_at,updated_at)
      VALUES('native','native',1,'fixture',1000,1000,1000,'transaction',?,'https://merchant.example/notify','PAID','PENDING',0,0,0)`).run(provider);
    if (provider === "alipay") sql.prepare("INSERT INTO epay_alipay_intents VALUES('native',1,?,?,?,1000,50,0)").run(appId, sellerId, pem);
    else {
      const secret = f.cipher.encrypt("epay:config:wechat-intent:native", 1, "x".repeat(32));
      sql.prepare("INSERT INTO epay_wechat_intents VALUES('native',1,?,'merchant',?,'platform',?,?,?,1000,50,0)").run(appId, pem, secret.nonce, secret.ciphertext, secret.authenticationTag);
    }
    sql.prepare(`INSERT INTO ${provider === "alipay" ? "epay_alipay_confirmations" : "epay_wechat_confirmations"} VALUES('native','transaction',1,1000,50,0)`).run();
    sql.exec("INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,frozen_delta_cents,occurred_at,source) VALUES('epay_payment:native',1,'payment_paid',950,0,0,'perpay_epay')");
  });
  const request = requestRefund(f.db, identity, { requestId: "request-provider-001", tradeNo: "native", amountCents: 1000, reason: "测试退款" }, now);
  approveRefund(f.db, identity, request.refundNo, now + 1);
  return { ...f, now, refundNo: request.refundNo };
}

it("submits one signed Alipay refund and settles only its verified query after restart", async () => {
  const f = await fixture("alipay"), certificate = accountCertificate(f.directory, merchantPem, sellerId);
  const verifiedAt = Date.now();
  const account = verifyAlipayQueryAccount({ appId, sellerId, privateKey: merchantKey.privateKey, platformPublicKey: pem, ...certificate }, verifiedAt);
  let now = verifiedAt + 2, submits = 0, queries = 0, tamper = true;
  const options = { database: f.db, masterKey: f.key, clock: () => now, alipay: { account, privateKey: merchantKey.privateKey, transport: {
    request: async (request: import("../src/infrastructure/alipay/types.ts").SignedV3Request) => {
      const match = /^ALIPAY-SHA256withRSA (.+),sign=(.+)$/.exec(String(request.headers.authorization));
      assert.ok(match);
      assert.ok(verify("RSA-SHA256", Buffer.from(`${match[1]}\nPOST\n${request.path}\n${request.body}\n`), merchantKey.publicKey, Buffer.from(match[2]!, "base64")));
      const body = JSON.parse(request.body);
      assert.equal(body.out_request_no, f.refundNo);
      assert.equal(body.trade_no, "transaction");
      if (request.path === "/v3/alipay/trade/refund") { submits++; assert.equal(body.refund_amount, "10.00"); }
      else { assert.equal(request.path, "/v3/alipay/trade/fastpay/refund/query"); queries++; }
      const raw = JSON.stringify({ out_request_no: f.refundNo, out_trade_no: "native", trade_no: "transaction",
        refund_status: "REFUND_SUCCESS", refund_amount: tamper && queries ? "10.01" : "10.00", total_amount: "10.00" });
      const timestamp = String(Math.floor(now / 1000));
      return { status: 200, body: Buffer.from(raw), headers: { "alipay-timestamp": timestamp, "alipay-nonce": "fixture", "alipay-signature": createV3ResponseSignature(raw, timestamp, "fixture", platformKey.privateKey) } };
    } } } };
  const errors: string[] = [];
  let scheduler = new EPayRefundScheduler({ database: f.db, clock: () => now, onError: code => errors.push(code), process: lease => processNativeRefund(options, lease) });
  try {
    await scheduler.trigger();
    assert.equal(submits, 1);
    assert.equal(readRefund(f.db, identity, f.refundNo).status, "UNKNOWN");
    assert.equal(f.db.read(sql => readLiveBalance(sql, 1)).frozenCents, 950);
    await scheduler.stop();
    now += 30001;
    scheduler = new EPayRefundScheduler({ database: f.db, clock: () => now, onError: code => errors.push(code), process: lease => processNativeRefund(options, lease) });
    await scheduler.trigger();
    assert.equal(queries, 1);
    assert.equal(readRefund(f.db, identity, f.refundNo).status, "UNKNOWN");
    assert.equal(f.db.read(sql => readLiveBalance(sql, 1)).frozenCents, 950);
    tamper = false; now += 30001;
    await scheduler.trigger();
    assert.equal(submits, 1);
    assert.equal(queries, 2);
    assert.equal(readRefund(f.db, identity, f.refundNo).status, "SUCCEEDED");
    assert.equal(f.db.read(sql => readLiveBalance(sql, 1)).frozenCents, 0);
    assert.deepEqual(errors, ["epay_refund_verification_pending"]);
    await scheduler.trigger(); assert.equal(queries, 2);
  } finally { await scheduler.stop(); f.close(); }
});

it("verifies signed WeChat refund identities, keeps processing frozen, then queries the original refund number", async () => {
  const f = await fixture("wxpay");
  registerWechatCredential(f.db, f.key, { id: "platform", appId, merchantId: "merchant", platformKey: pem, platformKeyId: "platform", apiV3Key: "x".repeat(32), validFrom: f.now, validUntil: f.now + 86400000, actor: "test" }, f.now);
  registerWechatSigningKey(f.db, f.key, { id: "signing", appId, merchantId: "merchant", privateKey: merchantPem,
    publicKey: merchantKey.publicKey.export({ type: "spki", format: "pem" }).toString(), serial: "serial", validFrom: f.now, validUntil: f.now + 86400000, actor: "test" }, f.now);
  let now = f.now + 2, requests = 0;
  const transport: typeof fetch = async (input, init) => {
    requests++;
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.mch.weixin.qq.com"); assert.equal(init?.redirect, "error");
    const auth = /^WECHATPAY2-SHA256-RSA2048 mchid="merchant",nonce_str="([a-f0-9]+)",signature="([^"]+)",timestamp="(\d+)",serial_no="serial"$/.exec(new Headers(init?.headers).get("authorization") ?? "");
    assert.ok(auth);
    assert.ok(verify("RSA-SHA256", Buffer.from(`${init?.method}\n${url.pathname}\n${auth[3]}\n${auth[1]}\n${init?.body ?? ""}\n`), merchantKey.publicKey, Buffer.from(auth[2]!, "base64")));
    if (requests === 1) {
      assert.equal(init?.method, "POST");
      const body = JSON.parse(String(init?.body)); assert.equal(body.transaction_id, "transaction"); assert.equal(body.out_refund_no, f.refundNo);
      assert.deepEqual(body.amount, { refund: 1000, total: 1000, currency: "CNY" });
    } else { assert.equal(init?.method, "GET"); assert.ok(url.pathname.endsWith(`/${f.refundNo}`)); }
    const raw = JSON.stringify({ out_refund_no: f.refundNo, out_trade_no: "native", transaction_id: "transaction", refund_id: "provider-refund",
      status: requests === 1 ? "PROCESSING" : "SUCCESS", amount: { refund: 1000, total: 1000, currency: "CNY" } });
    const timestamp = String(Math.floor(now / 1000));
    return new Response(raw, { headers: { "content-type": "application/json", "wechatpay-timestamp": timestamp, "wechatpay-nonce": "fixture", "wechatpay-serial": "platform",
      "wechatpay-signature": sign("RSA-SHA256", Buffer.from(`${timestamp}\nfixture\n${raw}\n`), platformKey.privateKey).toString("base64") } });
  };
  try {
    await processNativeRefund({ database: f.db, masterKey: f.key, wechat: { signingKeyId: "signing", transport }, clock: () => now }, claimRefund(f.db, now)!);
    assert.equal(readRefund(f.db, identity, f.refundNo).status, "PROCESSING");
    assert.equal(f.db.read(sql => readLiveBalance(sql, 1)).frozenCents, 950);
    now += 30001;
    await processNativeRefund({ database: f.db, masterKey: f.key, wechat: { signingKeyId: "signing", transport }, clock: () => now }, claimRefund(f.db, now)!);
    assert.equal(readRefund(f.db, identity, f.refundNo).status, "SUCCEEDED");
    assert.equal(f.db.read(sql => readLiveBalance(sql, 1)).frozenCents, 0);
    assert.equal(requests, 2);
  } finally { f.close(); }
});
