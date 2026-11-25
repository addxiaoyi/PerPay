import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { Hono } from "hono";
import { balanceFixture } from "./epay-live-balance-fixture.ts";
import { createInvoiceReconciliation } from "../src/invoices/reconciliation.ts";
import { createInvoiceRoutes } from "../src/invoices/routes.ts";
import type { InvoiceProvider } from "../src/invoices/model.ts";

const NOW = 1_800_000_000_000;
const admin = { merchantId: "main-1", mainApiId: "api-1", epayMerchantId: 1, userId: "admin", role: "admin" as const };
const candidate = { applicationNo: "a".repeat(32), invoiceNo: "20260000000000000001", evidenceRef: "provider-ticket-001" };
const confirm = (review: { reviewToken: string }) => ({ ...candidate, reviewToken: review.reviewToken, originalApplicationConfirmed: true, blueInvoiceConfirmed: true });
async function fixture() {
  const f = await balanceFixture();
  let now = NOW, reads = 0, mismatch = false;
  const id = randomUUID();
  const profile = { provider: "fa-piao", subMchId: "1000", sellerName: "Synthetic seller", sellerTaxId: "91310000123456789A",
    billingPersonId: "13900000000", itemName: "Software service", taxCode: "3040201000000000000", taxRateBps: 600 };
  f.db.write(sql => {
    sql.exec("INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES('reconcile','reconcile',1,'synthetic',1000,1000,'https://example.test','PAID','PENDING',0,0,0)");
    sql.prepare(`INSERT INTO epay_tax_invoice_requests(invoice_id,request_no,application_no,attempt,request_id,merchant_id,trade_no,amount_cents,payment_type,provider_trade_no,profile_json,buyer_type,title,tax_id,email,requested_by,status,created_at,updated_at)
      VALUES(?,?,?,1,'reconcile-request-001',1,'reconcile',1000,'alipay','synthetic-provider',?,'ORGANIZATION','Synthetic buyer','91310000987654321B','invoice@example.test','admin','UNKNOWN',?,?)`)
      .run(id, candidate.applicationNo, candidate.applicationNo, JSON.stringify(profile), NOW, NOW);
  });
  const provider: InvoiceProvider = {
    kind: "fa-piao", issuanceEnabled: false,
    authorize: async () => { throw new Error("authorization prohibited"); },
    issue: async () => { throw new Error("issuance prohibited"); },
    query: async () => { throw new Error("query without a candidate prohibited"); },
    download: async () => { throw new Error("download prohibited"); },
    invite: async () => { throw new Error("invite prohibited"); },
    reviewInvoice: async (request, number) => { reads++; assert.equal(request.applicationNo, candidate.applicationNo);
      return mismatch ? { status: "UNKNOWN", errorCode: "invoice_identity_mismatch" } : { status: "ISSUED", invoiceNo: number }; },
  };
  const service = createInvoiceReconciliation({ database: f.db, masterKey: f.key, provider, clock: () => now });
  return { ...f, id, provider, service, reads: () => reads, advance: () => { now += 300_000; }, mismatch: () => { mismatch = true; } };
}

it("previews read-only while issuance is off and confirms receipt/status/audit atomically", async () => {
  const f = await fixture();
  try {
    const before = f.db.read(sql => sql.prepare("SELECT count(*) n FROM audit_events").get()!.n);
    const review = await f.service.preview(admin, f.id, candidate);
    assert.equal(f.db.read(sql => sql.prepare("SELECT count(*) n FROM audit_events").get()!.n), before);
    assert.equal(f.db.read(sql => sql.prepare("SELECT count(*) n FROM epay_tax_invoice_provider_receipts").get()!.n), 0n);
    const invoice = await f.service.confirm(admin, f.id, confirm(review));
    assert.equal(invoice.status, "ISSUED"); assert.equal(invoice.invoiceNo, candidate.invoiceNo); assert.equal(f.reads(), 2);
    assert.equal(f.db.read(sql => sql.prepare("SELECT count(*) n FROM audit_events WHERE action='invoice.reconciled'").get()!.n), 1n);
    await assert.rejects(f.service.confirm(admin, f.id, confirm(review)), /conflicts/);
  } finally { f.close(); }
});

it("rejects owner/cross-merchant access, false attestations, expired and altered reviews", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.preview({ ...admin, role: "owner" }, f.id, candidate), /administrator/);
    await assert.rejects(f.service.preview({ ...admin, epayMerchantId: 2 }, f.id, candidate), /binding/);
    await assert.rejects(f.service.preview(admin, f.id, { ...candidate, applicationNo: "b".repeat(32) }), /conflicts/);
    const review = await f.service.preview(admin, f.id, candidate);
    await assert.rejects(f.service.confirm(admin, f.id, { ...confirm(review), blueInvoiceConfirmed: false }));
    await assert.rejects(f.service.confirm(admin, f.id, { ...confirm(review), evidenceRef: "altered-ticket" }), /conflicts/);
    await assert.rejects(f.service.confirm({ ...admin, userId: "another-admin" }, f.id, confirm(review)), /conflicts/);
    f.advance(); await assert.rejects(f.service.confirm(admin, f.id, confirm(review)), /conflicts/);
    assert.equal(f.db.read(sql => sql.prepare("SELECT count(*) n FROM epay_tax_invoice_provider_receipts").get()!.n), 0n);
  } finally { f.close(); }
});

