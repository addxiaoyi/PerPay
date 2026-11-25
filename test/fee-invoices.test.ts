import assert from "node:assert/strict";
import { it } from "node:test";
import { Hono } from "hono";
import { balanceFixture } from "./epay-live-balance-fixture.ts";
import { recordSyntheticAlipayConfirmation } from "./epay-payment-fixture.ts";
import { createFeeInvoiceService } from "../src/invoices/fee-service.ts";
import { FeeInvoiceScheduler } from "../src/invoices/fee-scheduler.ts";
import { createFeeInvoiceRoutes } from "../src/invoices/fee-routes.ts";
import { createInvoiceReconciliation } from "../src/invoices/reconciliation.ts";
import { saveReceipt } from "../src/invoices/receipts.ts";
import type { InvoiceIssue, InvoiceProvider } from "../src/invoices/model.ts";
import { createFaPiaoInvoiceProvider } from "../src/invoices/fa-piao-provider.ts";
import { requestRefund } from "../src/epay-compat/refund-workflow.ts";
import { FaPiaoError, createFaPiaoClient } from "../src/invoices/fa-piao-client.ts";
import { readFeeQueueState, readProviderState } from "../src/invoices/fee-queue.ts";
import { createInvoiceService } from "../src/invoices/service.ts";
import { purchaseInvoiceSubscription } from "../src/invoices/subscription.ts";

const NOW = 1_800_000_000_000;
const owner = { merchantId: "main-1", mainApiId: "api-1", epayMerchantId: 1, role: "owner" as const, userId: "owner" };
const buyer = { expectedVersion: 0, buyerType: "ORGANIZATION" as const, title: "Synthetic merchant", taxId: "91310000987654321B", email: "merchant@example.test", autoInvoice: true };
const profile = { provider: "fa-piao" as const, subMchId: "1000", sellerName: "Synthetic platform", sellerTaxId: "91310000123456789A", billingPersonId: "13900000000", itemName: "Platform fee", taxCode: "3040205000000000000", taxRateBps: 100 };
async function fixture(closed = false) {
  const f = await balanceFixture(), calls: InvoiceIssue[] = [];
  f.db.write(sql => {
    sql.exec("INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES('fee-order','fee-order',1,'synthetic',1000,1000,'https://example.test','PAID','PENDING',0,0,0)");
    recordSyntheticAlipayConfirmation(sql, 'fee-order', 1, 1000, 50);
    sql.exec(`INSERT INTO epay_balance_openings VALUES(1,'fixture',10950,0,10000,'${'a'.repeat(64)}','${'b'.repeat(64)}',0);
      INSERT INTO epay_live_balances VALUES(1,10950,0,0)`);
  });
  purchaseInvoiceSubscription(f.db,owner,{requestId:'fixture-invoice-subscription',expectedBalanceVersion:0,expectedValidUntil:0},NOW);
  const provider: InvoiceProvider = { kind: "fa-piao", issuanceEnabled: !closed, platformFees: { profile, enabled: true, validUntil: NOW + 86_400_000 },
    authorize: async () => ({ authorized: true, subMchId: profile.subMchId, billingPersonIds: [profile.billingPersonId] }),
    issue: async request => { calls.push(request); throw new Error("synthetic issuance timeout"); },
    query: async () => ({ status: "UNKNOWN", errorCode: "fapiao_reconcile_required" }),
    reviewInvoice: async (_, invoiceNo) => ({ status: "ISSUED", invoiceNo }),
    download: async () => ({ downloadUrl: "https://files.example.test/invoice.pdf" }), invite: async () => ({ url: "https://example.test" }) };
  const service = createFeeInvoiceService({ database: f.db, provider, clock: () => NOW });
  return { ...f, provider, service, calls };
}
it("uses the recorded fee and merchant buyer, preserves snapshots and prevents timeout/concurrent reissuance", async () => {
  const f = await fixture();
  try {
    f.service.saveBuyer(owner, buyer);
    f.db.write(sql => sql.exec("UPDATE epay_merchant_accounts SET fee_rate_bps=4900 WHERE merchant_id=1"));
    const [first, second] = await Promise.all([f.service.create(owner, 'fee-order'), f.service.create(owner, 'fee-order')]);
    assert.equal(first.id, second.id); assert.equal(first.amountCents, 50); assert.equal(first.kind, 'platform-fee'); assert.equal(first.status, 'UNKNOWN');
    assert.equal(f.calls[0]!.buyer.title, buyer.title); assert.equal(f.calls.length, 1);
    f.service.saveBuyer(owner, { ...buyer, expectedVersion: 1, title: 'Changed merchant' });
    const restarted = createFeeInvoiceService({ database: f.db, provider: f.provider, clock: () => NOW });
    assert.equal((await restarted.create(owner, 'fee-order')).id, first.id); assert.equal(f.calls.length, 1);
    assert.equal(restarted.list(owner)[0]!.title, buyer.title);
    assert.equal(f.db.read(sql => sql.prepare("SELECT count(*) n FROM epay_tax_invoice_requests").get()!.n), 0n);
  } finally { f.close(); }
});

