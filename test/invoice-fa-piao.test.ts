import assert from "node:assert/strict";
import { it } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { DatabaseSync } from "node:sqlite";
import { FA_PIAO_SCHEMA_SQL, TAX_INVOICE_SCHEMA_SQL } from "../src/invoices/schema.ts";
import { createFaPiaoClient, faPiaoSignature, FaPiaoError, type FaPiaoCredentials } from "../src/invoices/fa-piao-client.ts";
import { createFaPiaoInvoiceProvider, invoiceAmounts } from "../src/invoices/fa-piao-provider.ts";
import { createInvoiceRuntime } from "../src/invoices/runtime.ts";
import { createInvoiceService } from "../src/invoices/service.ts";
import { createInvoiceRoutes } from "../src/invoices/routes.ts";
import { createInvoiceAutomationRoutes } from "../src/invoices/automation-routes.ts";
import { loadConfig } from "../src/config.ts";
import type { InvoiceIssue } from "../src/invoices/model.ts";
import { balanceFixture } from "./epay-live-balance-fixture.ts";
import { recordSyntheticAlipayConfirmation } from "./epay-payment-fixture.ts";

const credentials: FaPiaoCredentials = {
  appKey: "sample-key", appSecret: "s".repeat(32), accountId: "1000", sellerName: "Synthetic seller",
  sellerTaxId: "91310000123456789A", username: "13900000000", plan: "6",
  sellerAddressPhone: "Synthetic address 01000000000", sellerBankAccount: "Synthetic bank 000000000",
};
const profile = { provider: "fa-piao" as const, subMchId: credentials.accountId, sellerName: credentials.sellerName,
  sellerTaxId: credentials.sellerTaxId, billingPersonId: credentials.username, itemName: "Software service", taxCode: "3040201000000000000", taxRateBps: 600 };
const request: InvoiceIssue = { requestNo: "a".repeat(32), applicationNo: "a".repeat(32), merchantId: 1,
  tradeNo: "paid-native", amountCents: 1000, paymentType: "alipay", providerTradeNo: "synthetic-transaction", profile,
  buyer: { type: "ORGANIZATION", title: "Synthetic buyer", taxId: "91310000987654321B", email: "buyer@example.test" } };
const NUMBER = "22610000000000000001";

function transportFixture() {
  const calls: { path: string; body: Record<string, unknown>; headers: Headers }[] = [];
  let failDetails = false, wrongSeller = false, issueCode = 200;
  const transport: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname, body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ path, body, headers: new Headers(init?.headers) });
    if (path.endsWith("/authorization")) return Response.json({ code: 200, data: { token: "synthetic-token" } });
    if (path.endsWith("/queryFaceAuthState")) return Response.json({ code: 200, data: {} });
    if (path.endsWith("/blueTicket")) return Response.json({ code: issueCode, data: { Fphm: NUMBER } });
    if (path.endsWith("/retMsg")) {
      if (failDetails) throw new Error("synthetic query timeout");
      return Response.json({ code: 200, data: { fphm: NUMBER, xhdwsbh: wrongSeller ? "91310000123456789B" : credentials.sellerTaxId,
        xhdwmc: credentials.sellerName, ghdwmc: request.buyer.title, ghdwsbh: request.buyer.taxId,
        hjje: "9.43", hjse: "0.57", fplxdm: "82", mxzb: [{ spbm: profile.taxCode, sl: "0.06", je: "9.43", se: "0.57" }] } });
    }
    if (path.endsWith("/pdfOfdXml")) return Response.json({ code: 200, data: { pdfUrl: "https://files.fa-piao.com/synthetic.pdf" } });
    throw new Error(`unexpected fixture path: ${path}`);
  };
  return { transport, calls, failDetails: (value: boolean) => { failDetails = value; },
    wrongSeller: () => { wrongSeller = true; }, issueCode: (value: number) => { issueCode = value; } };
}