it("saves nothing on provider mismatch, changed request or failing audit insert", async () => {
  const f = await fixture();
  try {
    const review = await f.service.preview(admin, f.id, candidate);
    f.db.write(sql => sql.exec("CREATE TRIGGER fail_reconcile_audit BEFORE INSERT ON audit_events WHEN NEW.action='invoice.reconciled' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END"));
    await assert.rejects(f.service.confirm(admin, f.id, confirm(review)), /synthetic audit failure/);
    assert.equal(f.db.read(sql => sql.prepare("SELECT status FROM epay_tax_invoice_requests WHERE invoice_id=?").get(f.id)!.status), "UNKNOWN");
    assert.equal(f.db.read(sql => sql.prepare("SELECT count(*) n FROM epay_tax_invoice_provider_receipts").get()!.n), 0n);
    f.db.write(sql => sql.prepare("UPDATE epay_tax_invoice_requests SET updated_at=updated_at+1 WHERE invoice_id=?").run(f.id));
    await assert.rejects(f.service.confirm(admin, f.id, confirm(review)), /conflicts/);
    f.mismatch(); await assert.rejects(f.service.preview(admin, f.id, candidate), /verified/);
  } finally { f.close(); }
});

it("requires same-origin CSRF and fresh administrator identity for reconciliation while closed", async () => {
  const f = await fixture(); let revoked = false;
  const app = new Hono().route('/tax', createInvoiceRoutes({ database: f.db, masterKey: f.key, enabled: false, provider: f.provider,
    clock: () => NOW, identityOrigin: 'http://127.0.0.1:8787', publicOrigin: 'https://gateway.example',
    identityFetch: async (_, init) => revoked ? Response.json({ ok: false }, { status: 401 })
      : Response.json({ ok: true, merchantId: 'main-1', apiId: 'api-1', userId: 'admin', role: new Headers(init?.headers).get('cookie') }),
  }));
  const session = async (cookie = 'admin') => (await (await app.request('/tax/session?merchantId=main-1', { headers: { cookie } })).json() as { data: { csrfToken: string; canReconcile: boolean } }).data;
  try {
    const access = await session(); assert.equal(access.canReconcile, true);
    const post = (body: unknown, origin = 'https://gateway.example', cookie = 'admin', token = access.csrfToken) => app.request(`/tax/${f.id}/reconcile/preview?merchantId=main-1`, {
      method: 'POST', headers: { cookie, origin, 'x-csrf-token': token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post(candidate, 'https://evil.example')).status, 403);
    assert.equal((await post(candidate, undefined, 'owner', (await session('owner')).csrfToken)).status, 403);
    assert.equal((await post(candidate, undefined, 'admin', '')).status, 403);
    assert.equal((await post(candidate)).status, 200);
    revoked = true; assert.equal((await post(candidate)).status, 401);
  } finally { f.close(); }
});

it("rejects reused invoice numbers in both the service and migration-71 unique index", async () => {
  const f = await fixture();
  try {
    const other = randomUUID(), requestNo = "b".repeat(32);
    f.db.write(sql => {
      sql.exec("INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES('second','second',1,'synthetic',1000,1000,'https://example.test','PAID','PENDING',0,0,0)");
      const row = sql.prepare("SELECT * FROM epay_tax_invoice_requests WHERE invoice_id=?").get(f.id)!;
      const clone = { ...row, invoice_id: other, request_no: requestNo, application_no: requestNo, request_id: "reconcile-request-002", trade_no: "second" };
      sql.prepare(`INSERT INTO epay_tax_invoice_requests(${Object.keys(clone).join(',')}) VALUES(${Object.keys(clone).map(() => '?').join(',')})`).run(...Object.values(clone));
      sql.prepare("INSERT INTO epay_tax_invoice_provider_receipts VALUES(?,'fa-piao',?,?)").run(requestNo, candidate.invoiceNo, NOW);
    });
    await assert.rejects(f.service.preview(admin, f.id, candidate), /conflicts/);
    assert.throws(() => f.db.write(sql => sql.prepare("INSERT INTO epay_tax_invoice_provider_receipts VALUES(?,'fa-piao',?,?)").run(candidate.applicationNo, candidate.invoiceNo, NOW)), /UNIQUE/);
    assert.equal(f.reads(), 0);
  } finally { f.close(); }
});