it("defers a mismatched payment without starving the next valid fee and reports the verified preview", async () => {
  const f = await fixture(); const errors: string[] = [];
  try {
    f.service.saveBuyer(owner, buyer);
    f.db.write(sql => {
      sql.exec("INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES('a-bad-fee','a-bad-fee',1,'synthetic',1000,1000,'https://example.test','PAID','PENDING',0,0,0)");
      recordSyntheticAlipayConfirmation(sql, 'a-bad-fee', 1, 1000, 50);
      sql.exec("UPDATE epay_orders SET get_money_cents=999 WHERE trade_no='a-bad-fee'");
    });
    const provider = { ...f.provider, issue: async (request: InvoiceIssue) => { f.calls.push(request); return { status: 'PROCESSING' as const }; } };
    const service = createFeeInvoiceService({ database: f.db, provider, clock: () => NOW });
    const readiness = service.readiness(owner);
    assert.equal(readiness.pendingCount, 1); assert.equal(readiness.pendingAmountCents, 50); assert.equal(readiness.unverifiedCount, 1);
    const scheduler = new FeeInvoiceScheduler(service, code => errors.push(code));
    assert.equal(await scheduler.trigger(), 1); assert.deepEqual(f.calls.map(row => row.tradeNo), ['fee-order']);
    assert.equal(errors[0], 'invoice_order_unconfirmed');
    assert.ok(f.db.read(sql => readFeeQueueState(sql, 'a-bad-fee')!.nextAt) > NOW);
    assert.equal(await scheduler.trigger(), 0); await scheduler.stop();
  } finally { f.close(); }
});

it("persists a provider cooldown across restarts and only an administrator's successful read-only probe clears it", async () => {
  const f = await fixture(); let authCalls = 0, checks = 0;
  const provider = { ...f.provider, authorize: async (): Promise<never> => { authCalls++; throw new FaPiaoError('fapiao_service_expired', 'NOT_SUBMITTED'); },
    checkStatus: async () => { checks++; return { authorized: true, subMchId: profile.subMchId, billingPersonIds: [profile.billingPersonId] }; } };
  try {
    const service = createFeeInvoiceService({ database: f.db, provider, clock: () => NOW }); service.saveBuyer(owner, buyer);
    const scheduler = new FeeInvoiceScheduler(service, () => undefined);
    assert.equal(await scheduler.trigger(), 0); assert.equal(authCalls, 1);
    const restarted = new FeeInvoiceScheduler(createFeeInvoiceService({ database: f.db, provider, clock: () => NOW }), () => undefined);
    assert.equal(await restarted.trigger(), 0); assert.equal(authCalls, 1);
    await assert.rejects(service.checkProvider(owner), /administrator/); assert.equal(checks, 0);
    const closed = createFeeInvoiceService({ database: f.db, provider: { ...provider, issuanceEnabled: false }, clock: () => NOW });
    const probe = await closed.checkProvider({ ...owner, role: 'admin', userId: 'admin' });
    assert.equal(probe.code, null); assert.equal(probe.nextAt, 0); assert.equal(checks, 1); assert.equal(closed.enabled(), false);
    assert.equal(f.db.read(sql => sql.prepare('SELECT count(*) n FROM epay_fee_invoice_requests').get()!.n), 0n);
    assert.equal(f.calls.length, 0); await scheduler.stop(); await restarted.stop();
  } finally { f.close(); }
});