it("matches the official SDK HMAC signing vector and calculates money without floating-point rounding", () => {
  assert.equal(faPiaoSignature("POST", "/v5/enterprise/authorization", "01234567890123456789", "1795320000", "sample-key", "s".repeat(32)),
    "2E15A61F4C4571F825FEC5959BAED4C63589EBC79F1FBDB2ECCA7FD0C60E7DB6");
  assert.deepEqual(invoiceAmounts(1000, 600), { net: "9.43", tax: "0.57", gross: "10.00", rate: "0.06" });
  assert.deepEqual(invoiceAmounts(1, 600), { net: "0.01", tax: "0.00", gross: "0.01", rate: "0.06" });
  assert.throws(() => invoiceAmounts(Number.MAX_SAFE_INTEGER + 1, 600), /invalid_amount/);
});

it("migrates existing invoice history intact and retains immutable history and refund guards", () => {
  const sql = new DatabaseSync(":memory:");
  try {
    sql.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE epay_merchant_accounts(merchant_id INTEGER PRIMARY KEY);
      CREATE TABLE epay_orders(trade_no TEXT PRIMARY KEY,merchant_id INTEGER,status TEXT,money_cents INTEGER);
      CREATE TABLE epay_native_refunds(trade_no TEXT,status TEXT);
      CREATE TABLE epay_invoices(trade_no TEXT);
      CREATE TABLE epay_invoice_applications(trade_no TEXT);
      INSERT INTO epay_merchant_accounts VALUES(1);
      INSERT INTO epay_orders VALUES('old-order',1,'PAID',1000);`);
    sql.exec(TAX_INVOICE_SCHEMA_SQL);
    sql.prepare("INSERT INTO epay_tax_invoice_profiles VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(1, "1900000001", "Old seller", credentials.sellerTaxId, "old-biller", "service", profile.taxCode, 600, 1, 1, 0, 1, "admin", 0);
    sql.prepare(`INSERT INTO epay_tax_invoice_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run("00000000-0000-4000-8000-000000000001", "b".repeat(32), "b".repeat(32), 1, "old-request-00001", 1,
        "old-order", 1000, "wxpay", "old-transaction", JSON.stringify({ subMchId: "1900000001" }), "INDIVIDUAL", "Old buyer", "", "old@example.test", "admin", "ISSUED", NUMBER, null, 0, 0);
    const before = sql.prepare("SELECT * FROM epay_tax_invoice_requests").get();
    sql.exec(FA_PIAO_SCHEMA_SQL);
    assert.deepEqual(sql.prepare("SELECT * FROM epay_tax_invoice_requests").get(), before);
    assert.equal(sql.prepare("SELECT provider FROM epay_tax_invoice_profiles").get()?.provider, "wechat");
    assert.deepEqual(sql.prepare("PRAGMA foreign_key_check").all(), []);
    assert.throws(() => sql.exec("DELETE FROM epay_tax_invoice_requests"), /immutable/);
    assert.throws(() => sql.exec("INSERT INTO epay_native_refunds VALUES('old-order','PENDING')"), /reconciliation/);
  } finally { sql.close(); }
});

it("keeps the closed issuance gate free of all remote requests", async () => {
  const remote = transportFixture(), receipts = new Map<string, string>();
  const client = createFaPiaoClient({ credentials, allowIssue: false, transport: remote.transport });
  await assert.rejects(() => client.issueBlue({}), error => error instanceof FaPiaoError && error.outcome === "NOT_SUBMITTED");
  const provider = createFaPiaoInvoiceProvider({ credentials, allowIssue: false, transport: remote.transport,
    receipts: { load: key => receipts.get(key), save: (key, value) => { receipts.set(key, value); } } });
  assert.equal((await provider.authorize(profile)).authorized, false);
  await assert.rejects(() => provider.issue(request), /issuance_disabled/);
  assert.equal(remote.calls.length, 0);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(() => client.checkLogin(aborted.signal), /request_aborted/);
  assert.equal(remote.calls.length, 0);
});

