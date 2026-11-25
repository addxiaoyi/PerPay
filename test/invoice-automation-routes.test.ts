import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import { it } from "node:test";
import { Hono } from "hono";
import { createInvoiceAutomationRoutes } from "../src/invoices/automation-routes.ts";
import { createInvoiceService } from "../src/invoices/service.ts";
import { createIsolatedGatewayRuntime } from "../src/epay-compat/isolated-gateway-runtime.ts";
import type { InvoiceObservation, InvoiceProvider, PublicInvoice } from "../src/invoices/model.ts";
import { balanceFixture } from "./epay-live-balance-fixture.ts";

const NOW = 1_800_000_000_000;
const SECRET = "synthetic-merchant-secret-for-hmac";
const BRIDGE = "synthetic-loopback-bridge-secret";
const ROOT = "/automation";
const profile = { expectedVersion: 0, subMchId: "1900000100", sellerName: "Synthetic seller", sellerTaxId: "91310000123456789A",
  billingPersonId: "synthetic-biller", itemName: "Software service", taxCode: "3040201000000000000", taxRateBps: 600, enabled: true };
const application = { requestId: "invoice-request-001", tradeNo: "native", buyerType: "ORGANIZATION", title: "Synthetic buyer", taxId: "91310000987654321B", email: "invoice@example.test" };
const createCommand = { operation: "starpay.invoice.create.v1", merchantId: "main-1", application };
const sign = (raw: string, timestamp: string) => `sha256=${createHmac("sha256", SECRET).update(`${timestamp}\n${raw}`).digest("hex")}`;

async function fixture() {
  const f = await balanceFixture();
  let enabled = true, outcome: InvoiceObservation = { status: "PROCESSING" };
  let issueCalls = 0, queryCalls = 0, bridgeCalls = 0;
  const provider: InvoiceProvider = {
    authorize: async () => ({ authorized: true, subMchId: profile.subMchId, billingPersonIds: [profile.billingPersonId] }),
    issue: async () => { issueCalls++; return outcome; },
    query: async () => { queryCalls++; return outcome; },
    download: async () => ({ downloadUrl: "https://invoice.example.test/invoice.pdf" }),
    invite: async () => { throw new Error("automation routes must never invite"); },
  };
  const send: typeof fetch = async (input, init) => {
    bridgeCalls++;
    assert.equal(new URL(String(input)).href, "http://127.0.0.1:8787/api/internal/payment/merchant-auth");
    assert.equal(new Headers(init?.headers).get("x-lightpay-bridge"), BRIDGE);
    const request = JSON.parse(String(init?.body)) as { apiId: string; timestamp: string; signature: string; raw: string };
    const expected = Buffer.from(sign(request.raw, request.timestamp));
    const actual = Buffer.from(request.signature);
    if (!["api-1", "api-2"].includes(request.apiId) || expected.length !== actual.length || !timingSafeEqual(expected, actual))
      return Response.json({ ok: false }, { status: 401 });
    return Response.json({ ok: true, merchantId: request.apiId === "api-1" ? "main-1" : "main-2", callbackSecret: SECRET, callbackUrl: "https://merchant.example.test/notify" });
  };
  f.db.write(sql => {
    sql.exec(`INSERT INTO epay_balance_openings VALUES(1,'fixture',0,0,0,'${"a".repeat(64)}','${"b".repeat(64)}',0);
      INSERT INTO epay_live_balances VALUES(1,0,0,0);
      INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at)
      VALUES('native','external-native',1,'software service',1000,1000,'https://merchant.example.test/notify','PAID','PENDING',0,0,0)`);
    const sealed = f.cipher.encrypt("epay:config:wechat-intent:native", 1, "x".repeat(32));
    sql.prepare("INSERT INTO epay_wechat_intents VALUES('native',1,'app',?,'fixture-platform-key','platform',?,?,?,1000,50,0)")
      .run(profile.subMchId, sealed.nonce, sealed.ciphertext, sealed.authenticationTag);
    sql.exec("UPDATE epay_orders SET type_code='wxpay',get_money_cents=1000,api_trade_no='transaction' WHERE trade_no='native'; INSERT INTO epay_wechat_confirmations VALUES('native','transaction',1,1000,50,0)");
    sql.exec("INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,frozen_delta_cents,occurred_at,source) VALUES('epay_payment:native',1,'payment_paid',950,0,0,'perpay_epay')");
  });
  const service = createInvoiceService({ database: f.db, provider, clock: () => NOW });
  await service.saveProfile({ merchantId: "main-1", mainApiId: "api-1", epayMerchantId: 1, role: "admin", userId: "admin" }, profile);
  const options = { database: f.db, masterKey: f.key, identityOrigin: "http://127.0.0.1:8787", publicOrigin: "https://gateway.example.test",
    bridgeSecret: BRIDGE, send, clock: () => NOW, enabled: () => enabled, provider };
  const app = new Hono().route(ROOT, createInvoiceAutomationRoutes(options));
  const headers = (raw: string, timestamp = String(NOW / 1000), apiId = "api-1") => ({ "content-type": "application/json",
    "x-lightpay-api-id": apiId, "x-lightpay-timestamp": timestamp, "x-lightpay-signature": sign(raw, timestamp) });
  const post = (path: string, command: unknown, timestamp?: string, apiId?: string) => {
    const raw = JSON.stringify(command);
    return app.request(`${ROOT}/${path}`, { method: "POST", headers: headers(raw, timestamp, apiId), body: raw });
  };
  return { ...f, app, options, headers, post, enabled: (value: boolean) => { enabled = value; }, outcome: (value: InvoiceObservation) => { outcome = value; },
    calls: () => ({ issueCalls, queryCalls, bridgeCalls }) };
}