it("caches failed token acquisition briefly and allows a fresh readiness probe after renewal without issuing", async () => {
  let expired = true, tokens = 0;
  const client = createFaPiaoClient({ allowIssue: false, credentials: { appKey: 'synthetic', appSecret: 's'.repeat(32), sellerName: profile.sellerName,
    accountId: '1000', sellerTaxId: profile.sellerTaxId, username: profile.billingPersonId, plan: '6' }, clock: () => NOW,
    transport: async input => {
      if (String(input).endsWith('/authorization')) { tokens++; return expired ? Response.json({ code: 999, msg: '失败', data: '企业服务已到期，请续期' }) : Response.json({ code: 200, data: { token: 'synthetic-token' } }); }
      assert.ok(String(input).endsWith('/queryFaceAuthState')); return Response.json({ code: 200 });
    } });
  await assert.rejects(client.checkLogin(), /fapiao_service_expired/);
  await assert.rejects(client.checkLogin(), /fapiao_service_expired/); assert.equal(tokens, 1);
  expired = false; assert.equal((await client.checkLogin(undefined, true)).code, 200); assert.equal(tokens, 2);
  await assert.rejects(client.issueBlue({}), /issuance_disabled/);
});

it("rejects a new full-payment customer invoice in platform fee mode before any provider request", async () => {
  const f = await fixture();
  try {
    const service = createInvoiceService({ database: f.db, provider: f.provider, clock: () => NOW });
    await assert.rejects(service.createAndIssue(owner, { requestId: 'no-full-payment-001', tradeNo: 'fee-order', buyerType: buyer.buyerType,
      title: buyer.title, taxId: buyer.taxId, email: buyer.email }), /full-payment customer invoice/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.db.read(sql => sql.prepare('SELECT count(*) n FROM epay_tax_invoice_requests').get()!.n), 0n);
  } finally { f.close(); }
});

it("keeps an unknown original invoice local to its payment instead of pausing unrelated fees", async () => {
  const f = await fixture();
  try {
    f.service.saveBuyer(owner, buyer);
    f.db.write(sql => {
      sql.exec("INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES('a-unknown-fee','a-unknown-fee',1,'synthetic',1000,1000,'https://example.test','PAID','PENDING',0,0,0)");
      recordSyntheticAlipayConfirmation(sql, 'a-unknown-fee', 1, 1000, 50);
    });
    const provider = { ...f.provider, issue: async (request: InvoiceIssue) => {
      f.calls.push(request); return request.tradeNo === 'a-unknown-fee' ? { status: 'UNKNOWN' as const, errorCode: 'fapiao_reconcile_required' } : { status: 'PROCESSING' as const };
    } };
    const service = createFeeInvoiceService({ database: f.db, provider, clock: () => NOW });
    const scheduler = new FeeInvoiceScheduler(service, () => undefined);
    assert.equal(await scheduler.trigger(), 2); assert.equal(f.calls.length, 2);
    assert.equal(f.db.read(sql => readProviderState(sql)!.nextAt), 0);
    assert.equal(await scheduler.trigger(), 0); assert.equal(f.calls.length, 2); await scheduler.stop();
  } finally { f.close(); }
});

