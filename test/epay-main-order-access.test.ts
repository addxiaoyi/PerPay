import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { it } from "node:test";
import { mainOrderFixture, mainIdentity, mainInput } from "./epay-main-native-fixture.ts";
import { createMainNativeOrder } from "../src/epay-compat/main-native-order.ts";
import { issueMainOrderAccess, verifyMainOrderAccess } from "../src/epay-compat/main-order-access.ts";
import { requestMainInvoice } from "../src/epay-compat/main-invoice-request.ts";
import { confirmAlipayPayment } from "../src/epay-compat/confirm-alipay.ts";
import { readLiveBalance } from "../src/epay-compat/live-balance.ts";

const NOW = 1_800_000_000_000;

it("binds persistent access tokens to an order, merchant, scope, expiry and revocation", async () => {
  const f = await mainOrderFixture();
  try {
    const order = createMainNativeOrder({ ...f, identity: mainIdentity, input: mainInput, now: NOW });
    const access = f.database.write(sql => issueMainOrderAccess(sql, order.orderId, 1, NOW));
    const verify = (token: string, scope = "order:read", orderId = order.orderId, now = NOW) => f.database.read(sql => verifyMainOrderAccess(sql, token, scope, orderId, now));
    assert.equal(verify(access.order)?.tradeNo, order.tradeNo);
    assert.equal(verify(access.order)?.merchantId, 1);
    assert.equal(verify(access.order, "receipt:read"), null);
    assert.equal(verify(access.invoice, "invoice:create", "wrong-order"), null);
    assert.equal(verify(access.order + "x"), null);
    assert.equal(verify(access.order, "order:read", order.orderId, NOW + 30 * 86_400_000), null);
    const stored = f.database.read(sql => sql.prepare("SELECT * FROM epay_main_order_access").all());
    assert.equal(JSON.stringify(stored, (_, value) => typeof value === "bigint" ? value.toString() : value).includes(access.order), false);
    f.database.write(sql => sql.prepare("UPDATE epay_main_order_access SET revoked_at=? WHERE scope='order:read'").run(NOW));
    assert.equal(verify(access.order), null);
    assert.equal(verify(access.receipt, "receipt:read")?.orderId, order.orderId);
    assert.throws(() => f.database.write(sql => issueMainOrderAccess(sql, order.orderId, 2, NOW)), /order access identity/);
  } finally { f.close(); }
});

it("requires verified payment and posts the invoice fee atomically and only once", async () => {
  const f = await mainOrderFixture();
  try {
    f.database.write(sql => {
      sql.prepare("INSERT INTO epay_balance_openings VALUES(1,'fixture',0,0,0,?,?,?)").run("a".repeat(64), "b".repeat(64), NOW - 1);
      sql.exec("INSERT INTO epay_live_balances VALUES(1,0,0,0)");
    });
    const order = createMainNativeOrder({ ...f, identity: mainIdentity, input: mainInput, now: NOW });
    const access = f.database.write(sql => issueMainOrderAccess(sql, order.orderId, 1, NOW));
    const input = { title: "测试企业", taxId: "91310000123456789A", email: "invoice@example.test" };
    const request = (feeCents = 5, body: unknown = input, token = access.invoice) => requestMainInvoice(f.database, { orderId: order.orderId, token, input: body, feeCents, now: NOW + 10 });
    assert.throws(() => request(), /invoice_not_ready/);
    f.database.write(sql => sql.prepare("UPDATE epay_orders SET status='PAID' WHERE trade_no=?").run(order.tradeNo));
    assert.throws(() => request(), /invoice_not_ready/);
    f.database.write(sql => sql.prepare("UPDATE epay_orders SET status='PENDING' WHERE trade_no=?").run(order.tradeNo));
    const fields = { app_id: "app", seller_id: "seller", out_trade_no: order.tradeNo, trade_no: "fixture-paid", trade_status: "TRADE_SUCCESS", total_amount: "1.01" };
    const content = Object.keys(fields).sort().map(key => `${key}=${fields[key as keyof typeof fields]}`).join("&");
    confirmAlipayPayment(f.database, { ...fields, sign_type: "RSA2", sign: sign("RSA-SHA256", Buffer.from(content), f.platform.privateKey).toString("base64") }, NOW + 1);
    assert.throws(() => request(97), /invoice_fee_insufficient_balance/);
    assert.throws(() => request(5, input, access.order), /invoice_access_denied/);
    assert.throws(() => request(5, { ...input, feeCents: 0 }), /invoice_validation_error/);
    f.database.write(sql => sql.exec("CREATE TRIGGER fail_invoice_fee BEFORE INSERT ON epay_balance_ledger WHEN NEW.entry_type='invoice_fee' BEGIN SELECT RAISE(ABORT,'injected invoice failure'); END"));
    assert.throws(() => request(), /injected invoice failure/);
    assert.equal(f.database.read(sql => sql.prepare("SELECT count(*) n FROM epay_invoice_applications").get()?.n), 0n);
    assert.equal(f.database.read(sql => readLiveBalance(sql, 1)).availableCents, 96);
    f.database.write(sql => sql.exec("DROP TRIGGER fail_invoice_fee"));
    const first = request();
    assert.equal(first.duplicate, false);
    assert.equal(first.application.orderId, order.orderId);
    assert.equal(first.balance.availableCents, 91);
    assert.equal(request().duplicate, true);
    assert.throws(() => request(5, { ...input, title: "另一家公司" }), /invoice_already_requested/);
    assert.equal(f.database.read(sql => readLiveBalance(sql, 1)).availableCents, 91);
    assert.equal(f.database.read(sql => sql.prepare("SELECT count(*) n FROM epay_balance_ledger WHERE entry_type='invoice_fee'").get()?.n), 1n);
  } finally { f.close(); }
});