it("persists the known invoice number before verification and recovers without issuing twice", async () => {
  const remote = transportFixture(), receipts = new Map<string, string>();
  const provider = createFaPiaoInvoiceProvider({ credentials, allowIssue: true, transport: remote.transport,
    receipts: { load: key => receipts.get(key), save: (key, value) => { receipts.set(key, value); } } });
  remote.failDetails(true);
  await assert.rejects(() => provider.issue(request), /response_unavailable/);
  assert.equal(receipts.get(request.requestNo), NUMBER);
  const issue = remote.calls.find(call => call.path.endsWith("/blueTicket"))!;
  assert.equal(issue.body.fpqqlsh, request.applicationNo);
  assert.equal(issue.body.jshj, "10.00");
  assert.equal(issue.headers.get("authorization"), "synthetic-token");
  remote.failDetails(false);
  assert.deepEqual(await provider.query(request), { status: "ISSUED", invoiceNo: NUMBER });
  await provider.issue(request);
  assert.equal(remote.calls.filter(call => call.path.endsWith("/blueTicket")).length, 1);
  remote.wrongSeller();
  await assert.rejects(() => provider.download(request), /invoice_identity_mismatch/);
  assert.equal(remote.calls.filter(call => call.path.endsWith("/pdfOfdXml")).length, 0);
});

it("never retries an issuance on an expired token and keeps untraceable results unresolved", async () => {
  const remote = transportFixture(), receipts = new Map<string, string>();
  const provider = createFaPiaoInvoiceProvider({ credentials, allowIssue: true, transport: remote.transport,
    receipts: { load: key => receipts.get(key), save: (key, value) => { receipts.set(key, value); } } });
  remote.issueCode(401);
  assert.deepEqual(await provider.issue(request), { status: "UNKNOWN", errorCode: "fapiao_authorization_expired" });
  assert.deepEqual(await provider.query(request), { status: "UNKNOWN", errorCode: "fapiao_reconcile_required" });
  assert.equal(remote.calls.filter(call => call.path.endsWith("/blueTicket")).length, 1);
  await assert.rejects(() => provider.query({ ...request, profile: { ...profile, provider: "wechat" } }), /invoice_provider_mismatch/);
});

for (const paymentType of ["alipay", "wxpay"] as const) it(`loads fa-piao without WeChat credentials and supports confirmed ${paymentType} orders through the existing service`, async () => {
  const fixture = await balanceFixture(), remote = transportFixture();
  try {
    const file = join(fixture.directory, "fa-piao.private.json");
    writeFileSync(file, JSON.stringify(credentials), { mode: 0o600 });
    const config = loadConfig({ PERPAY_MASTER_KEY: fixture.key.toString("hex"), PERPAY_TAX_INVOICE_PROVIDER: "fa-piao",
      PERPAY_TAX_INVOICE_FAPIAO_CREDENTIAL_FILE: file });
    assert.equal(config.taxInvoices?.provider, "fa-piao");
    assert.equal(config.taxInvoices?.autoSync, false);
    const disabled = createInvoiceRuntime({ database: fixture.db, masterKey: fixture.key, ...config.taxInvoices!, transport: remote.transport });
    assert.equal((await disabled.authorize(profile)).authorized, false);
    assert.equal(remote.calls.length, 0);
    const provider = createInvoiceRuntime({ database: fixture.db, masterKey: fixture.key, provider: "fa-piao", credentialFile: file,
      allowIssue: true, transport: remote.transport });
    fixture.db.write(sql => {
      sql.exec(`INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at)
        VALUES('paid-native','paid-native',1,'software',1000,1000,'https://merchant.example.test/notify','PAID','PENDING',0,0,0)`);
      if (paymentType === "alipay") recordSyntheticAlipayConfirmation(sql, "paid-native", 1, 1000, 50);
      else {
        const secret = fixture.cipher.encrypt("epay:config:wechat-intent:paid-native", 1, "x".repeat(32));
        sql.prepare("INSERT INTO epay_wechat_intents VALUES('paid-native',1,'app','1900000001','fixture-platform-key','platform',?,?,?,1000,50,0)")
          .run(secret.nonce, secret.ciphertext, secret.authenticationTag);
        sql.exec(`UPDATE epay_orders SET type_code='wxpay',get_money_cents=1000,api_trade_no='provider-paid-native' WHERE trade_no='paid-native';
          INSERT INTO epay_wechat_confirmations VALUES('paid-native','provider-paid-native',1,1000,50,0);
          INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,frozen_delta_cents,occurred_at,source)
            VALUES('epay_payment:paid-native',1,'payment_paid',950,0,0,'perpay_epay');`);
      }
    });
    const access = { merchantId: "main-1", mainApiId: "api-1", epayMerchantId: 1, role: "admin" as const, userId: "admin" };
    const service = createInvoiceService({ database: fixture.db, provider });
    await service.saveProfile(access, { ...profile, expectedVersion: 0, enabled: true });
    const command = { requestId: "synthetic-invoice-0001", tradeNo: "paid-native", buyerType: "ORGANIZATION", title: request.buyer.title,
      taxId: request.buyer.taxId, email: request.buyer.email };
    const invoice = await service.createAndIssue(access, command);
    assert.equal(invoice.status, "ISSUED");
    assert.equal((await service.createAndIssue(access, command)).id, invoice.id);
    assert.equal(fixture.db.read(sql => sql.prepare("SELECT payment_type FROM epay_tax_invoice_requests").get()?.payment_type), paymentType);
    assert.equal(fixture.db.read(sql => sql.prepare("SELECT invoice_no FROM epay_tax_invoice_provider_receipts").get()?.invoice_no), NUMBER);
    assert.equal(await service.download(access, invoice.id), "https://files.fa-piao.com/synthetic.pdf");
    assert.equal(remote.calls.filter(call => call.path.endsWith("/blueTicket")).length, 1);
  } finally { fixture.close(); }
});