it("requires administrator CSRF for a status-only provider probe and leaves real issuance off", async () => {
  const f = await fixture(true); let checks = 0;
  const provider = { ...f.provider, checkStatus: async () => { checks++; return { authorized: true, subMchId: profile.subMchId, billingPersonIds: [profile.billingPersonId] }; } };
  const app = new Hono().route('/fees', createFeeInvoiceRoutes({ database: f.db, masterKey: f.key, enabled: true, provider,
    clock: () => NOW, publicOrigin: 'https://gateway.example', identityOrigin: 'http://127.0.0.1:8787',
    identityFetch: async (_, init) => Response.json({ ok: true, merchantId: 'main-1', apiId: 'api-1', userId: 'owner', role: new Headers(init?.headers).get('cookie') }) }));
  const session = async (role: string) => (await (await app.request('/fees/session?merchantId=main-1', { headers: { cookie: role } })).json() as { data: { csrfToken: string } }).data;
  try {
    const ownerSession = await session('owner'), adminSession = await session('admin');
    const probe = (role: string, token: string, origin = 'https://gateway.example') => app.request('/fees/provider-status?merchantId=main-1', { method: 'POST',
      headers: { cookie: role, 'x-csrf-token': token, origin, 'content-type': 'application/json' }, body: '{}' });
    assert.equal((await probe('owner', ownerSession.csrfToken)).status, 403);
    assert.equal((await probe('admin', adminSession.csrfToken, 'https://evil.example')).status, 403); assert.equal(checks, 0);
    assert.equal((await probe('admin', adminSession.csrfToken)).status, 200); assert.equal(checks, 1);
    assert.equal((await (await app.request('/fees/session?merchantId=main-1', { headers: { cookie: 'admin' } })).json() as { data: { enabled: boolean } }).data.enabled, false);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});
it("closed automation reserves nothing and excludes pending or zero-fee payments", async () => {
  const f = await fixture(true);
  try {
    f.service.saveBuyer(owner, buyer);
    const scheduler = new FeeInvoiceScheduler(f.service, code => { throw new Error(code); });
    assert.equal(await scheduler.trigger(), 0); await assert.rejects(f.service.create(owner, 'fee-order'), /disabled/);
    assert.equal(f.calls.length, 0);
    f.db.write(sql => {
      sql.exec("INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES('zero-fee','zero-fee',1,'synthetic',1000,1000,'https://example.test','PAID','PENDING',0,0,0),('pending-fee','pending-fee',1,'synthetic',1000,1000,'https://example.test','PENDING','PENDING',0,0,0)");
      recordSyntheticAlipayConfirmation(sql, 'zero-fee', 1, 1000, 0);
    });
    assert.deepEqual(f.service.candidates().map(row => row.tradeNo), ['fee-order']); await scheduler.stop();
    assert.equal(f.db.read(sql => sql.prepare("SELECT count(*) n FROM epay_fee_invoice_requests").get()!.n), 0n);
    assert.throws(() => f.service.saveBuyer({ ...owner, role: 'member' }, buyer), /owner/);
    await assert.rejects(f.service.create({ ...owner, epayMerchantId: 2 }, 'fee-order'), /binding/);
    assert.throws(() => f.service.saveBuyer(owner, buyer), /changed/);
  } finally { f.close(); }
});
it("atomically reconciles an uncertain fee invoice and keeps its receipt immutable", async () => {
  const f = await fixture();
  try {
    f.service.saveBuyer(owner, buyer); const invoice = await f.service.create(owner, 'fee-order');
    const reconcile = createInvoiceReconciliation({ database: f.db, masterKey: f.key, provider: f.provider, clock: () => NOW });
    const candidate = { applicationNo: invoice.applicationNo, invoiceNo: '20260000000000000001', evidenceRef: 'synthetic-provider-ticket' };
    const admin = { ...owner, role: 'admin' as const, userId: 'admin' };
    const review = await reconcile.preview(admin, invoice.id, candidate);
    const issued = await reconcile.confirm(admin, invoice.id, { ...candidate, reviewToken: review.reviewToken, originalApplicationConfirmed: true, blueInvoiceConfirmed: true });
    assert.equal(issued.status, 'ISSUED');
    assert.throws(() => requestRefund(f.db, owner, { requestId: 'refund-fee-invoice-01', tradeNo: 'fee-order', amountCents: 100, reason: 'synthetic refund' }, NOW), /invoice reconciliation/);
    assert.equal(f.db.read(sql => sql.prepare("SELECT invoice_no FROM epay_fee_invoice_provider_receipts").get()!.invoice_no), candidate.invoiceNo);
    assert.throws(() => f.db.write(sql => sql.prepare("UPDATE epay_fee_invoice_provider_receipts SET invoice_no=?").run('20260000000000000002')), /immutable/);
    assert.throws(() => f.db.write(sql => saveReceipt(sql, invoice.requestNo, '20260000000000000002', NOW)), /conflicts/);
  } finally { f.close(); }
});

it("sends an ordinary 1% fee invoice without a special reduced-collection category and persists the fee receipt", async () => {
  const f = await fixture();
  const calls: Record<string, unknown>[] = [], invoiceNo = '20260000000000000001';
  const credentials = { appKey: 'synthetic', appSecret: 's'.repeat(32), accountId: '1000', sellerName: profile.sellerName, sellerTaxId: profile.sellerTaxId,
    username: profile.billingPersonId, plan: '6' as const, sellerAddressPhone: 'Synthetic address 01000000000', sellerBankAccount: 'Synthetic bank 000000000',
    platformFees: { itemName: profile.itemName, taxCode: profile.taxCode, taxRateBps: 100 as const, enabled: true, validUntil: NOW + 86_400_000 } };
  const provider = createFaPiaoInvoiceProvider({ credentials, allowIssue: true, clock: () => NOW,
    receipts: { load: () => undefined, save: (requestNo, number) => f.db.write(sql => saveReceipt(sql, requestNo, number, NOW)) },
    transport: async (input, init) => {
      const path = new URL(String(input)).pathname, body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (path.endsWith('/authorization')) return Response.json({ code: 200, data: { token: 'synthetic-token' } });
      if (path.endsWith('/queryFaceAuthState')) return Response.json({ code: 200 });
      if (path.endsWith('/blueTicket')) { calls.push(body); return Response.json({ code: 200, data: { Fphm: invoiceNo } }); }
      if (path.endsWith('/retMsg')) return Response.json({ code: 200, data: { fphm: invoiceNo, xhdwsbh: profile.sellerTaxId, xhdwmc: profile.sellerName,
        ghdwmc: buyer.title, ghdwsbh: buyer.taxId, hjje: '0.50', hjse: '0.00', fplxdm: '82', mxzb: [{ spbm: profile.taxCode, sl: '0.01', je: '0.50', se: '0.00' }] } });
      throw new Error(`unexpected provider endpoint ${path}`);
    } });
  try {
    const service = createFeeInvoiceService({ database: f.db, provider, clock: () => NOW });
    service.saveBuyer(owner, buyer); const invoice = await service.create(owner, 'fee-order');
    assert.equal(invoice.status, 'ISSUED'); assert.equal(invoice.amountCents, 50); assert.equal(calls.length, 1);
    assert.equal(calls[0]!.zsfs, '0'); assert.equal(calls[0]!.jazslxDm, undefined); assert.equal(calls[0]!.jshj, '0.50');
    assert.equal((calls[0]!.fyxm as { sl: string }[])[0]!.sl, '0.01');
    assert.equal(f.db.read(sql => sql.prepare('SELECT count(*) n FROM epay_fee_invoice_provider_receipts').get()!.n), 1n);
  } finally { f.close(); }
});
it("allows same-origin CSRF buyer preparation while real fee issuance remains closed", async () => {
  const f = await fixture(true);
  const app = new Hono().route('/fees', createFeeInvoiceRoutes({ database: f.db, masterKey: f.key, enabled: true,
    provider: f.provider, clock: () => NOW, publicOrigin: 'https://gateway.example', identityOrigin: 'http://127.0.0.1:8787',
    identityFetch: async (_, init) => Response.json({ ok: true, merchantId: 'main-1', apiId: 'api-1', userId: 'owner', role: new Headers(init?.headers).get('cookie') }) }));
  try {
    const session = (await (await app.request('/fees/session?merchantId=main-1', { headers: { cookie: 'owner' } })).json() as { data: { enabled: boolean; csrfToken: string } }).data;
    assert.equal(session.enabled, false);
    const post = (path: string, input: unknown, origin = 'https://gateway.example') => app.request(`/fees/${path}?merchantId=main-1`, { method: 'POST',
      headers: { cookie: 'owner', origin, 'content-type': 'application/json', 'x-csrf-token': session.csrfToken }, body: JSON.stringify(input) });
    assert.equal((await post('buyer', buyer, 'https://evil.example')).status, 403);
    assert.equal((await post('buyer', buyer)).status, 200);
    assert.equal((await post('applications', { tradeNo: 'fee-order' })).status, 503); assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});