async function invoice(response: Response): Promise<PublicInvoice> {
  return (await response.json() as { data: { invoice: PublicInvoice } }).data.invoice;
}

it("requires merchant HMAC and rejects cookie fallback, expired signatures and body tampering", async () => {
  const f = await fixture();
  try {
    const raw = JSON.stringify(createCommand);
    assert.equal((await f.app.request(`${ROOT}/applications`, { method: "POST", headers: { "content-type": "application/json", cookie: "owner", origin: "https://gateway.example.test" }, body: raw })).status, 401);
    assert.equal((await f.post("applications", createCommand, String(NOW / 1000 - 301))).status, 401);
    assert.equal((await f.post("applications", createCommand, String(NOW / 1000 + 301))).status, 401);
    assert.equal(f.calls().bridgeCalls, 0);
    assert.equal((await f.app.request(`${ROOT}/applications`, { method: "POST", headers: f.headers(raw), body: raw.replace("Synthetic buyer", "Forged buyer") })).status, 401);
    assert.equal(f.calls().issueCalls, 0);
  } finally { f.close(); }
});

it("binds signed operation and merchant scope and rejects extra or malformed fields", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.post("applications", { ...createCommand, operation: "starpay.payment.create.v1" })).status, 400);
    assert.equal((await f.post("query", createCommand)).status, 400);
    assert.equal((await f.post("applications", { ...createCommand, merchantId: "main-2" })).status, 403);
    assert.equal((await f.post("applications", { ...createCommand, sellerTaxId: "forged" })).status, 400);
    assert.equal((await f.post("applications", { ...createCommand, application: { ...application, amountCents: 1 } })).status, 400);
    assert.equal((await f.post("applications", { ...createCommand, application: { ...application, buyerType: "INDIVIDUAL" } })).status, 400);
    const badUtf8 = new Uint8Array([0xff, 0xfe]);
    assert.equal((await f.app.request(`${ROOT}/applications`, { method: "POST", headers: f.headers("{}"), body: badUtf8 })).status, 400);
    const duplicate = JSON.stringify(createCommand).replace('"merchantId":"main-1"', '"merchantId":"main-1","merchantId":"main-2"');
    assert.equal((await f.app.request(`${ROOT}/applications`, { method: "POST", headers: f.headers(duplicate), body: duplicate })).status, 400);
    const oversized = JSON.stringify({ ...createCommand, padding: "x".repeat(8192) });
    assert.equal((await f.app.request(`${ROOT}/applications`, { method: "POST", headers: f.headers(oversized), body: oversized })).status, 400);
    const raw = JSON.stringify(createCommand);
    assert.equal((await f.app.request(`${ROOT}/applications?merchantId=main-2`, { method: "POST", headers: f.headers(raw), body: raw })).status, 403);
    assert.equal(f.calls().issueCalls, 0);
  } finally { f.close(); }
});

