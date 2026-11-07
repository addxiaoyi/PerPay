import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { it } from "node:test";
import { Hono } from "hono";
import { mainOrderFixture, mainIdentity, mainInput } from "./epay-main-native-fixture.ts";
import { createMainOrderRoutes } from "../src/epay-compat/main-order-routes.ts";
import { createIsolatedGatewayRuntime } from "../src/epay-compat/isolated-gateway-runtime.ts";
import { mountEPayGateway } from "../src/epay-compat/gateway-runtime.ts";
import { verifyEPaySign } from "../src/epay-compat/sign.ts";
import { createMainNativeOrder } from "../src/epay-compat/main-native-order.ts";
import { issueCheckoutToken } from "../src/epay-compat/isolated-checkout-status.ts";

it("keeps HMAC raw bytes, cookie permissions, maintenance and order idempotency on the real route", async () => {
  const f = await mainOrderFixture(), now = 1_800_000_000_000;
  const bridgeSecret = "fixture-bridge-only", timestamp = String(now / 1000);
  let sends = 0, authenticationCalls = 0;
  const send: typeof fetch = async (target, init) => {
    authenticationCalls++;
    const url = new URL(String(target)), headers = new Headers(init?.headers);
    assert.equal(url.origin, "http://127.0.0.1:8787");
    assert.equal(init?.redirect, "error");
    if (url.pathname.startsWith("/api/payment/")) {
      assert.equal(headers.has("cookie"), false);
      return Response.json({ ok: true, path: url.pathname, token: url.searchParams.get("token") });
    }
    if (url.pathname.endsWith("merchant-auth")) {
      assert.equal(headers.get("x-lightpay-bridge"), bridgeSecret);
      const auth = JSON.parse(String(init?.body));
      const signature = `sha256=${createHmac("sha256", mainIdentity.callbackSecret).update(`${auth.timestamp}\n${auth.raw}`).digest("hex")}`;
      if (auth.apiId !== mainIdentity.apiId || auth.signature !== signature || auth.timestamp !== timestamp) return Response.json({ ok: false }, { status: 401 });
      return Response.json({ ok: true, merchantId: mainIdentity.merchantId, callbackUrl: mainIdentity.callbackUrl, callbackSecret: mainIdentity.callbackSecret });
    }
    if (headers.get("cookie") !== "session=owner") return Response.json({ ok: false }, { status: 401 });
    if (url.searchParams.get("merchantId") === "main-2") return Response.json({ ok: false }, { status: 403 });
    if (url.pathname.endsWith("/keys")) return Response.json({ ok: true, apiId: mainIdentity.apiId, apiSecret: mainIdentity.callbackSecret });
    if (url.pathname.endsWith("/profile")) return Response.json({ ok: true, merchant: { id: mainIdentity.merchantId, apiId: mainIdentity.apiId, enabled: true, callbackUrl: mainIdentity.callbackUrl } });
    assert.equal(url.pathname, "/api/merchant/access");
    return Response.json({ ok: true, merchantId: mainIdentity.merchantId, apiId: mainIdentity.apiId, role: "owner", userId: "owner" });
  };
  const channel = new Hono().post("/mapi.php", async context => {
    sends++;
    const params = Object.fromEntries(new URLSearchParams(await context.req.text()));
    assert.equal(verifyEPaySign(params, "epay-key-1"), true);
    const row = f.database.read(sql => sql.prepare("SELECT n.trade_no FROM epay_main_native_orders n JOIN epay_orders o ON o.trade_no=n.trade_no WHERE o.out_trade_no=?").get(params.out_trade_no!));
    assert.ok(row, "callback identity must exist before provider submission");
    const tradeNo = String(row.trade_no), sealed = f.cipher.encrypt(`epay:config:alipay-prepay:${tradeNo}`, 1, "https://qr.alipay.com/fixture");
    f.database.write(sql => {
      const attempt = "00000000-0000-4000-8000-000000000009";
      sql.prepare("INSERT OR IGNORE INTO epay_alipay_submissions VALUES (?,?,'UNCERTAIN',NULL,NULL,?,?)").run(tradeNo, attempt, now, now);
      sql.prepare("INSERT OR IGNORE INTO epay_alipay_prepay VALUES (?,?,?,?,?,?)").run(tradeNo, attempt, sealed.nonce, sealed.ciphertext, sealed.authenticationTag, now);
    });
    return context.json({ code: 1, trade_no: tradeNo, qrcode: "https://qr.alipay.com/fixture" });
  });
  const app = createMainOrderRoutes({ ...f, identityOrigin: "http://127.0.0.1:8787", publicOrigin: "https://gateway.example", basePath: "/pay", bridgeSecret, send, clock: () => now, alipay: channel, wechat: channel, onError: code => { throw new Error(code); } });
  const raw = JSON.stringify(mainInput, null, 2), headers = { "content-type": "application/json", "x-lightpay-api-id": mainIdentity.apiId, "x-lightpay-timestamp": timestamp, "x-lightpay-signature": `sha256=${createHmac("sha256", mainIdentity.callbackSecret).update(`${timestamp}\n${raw}`).digest("hex")}` };
  try {
    assert.equal((await app.request("/orders", { method: "POST", headers, body: raw.replace("1.01", "1.02") })).status, 401);
    assert.equal((await app.request("/orders?merchantId=main-2", { method: "POST", headers, body: raw })).status, 403);
    assert.equal((await app.request("/orders", { method: "POST", headers: { cookie: "session=owner", origin: "https://evil.example", "content-type": "application/json" }, body: raw })).status, 403);
    assert.equal(sends, 0);
    const response = await app.request("/orders", { method: "POST", headers, body: raw });
    assert.equal(response.status, 201, await response.clone().text());
    const first = await response.json() as { order: { id: string; status: string; amountCents: number }; checkoutUrl: string; checkoutToken: string; access: { order: string; receipt: string; invoice: string }; duplicate: boolean };
    assert.equal(first.order.status, "pending_payment");
    assert.equal(first.order.amountCents, 101);
    assert.deepEqual(Object.keys(first.access).sort(), ["invoice", "order", "receipt"]);
    assert.equal(first.duplicate, false);
    const listing = await app.request("/orders?merchantId=main-1&search=external-001", { headers: { cookie: "session=owner" } });
    assert.equal(listing.status, 200);
    const listed = await listing.json() as { orders: Array<{ id: string }> };
    assert.deepEqual(listed.orders.map(order => order.id), [first.order.id]);
    const defaultListing = await app.request("/orders?search=external-001", { headers: { cookie: "session=owner" } });
    assert.equal(defaultListing.status, 200);
    assert.deepEqual((await defaultListing.json() as { orders: Array<{ id: string }> }).orders.map(order => order.id), [first.order.id]);
    assert.equal((await app.request("/orders?merchantId=main-2", { headers: { cookie: "session=owner" } })).status, 403);
    assert.equal((await app.request("/orders?merchantId=main-1")).status, 401);
    const invoiceCount = () => f.database.read(sql => Number(sql.prepare("SELECT count(*) n FROM epay_invoice_applications").get()?.n));
    const invoiceBefore = invoiceCount(), callsBefore = authenticationCalls;
    for (const id of [first.order.id, "00000000-0000-4000-8000-000000000001"]) {
      const rejected = await app.request(`/payment/invoice/${id}`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "测试抬头", taxId: "synthetic", email: "invoice@example.test", token: first.access.invoice }) });
      assert.equal(rejected.status, 503);
      assert.equal((await rejected.json() as { code: string }).code, "invoice_maintenance");
    }
    assert.equal(invoiceCount(), invoiceBefore);
    assert.equal(authenticationCalls, callsBefore, "disabled invoices must not reach the legacy issuer");
    assert.equal(JSON.stringify(first).includes(mainIdentity.callbackSecret), false);
    const repeat = await app.request("/orders", { method: "POST", headers: { cookie: "session=owner", origin: "https://gateway.example", "content-type": "application/json" }, body: raw });
    assert.equal(repeat.status, 200);
    const second = await repeat.json() as typeof first;
    assert.equal(second.order.id, first.order.id);
    assert.equal(second.duplicate, true);
    assert.notEqual(second.access.order, first.access.order);
    const orderAccess = await app.request(`/payment/order/${first.order.id}?token=${first.access.order}`);
    assert.equal(orderAccess.status, 200, await orderAccess.clone().text());
    assert.deepEqual((await orderAccess.json() as { order: { id: string; amount: string } }).order, {
      id: first.order.id, merchantOrderId: mainInput.merchantOrderId, subject: mainInput.subject, channel: mainInput.channel,
      amount: "1.01", status: "pending_payment", tradeNo: null, paidAt: null,
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 15 * 60_000).toISOString(),
    });
    assert.equal((await app.request(`/payment/order/${first.order.id}?token=${first.access.receipt}`)).status, 404);
    assert.equal((await app.request(`/payment/receipt/${first.order.id}?token=${first.access.receipt}`)).status, 409);
    const invoiceMaintenance = await app.request(`/payment/invoice/${first.order.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: first.access.invoice, title: "Fixture", taxId: "123", email: "invoice@example.test" }) });
    assert.equal(invoiceMaintenance.status, 503);
    assert.equal((await invoiceMaintenance.json() as { code: string }).code, "invoice_maintenance");
    const legacyId = randomUUID();
    assert.deepEqual(await (await app.request(`/payment/order/${legacyId}?token=legacy-token`)).json(), {
      ok: true, path: `/api/payment/order/${legacyId}`, token: "legacy-token",
    });
    const checkout = await app.request(`/checkout/${first.order.id}?token=${first.checkoutToken}`);
    assert.equal(checkout.status, 200);
    assert.match(await checkout.text(), /\/pay\/epay\/checkout-status/);
    assert.equal((await app.request(`/checkout/wrong?token=${first.checkoutToken}`)).status, 404);
    assert.equal((await app.request(`/checkout/${first.order.id}?token=forged`)).status, 404);
    const pending = createMainNativeOrder({ ...f, identity: mainIdentity, input: { ...mainInput, merchantOrderId: "no-channel-response" }, now });
    const pendingToken = issueCheckoutToken(f.masterKey, f.database.instanceId(), pending.tradeNo, 1, now);
    const waiting = await app.request(`/checkout/${pending.orderId}?token=${pendingToken}`);
    assert.equal(waiting.status, 202);
    assert.match(waiting.headers.get("content-type") ?? "", /text\/html/);
    const waitingHtml = await waiting.text();
    assert.match(waitingHtml, /StarPAY/); assert.match(waitingHtml, /暂未获取到收款信息/);
    assert.doesNotMatch(waitingHtml, /merchantNetCents|callbackAttempts|"ok":true/);
    const expiredApp = createMainOrderRoutes({ ...f, identityOrigin: "http://127.0.0.1:8787", publicOrigin: "https://gateway.example", basePath: "/pay", bridgeSecret, send, clock: () => now + 16 * 60000, alipay: channel, wechat: channel, onError: assert.fail });
    assert.match(await (await expiredApp.request(`/checkout/${pending.orderId}?token=${pendingToken}`)).text(), /订单已过期/);
    const countBefore = f.database.read(sql => Number(sql.prepare("SELECT count(*) n FROM epay_orders").get()?.n));
    const webOnly = createMainOrderRoutes({ ...f, identityOrigin: "http://127.0.0.1:8787", publicOrigin: "https://gateway.example", basePath: "/pay", bridgeSecret, send, clock: () => now, alipay: channel, wechat: channel, alipayScanEnabled: false, onError: assert.fail });
    const unavailable = await webOnly.request("/orders", { method: "POST", headers, body: raw });
    assert.equal(unavailable.status, 400); assert.equal((await unavailable.json() as { code: string }).code, "channel_unavailable");
    assert.equal(f.database.read(sql => Number(sql.prepare("SELECT count(*) n FROM epay_orders").get()?.n)), countBefore);
    const before = authenticationCalls;
    const runtime = createIsolatedGatewayRuntime({ ...f, gateway: { alipay: channel, wechat: channel, alipayCallback: new Hono(), wechatCallback: new Hono() }, mainOrders: app, admitOrder: () => false,
      transport: () => { throw new Error("unexpected callback"); }, scheduler: { intervalMilliseconds: 1000, maximumPerRun: 1, policy: { timeoutMilliseconds: 1000, leaseMilliseconds: 2000, maximumAttempts: 3, retryDelayMilliseconds: 10 }, onError: () => { throw new Error("unexpected schedule"); } } });
    const publicApp = new Hono().basePath("/pay");
    mountEPayGateway(publicApp, runtime, "/pay");
    const publicOrder = await publicApp.request(`/pay/api/payment/order/${first.order.id}?token=${first.access.order}`);
    assert.equal(publicOrder.status, 200, await publicOrder.clone().text());
    assert.equal((await publicOrder.json() as { order: { id: string } }).order.id, first.order.id);
    assert.equal((await runtime.app.request("/main/orders", { method: "POST", headers, body: raw })).status, 503);
    assert.equal(authenticationCalls, before);
    await runtime.close();
  } finally { f.close(); }
});
