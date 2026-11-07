import assert from "node:assert/strict";
import { createHmac, sign } from "node:crypto";
import { it } from "node:test";
import { mainOrderFixture, mainIdentity, mainInput } from "./epay-main-native-fixture.ts";
import { createMainNativeOrder } from "../src/epay-compat/main-native-order.ts";
import { confirmAlipayPayment } from "../src/epay-compat/confirm-alipay.ts";
import { readMainCallback } from "../src/epay-compat/main-callback.ts";
import { EPayCallbackProcessor } from "../src/epay-compat/callback-processor.ts";
import { verifyEPaySign } from "../src/epay-compat/sign.ts";
import { createIsolatedCheckoutStatus, issueCheckoutToken } from "../src/epay-compat/isolated-checkout-status.ts";

it("confirms a main order atomically and delivers durable form to HMAC fallback with its original identity", async () => {
  const f = await mainOrderFixture();
  let now = 1_800_000_000_000, calls = 0;
  const policy = { timeoutMilliseconds: 1000, leaseMilliseconds: 3000, maximumAttempts: 3, retryDelayMilliseconds: 10 };
  try {
    const created = createMainNativeOrder({ ...f, identity: mainIdentity, input: { ...mainInput, returnUrl: "https://merchant.example/return" }, now });
    const fields = { app_id: "app", seller_id: "seller", out_trade_no: created.tradeNo, trade_no: "provider-verified", trade_status: "TRADE_SUCCESS", total_amount: "1.01" };
    const content = Object.keys(fields).sort().map(key => `${key}=${fields[key as keyof typeof fields]}`).join("&");
    const evidence = { ...fields, sign_type: "RSA2", sign: sign("RSA-SHA256", Buffer.from(content), f.platform.privateKey).toString("base64") };
    const fingerprint = () => f.database.read(sql => ({
      orders: sql.prepare("SELECT status FROM epay_orders WHERE trade_no=?").get(created.tradeNo)?.status,
      proofs: sql.prepare("SELECT count(*) n FROM epay_alipay_confirmations").get()?.n,
      ledger: sql.prepare("SELECT count(*) n FROM epay_balance_ledger").get()?.n,
      jobs: sql.prepare("SELECT count(*) n FROM epay_callback_jobs").get()?.n,
    }));
    const before = fingerprint();
    f.database.write(sql => sql.exec("CREATE TRIGGER injected_outbox_failure BEFORE INSERT ON epay_callback_jobs BEGIN SELECT RAISE(ABORT,'injected queue failure'); END"));
    assert.throws(() => confirmAlipayPayment(f.database, evidence, now), /injected/);
    assert.deepEqual(fingerprint(), before);
    f.database.write(sql => sql.exec("DROP TRIGGER injected_outbox_failure"));
    assert.deepEqual(confirmAlipayPayment(f.database, evidence, now), { duplicate: false });
    assert.deepEqual(confirmAlipayPayment(f.database, evidence, now + 1), { duplicate: true });
    assert.deepEqual(fingerprint(), { orders: "PAID", proofs: 1n, ledger: 1n, jobs: 1n });
    const processor = () => new EPayCallbackProcessor({ database: f.database, clock: () => now, secret: () => { throw new Error("EPay signing key must never sign a main callback"); }, mainCallback: order => f.database.read(sql => readMainCallback(sql, f.cipher, order)), transport: () => ({ async post(request) {
      calls++;
      assert.equal(request.targetUrl, mainIdentity.callbackUrl);
      const id = f.database.read(sql => sql.prepare("SELECT callback_id FROM epay_main_native_orders WHERE trade_no=?").get(created.tradeNo)?.callback_id);
      assert.equal(request.headers["x-idempotency-key"], id);
      if (calls === 1) {
        const params = Object.fromEntries(new URLSearchParams(request.body.toString()));
        assert.equal(params.pid, mainIdentity.apiId);
        assert.equal(params.trade_no, fields.trade_no);
        assert.equal(verifyEPaySign(params, mainIdentity.callbackSecret), true);
        assert.equal(request.contentType, "application/x-www-form-urlencoded");
        return { status: 200, body: Buffer.from("JSON required"), contentType: null, contentEncoding: null, responseFingerprint: "", resolvedAddressesFingerprint: "", connectedAddress: "" };
      }
      const body = request.body.toString(), payload = JSON.parse(body);
      assert.equal(request.contentType, "application/json");
      assert.equal(payload.orderId, created.orderId);
      assert.equal(payload.amount, "1.01");
      assert.equal(payload.platformFee, "0.05");
      assert.equal(payload.merchantNet, "0.96");
      assert.equal(payload.pid, mainIdentity.apiId);
      assert.equal(request.headers["x-lightpay-signature"], `sha256=${createHmac("sha256", mainIdentity.callbackSecret).update(`${request.headers["x-lightpay-timestamp"]}\n${body}`).digest("hex")}`);
      return { status: calls === 2 ? 503 : 200, body: Buffer.from("{}"), contentType: null, contentEncoding: null, responseFingerprint: "", resolvedAddressesFingerprint: "", connectedAddress: "" };
    } }) });
    assert.equal(await processor().processOne(policy), true);
    assert.equal(f.database.read(sql => sql.prepare("SELECT next_method FROM epay_callback_jobs").get()?.next_method), "GET");
    now += 10;
    assert.equal(await processor().processOne(policy), true);
    now += 10;
    assert.equal(await processor().processOne(policy), true);
    assert.equal(await processor().processOne(policy), false);
    const attempts = f.database.read(sql => sql.prepare("SELECT wire_format,outcome FROM epay_callback_attempts ORDER BY attempt_number").all());
    assert.deepEqual(attempts.map(row => [row.wire_format, row.outcome]), [["main_form", "RETRY"], ["main_json", "RETRY"], ["main_json", "SUCCESS"]]);
    assert.equal(f.database.read(sql => sql.prepare("SELECT available_delta_cents FROM epay_balance_ledger").get()?.available_delta_cents), 96n);
    const status = createIsolatedCheckoutStatus(f.database, f.masterKey, () => now);
    const response = await status.request("/checkout-status", { headers: { "x-checkout-token": issueCheckoutToken(f.masterKey, f.database.instanceId(), created.tradeNo, 1, now) } });
    const returned = await response.json() as { returnUrl: string; status: string };
    assert.equal(returned.status, "paid");
    const params = Object.fromEntries(new URL(returned.returnUrl).searchParams);
    assert.equal(params.pid, mainIdentity.apiId);
    assert.equal(verifyEPaySign(params, mainIdentity.callbackSecret), true);
  } finally { f.close(); }
});