it("stops issuance if the gateway is disabled while merchant authentication is in flight", async () => {
  const f = await fixture();
  try {
    const send: typeof fetch = async (input, init) => {
      const response = await f.options.send(input, init);
      f.enabled(false);
      return response;
    };
    const app = new Hono().route(ROOT, createInvoiceAutomationRoutes({ ...f.options, send }));
    const raw = JSON.stringify(createCommand);
    assert.equal((await app.request(`${ROOT}/applications`, { method: "POST", headers: f.headers(raw), body: raw })).status, 503);
    assert.equal(f.calls().issueCalls, 0);
  } finally { f.close(); }
});

it("does not reserve or issue after shutdown while provider authorization is in flight", async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const authorize = f.options.provider.authorize;
  f.options.provider.authorize = async profile => { entered(); await waiting; return authorize(profile); };
  try {
    const request = f.post("applications", createCommand);
    await started;
    f.enabled(false);
    release();
    const response = await request;
    assert.equal(response.status, 503);
    assert.equal((await response.json() as { code: string }).code, "invoice_disabled");
    assert.equal(f.calls().issueCalls, 0);
    assert.equal(f.db.read(sql => sql.prepare("SELECT count(*) n FROM epay_tax_invoice_requests").get()?.n), 0n);
  } finally { release(); f.close(); }
});