it("allows only disabled administrator configuration while both real issuance gates are closed", async () => {
  const fixture = await balanceFixture(), remote = transportFixture();
  try {
    const provider = createFaPiaoInvoiceProvider({ credentials, allowIssue: false, transport: remote.transport,
      receipts: { load: () => undefined, save: () => { throw new Error("closed gate"); } } });
    const app = new Hono().route("/invoices", createInvoiceRoutes({ database: fixture.db, masterKey: fixture.key, enabled: false, provider,
      publicOrigin: "https://gateway.example", identityOrigin: "http://127.0.0.1:8787",
      identityFetch: async (_, init) => {
        const role = new Headers(init?.headers).get("cookie");
        return Response.json({ ok: true, merchantId: "main-1", apiId: "api-1", role, userId: role });
      } }));
    const session = await (await app.request("/invoices/session?merchantId=main-1", { headers: { cookie: "admin" } })).json() as {
      data: { canConfigure: boolean; canRequest: boolean; csrfToken: string; providerKind: string } };
    assert.equal(session.data.canConfigure, true);
    assert.equal(session.data.canRequest, false);
    assert.equal(session.data.providerKind, "fa-piao");
    const post = (path: string, body: unknown) => app.request(`/invoices/${path}?merchantId=main-1`, { method: "POST",
      headers: { cookie: "admin", origin: "https://gateway.example", "content-type": "application/json", "x-csrf-token": session.data.csrfToken }, body: JSON.stringify(body) });
    assert.equal((await post("profile", { ...profile, expectedVersion: 0, enabled: false })).status, 200);
    assert.equal((await post("profile", { ...profile, expectedVersion: 1, enabled: true })).status, 503);
    assert.equal((await post("applications", {})).status, 503);
    assert.equal(remote.calls.length, 0);
  } finally { fixture.close(); }
});

it("keeps signed automation endpoints closed when payment admission is live but fa-piao issuance is off", async () => {
  const fixture = await balanceFixture(), remote = transportFixture();
  try {
    const provider = createFaPiaoInvoiceProvider({ credentials, allowIssue: false, transport: remote.transport,
      receipts: { load: () => undefined, save: () => { throw new Error("closed issuance"); } } });
    const app = new Hono().route("/invoices", createInvoiceAutomationRoutes({ database: fixture.db, masterKey: fixture.key,
      identityOrigin: "http://127.0.0.1:8787", publicOrigin: "https://gateway.example", enabled: true, provider,
      send: async () => { throw new Error("closed invoicing must not authenticate remotely"); } }));
    for (const path of ["applications", "query", "files"]) {
      const reply = await app.request(`/invoices/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(reply.status, 503);
      assert.equal((await reply.json() as { code: string }).code, "invoice_disabled");
    }
    assert.equal(remote.calls.length, 0);
  } finally { fixture.close(); }
});