it("drains an invoice submission already in flight before quiescing and rejects later submissions", async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const issue = f.options.provider.issue;
  f.options.provider.issue = async request => { entered(); await waiting; return issue(request); };
  const channel = new Hono();
  const runtime = createIsolatedGatewayRuntime({ database: f.db, masterKey: f.key,
    gateway: { wechat: channel, alipay: channel, wechatCallback: channel, alipayCallback: channel },
    scheduler: { policy: { timeoutMilliseconds: 1000, leaseMilliseconds: 2000, maximumAttempts: 2, retryDelayMilliseconds: 10 },
      intervalMilliseconds: 60_000, maximumPerRun: 1, onError: () => assert.fail("unexpected scheduler error") },
    transport: () => { throw new Error("unexpected payment callback"); } });
  runtime.app.route("/tax-invoices", createInvoiceAutomationRoutes({ ...f.options, enabled: () => runtime.admission().acceptingOrders }));
  try {
    const raw = JSON.stringify(createCommand);
    const pending = runtime.app.request("/tax-invoices/applications", { method: "POST", headers: f.headers(raw), body: raw });
    await started;
    let drained = false;
    const quiescing = runtime.quiesceOrders().then(() => { drained = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(drained, false);
    assert.equal((await runtime.app.request("/tax-invoices/applications", { method: "POST", headers: f.headers(raw), body: raw })).status, 503);
    release();
    assert.equal((await pending).status, 202);
    await quiescing;
    assert.equal(drained, true);
    assert.equal(f.calls().issueCalls, 1);
  } finally { release(); await runtime.close(); f.close(); }
});

it("does not treat invoice queries or file lookups as new orders during quiescence", async () => {
  const f = await fixture(), channel = new Hono();
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const runtime = createIsolatedGatewayRuntime({ database: f.db, masterKey: f.key,
    gateway: { wechat: channel, alipay: channel, wechatCallback: channel, alipayCallback: channel },
    scheduler: { policy: { timeoutMilliseconds: 1000, leaseMilliseconds: 2000, maximumAttempts: 2, retryDelayMilliseconds: 10 },
      intervalMilliseconds: 60_000, maximumPerRun: 1, onError: () => assert.fail("unexpected scheduler error") },
    transport: () => { throw new Error("unexpected payment callback"); } });
  for (const path of ["/query", "/files"]) runtime.app.post(`/tax-invoices${path}`, async context => { await waiting; return context.text("completed"); });
  try {
    const queries = ["/query", "/files"].map(path => runtime.app.request(`/tax-invoices${path}`, { method: "POST" }));
    let drained = false;
    const quiescing = runtime.quiesceOrders().then(() => { drained = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(drained, true);
    const afterQuiesce = runtime.app.request("/tax-invoices/query", { method: "POST" });
    release();
    for (const response of await Promise.all([...queries, afterQuiesce])) assert.equal(response.status, 200);
    await quiescing;
  } finally { release(); await runtime.close(); f.close(); }
});

it("submits once, reads locally and never resubmits an unknown result", async () => {
  const f = await fixture();
  try {
    f.outcome({ status: "UNKNOWN" });
    const response = await f.post("applications", createCommand);
    assert.equal(response.status, 202);
    const first = await invoice(response);
    assert.equal((await invoice(await f.post("applications", createCommand))).id, first.id);
    assert.equal(f.calls().issueCalls, 1);
    const query = { operation: "starpay.invoice.query.v1", merchantId: "main-1", invoiceId: first.id };
    assert.equal((await invoice(await f.post("query", query))).status, "UNKNOWN");
    assert.equal(f.calls().queryCalls, 0);
    assert.equal((await f.post("applications", { ...createCommand, application: { ...application, requestId: "invoice-request-002" } })).status, 409);
    assert.equal((await f.post("query", { ...query, merchantId: "main-2" }, undefined, "api-2")).status, 404);
    assert.equal(f.calls().issueCalls, 1);
    const audit = f.db.read(sql => sql.prepare("SELECT requested_by FROM epay_tax_invoice_requests WHERE invoice_id=?").get(first.id));
    assert.equal(audit?.requested_by, "api:api-1");
  } finally { f.close(); }
});

it("fails closed when disabled or unconfigured and never exposes configuration mutations", async () => {
  const f = await fixture();
  try {
    f.enabled(false);
    assert.equal((await f.post("applications", createCommand)).status, 503);
    const { provider: _provider, ...unconfigured } = f.options;
    const app = new Hono().route(ROOT, createInvoiceAutomationRoutes({ ...unconfigured, enabled: true }));
    const raw = JSON.stringify(createCommand);
    assert.equal((await app.request(`${ROOT}/applications`, { method: "POST", headers: f.headers(raw), body: raw })).status, 503);
    for (const path of ["profile", "authorization", "invite"]) assert.equal((await f.post(path, {})).status, 404);
    assert.equal(f.calls().issueCalls, 0);
  } finally { f.close(); }
});

it("rechecks issued state before providing a merchant-scoped download URL", async () => {
  const f = await fixture();
  try {
    f.outcome({ status: "ISSUED", invoiceNo: "12345678901234567890" });
    const first = await invoice(await f.post("applications", createCommand));
    const command = { operation: "starpay.invoice.files.v1", merchantId: "main-1", invoiceId: first.id };
    const response = await f.post("files", command);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { data: { url: string } }).data.url, "https://invoice.example.test/invoice.pdf");
    assert.equal(f.calls().queryCalls, 1);
    assert.equal((await f.post("files", { ...command, merchantId: "main-2" }, undefined, "api-2")).status, 404);
    assert.equal(f.calls().queryCalls, 1);
  } finally { f.close(); }
});
