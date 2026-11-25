import assert from "node:assert/strict";
import { it } from "node:test";
import { balanceFixture } from "./epay-live-balance-fixture.ts";
import { recordSyntheticAlipayConfirmation } from "./epay-payment-fixture.ts";
import { requestRefund } from "../src/epay-compat/refund-workflow.ts";
import { requestMainInvoice } from "../src/epay-compat/main-invoice-request.ts";
import { issueMainOrderAccess } from "../src/epay-compat/main-order-access.ts";
import { createInvoiceService } from "../src/invoices/service.ts";
import type { InvoiceIssue, InvoiceObservation, InvoiceProvider } from "../src/invoices/model.ts";

const owner = { merchantId: "main-1", mainApiId: "api-1", epayMerchantId: 1, role: "owner" as const, userId: "owner" };
const admin = { ...owner, role: "admin" as const, userId: "admin" };
const profile = { expectedVersion: 0, subMchId: "1900000100", sellerName: "测试商户", sellerTaxId: "91310000123456789A", billingPersonId: "billing-person", itemName: "软件服务", taxCode: "3040201000000000000", taxRateBps: 600, enabled: true };
const application = { requestId: "invoice-request-001", tradeNo: "native", buyerType: "ORGANIZATION" as const, title: "测试购买方", taxId: "91310000987654321B", email: "invoice@example.test" };

async function fixture(observation: InvoiceObservation = { status: "PROCESSING" }, paymentType = "wxpay") {
  const f = await balanceFixture(), calls: InvoiceIssue[] = [];
  let outcome = observation, queryOutcome: InvoiceObservation | undefined, authorized = true, fail = false, authFail = false, queryFail = false;
  const provider: InvoiceProvider = {
    async authorize() { if (authFail) throw new Error("fixture authorization unavailable"); return { authorized, subMchId: profile.subMchId, billingPersonIds: [profile.billingPersonId] }; },
    async issue(request) { calls.push(request); if (fail) throw new Error("fixture transport timeout"); return outcome; },
    async query() { if (fail || queryFail) throw new Error("fixture transport timeout"); return queryOutcome ?? outcome; },
    async download() { return { downloadUrl: "https://invoice.example.test/tax.pdf" }; },
    async invite() { return { url: "https://invoice.example.test/authorize" }; },
  };
  f.db.write(sql => {
    sql.exec(`INSERT INTO epay_balance_openings VALUES(1,'fixture',0,0,0,'${"a".repeat(64)}','${"b".repeat(64)}',0);
      INSERT INTO epay_live_balances VALUES(1,0,0,0);
      INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at)
      VALUES('native','external-native',1,'software service',1000,1000,'https://merchant.example/notify','PAID','PENDING',0,0,0)`);
    if (paymentType === "alipay") recordSyntheticAlipayConfirmation(sql, "native", 1, 1000, 50);
    else {
      const secret = f.cipher.encrypt("epay:config:wechat-intent:native", 1, "x".repeat(32));
      sql.prepare("INSERT INTO epay_wechat_intents VALUES('native',1,'app',?,'fixture-platform-key','platform',?,?,?,1000,50,0)")
        .run(profile.subMchId, secret.nonce, secret.ciphertext, secret.authenticationTag);
      sql.exec("UPDATE epay_orders SET type_code='wxpay',get_money_cents=1000,api_trade_no='transaction' WHERE trade_no='native'; INSERT INTO epay_wechat_confirmations VALUES('native','transaction',1,1000,50,0)");
      sql.exec("INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,frozen_delta_cents,occurred_at,source) VALUES('epay_payment:native',1,'payment_paid',950,0,0,'perpay_epay')");
    }
  });
  const service = createInvoiceService({ database: f.db, provider, clock: () => 1_800_000_000_000 });
  return { ...f, service, calls, outcome: (next: InvoiceObservation) => { outcome = next; }, queryOutcome: (next: InvoiceObservation) => { queryOutcome = next; },
    authorization: (next: boolean) => { authorized = next; }, transportFails: () => { fail = true; }, authorizationFails: () => { authFail = true; }, queryFails: () => { queryFail = true; } };
}

it("requires a separate authorized seller profile for each merchant and hides other merchants' invoices", async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => f.service.saveProfile(owner, profile), /administrator/);
    await assert.rejects(() => f.service.createAndIssue(owner, application), /profile/);
    await f.service.saveProfile(admin, profile);
    const issued = await f.service.createAndIssue(owner, application);
    assert.equal(issued.amountCents, 1000);
    assert.equal(f.calls[0]?.profile.sellerName, profile.sellerName);
    assert.throws(() => f.service.read({ ...owner, merchantId: "main-2", mainApiId: "api-2", epayMerchantId: 2 }, issued.id), /not found/);
    assert.throws(() => f.service.read({ ...owner, epayMerchantId: 2 }, issued.id), /binding/);
    f.authorization(false);
    await assert.rejects(() => f.service.saveProfile(admin, { ...profile, expectedVersion: 1 }), /authorized/);
  } finally { f.close(); }
});

it("persists one request before submission, preserves snapshots and queries uncertain results without reissuing", async () => {
  const f = await fixture();
  try {
    await f.service.saveProfile(admin, profile);
    f.transportFails();
    const first = await f.service.createAndIssue(owner, application);
    assert.equal(first.status, "UNKNOWN");
    assert.equal((await f.service.createAndIssue(owner, application)).id, first.id);
    assert.equal(f.calls.length, 1);
    assert.equal((await f.service.refresh(owner, first.id)).status, "UNKNOWN");
    assert.equal(f.calls.length, 1);
    await assert.rejects(() => f.service.createAndIssue(owner, { ...application, title: "另一家企业" }), /conflict/);
    await assert.rejects(() => f.service.createAndIssue(owner, { ...application, requestId: "invoice-request-002" }), /conflict/);
    assert.equal(f.db.read(sql => sql.prepare("SELECT count(*) n FROM epay_tax_invoice_requests").get()?.n), 1n);
    assert.equal(f.db.read(sql => sql.prepare("SELECT count(*) n FROM epay_balance_ledger WHERE entry_type='invoice_fee'").get()?.n), 0n);
  } finally { f.close(); }
});

it("treats provider acceptance as processing and exposes a download only after issuance", async () => {
  const f = await fixture();
  try {
    await f.service.saveProfile(admin, profile);
    const first = await f.service.createAndIssue(owner, application);
    assert.equal(first.status, "PROCESSING");
    assert.equal(first.invoiceNo, null);
    await assert.rejects(() => f.service.download(owner, first.id), /not been issued/);
    f.outcome({ status: "ISSUED", invoiceNo: "12345678901234567890" });
    const issued = await f.service.refresh(owner, first.id);
    assert.equal(issued.status, "ISSUED");
    assert.equal(await f.service.download(owner, first.id), "https://invoice.example.test/tax.pdf");
    f.outcome({ status: "PROCESSING" });
    assert.equal((await f.service.refresh(owner, first.id)).status, "ISSUED");
  } finally { f.close(); }
});

it("rejects forged or refunded payments and prevents a refund while issuance is unresolved", async () => {
  const f = await fixture();
  try {
    await f.service.saveProfile(admin, profile);
    await assert.rejects(() => f.service.createAndIssue(owner, { ...application, tradeNo: "legacy-1" }), /confirmed/);
    const refund = { requestId: "refund-request-001", tradeNo: "native", amountCents: 100, reason: "return" };
    requestRefund(f.db, owner, refund, 1_800_000_000_000);
    await assert.rejects(() => f.service.createAndIssue(owner, application), /refund/);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
  const pending = await fixture();
  try {
    await pending.service.saveProfile(admin, profile);
    await pending.service.createAndIssue(owner, application);
    assert.throws(() => requestRefund(pending.db, owner, { requestId: "refund-request-001", tradeNo: "native", amountCents: 100, reason: "return" }, 1_800_000_000_000), /invoice/);
  } finally { pending.close(); }
});

it("rejects legacy invoice records and stale profile versions", async () => {
  const f = await fixture();
  try {
    await f.service.saveProfile(admin, profile);
    f.db.write(sql => sql.exec("INSERT INTO epay_invoice_applications(application_id,merchant_id,trade_no,out_trade_no,title,tax_id,email,fee_cents,status,created_at,updated_at,email_sent) VALUES('legacy-request',1,'native','external-native','old','tax','old@example.test',0,'pending',0,0,0)"));
    await assert.rejects(() => f.service.createAndIssue(owner, application), /legacy/);
    await assert.rejects(() => f.service.saveProfile(admin, profile), /version/);
    assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});

it("rejects unsupported payment types and a seller that differs from the actual WeChat recipient", async () => {
  const alipay = await fixture({ status: "PROCESSING" }, "alipay");
  try {
    await alipay.service.saveProfile(admin, profile);
    await assert.rejects(() => alipay.service.createAndIssue(owner, application), error => error instanceof Error && "code" in error && error.code === "invoice_payment_unsupported");
    assert.equal(alipay.calls.length, 0);
  } finally { alipay.close(); }
  const wrongMerchant = await fixture();
  try {
    await wrongMerchant.service.saveProfile(admin, profile);
    wrongMerchant.db.write(sql => sql.exec("DROP TRIGGER epay_wechat_intents_no_update; UPDATE epay_wechat_intents SET provider_merchant_id='1900000200' WHERE trade_no='native'"));
    await assert.rejects(() => wrongMerchant.service.createAndIssue(owner, application), error => error instanceof Error && "code" in error && error.code === "invoice_payment_merchant_mismatch");
    assert.equal(wrongMerchant.calls.length, 0);
  } finally { wrongMerchant.close(); }
});

it("keeps members read-only, binds each seller once, and disables authorization after a failed recheck", async () => {
  const f = await fixture(), member = { ...owner, role: "member" as const };
  try {
    await f.service.saveProfile(admin, profile);
    await assert.rejects(() => f.service.createAndIssue(member, application), /owner/);
    await assert.rejects(() => f.service.invite(member), /owner/);
    await assert.rejects(() => f.service.checkAuthorization(member), /owner/);
    assert.equal(f.service.getProfile(member)?.version, 1);
    await assert.rejects(() => f.service.saveProfile({ ...admin, merchantId: "main-2", mainApiId: "api-2", epayMerchantId: 2 }, profile), /already bound/);
    assert.equal(await f.service.invite(owner), "https://invoice.example.test/authorize");
    f.authorizationFails();
    await assert.rejects(() => f.service.checkAuthorization(owner), /unavailable/);
    assert.equal(f.service.getProfile(owner)?.authorized, false);
    assert.equal(f.service.getProfile(owner)?.enabled, false);
    assert.equal(f.service.getProfile(owner)?.version, 2);
  } finally { f.close(); }
});

it("reserves concurrent retries once and retains the original seller and tax snapshots", async () => {
  const f = await fixture();
  try {
    await f.service.saveProfile(admin, profile);
    const [first, second] = await Promise.all([f.service.createAndIssue(owner, application), f.service.createAndIssue(owner, application)]);
    assert.equal(first.id, second.id);
    assert.equal(f.calls.length, 1);
    await f.service.saveProfile(admin, { ...profile, expectedVersion: 1, itemName: "新的服务名称", taxRateBps: 300 });
    const saved = f.db.read(sql => sql.prepare("SELECT profile_json FROM epay_tax_invoice_requests WHERE invoice_id=?").get(first.id));
    const snapshot = JSON.parse(String(saved?.profile_json)) as { itemName: string; taxRateBps: number };
    assert.equal(snapshot.itemName, profile.itemName);
    assert.equal(snapshot.taxRateBps, 600);
    assert.throws(() => f.db.write(sql => sql.prepare("UPDATE epay_tax_invoice_requests SET amount_cents=1 WHERE invoice_id=?").run(first.id)), /immutable/);
    assert.throws(() => f.db.write(sql => sql.exec("INSERT INTO epay_invoice_applications(application_id,merchant_id,trade_no,out_trade_no,title,tax_id,email,fee_cents,status,created_at,updated_at,email_sent) VALUES('late-legacy',1,'native','external-native','old','tax','old@example.test',0,'pending',0,0,0)")), /tax invoice/);
  } finally { f.close(); }
});

it("requires a confirmed red cancellation before refunding an issued invoice", async () => {
  const f = await fixture({ status: "ISSUED", invoiceNo: "12345678901234567890" });
  const refund = { requestId: "refund-request-001", tradeNo: "native", amountCents: 100, reason: "return" };
  try {
    await f.service.saveProfile(admin, profile);
    const issued = await f.service.createAndIssue(owner, application);
    assert.throws(() => requestRefund(f.db, owner, refund, 1_800_000_000_000), /invoice/);
    f.outcome({ status: "REVERSING" });
    assert.equal((await f.service.refresh(owner, issued.id)).status, "REVERSING");
    await assert.rejects(() => f.service.download(owner, issued.id), /not been issued/);
    assert.throws(() => requestRefund(f.db, owner, refund, 1_800_000_000_000), /invoice/);
    f.outcome({ status: "ISSUED", invoiceNo: "12345678901234567890" });
    assert.equal((await f.service.refresh(owner, issued.id)).status, "REVERSING", "an older successful query cannot undo a red cancellation in progress");
    f.outcome({ status: "ISSUED", invoiceNo: "12345678901234567890", reversalFailed: true });
    assert.equal((await f.service.refresh(owner, issued.id)).status, "ISSUED", "a failed red cancellation leaves the original blue invoice valid");
    assert.throws(() => requestRefund(f.db, owner, refund, 1_800_000_000_000), /invoice/);
    f.outcome({ status: "REVERSING" });
    assert.equal((await f.service.refresh(owner, issued.id)).status, "REVERSING");
    f.outcome({ status: "REVERSED" });
    assert.equal((await f.service.refresh(owner, issued.id)).status, "REVERSED");
    assert.equal(requestRefund(f.db, owner, refund, 1_800_000_000_000).status, "REQUESTED");
  } finally { f.close(); }
});

it("lets a new merchant authorize before an administrator selects the returned billing person", async () => {
  const f = await fixture();
  try {
    const draft = await f.service.saveProfile(admin, { ...profile, enabled: false, billingPersonId: "" });
    assert.equal(draft.enabled, false);
    assert.equal(draft.billingPersonId, "");
    assert.equal(await f.service.invite(owner), "https://invoice.example.test/authorize");
    const checked = await f.service.checkAuthorization(owner);
    assert.deepEqual(checked.billingPersonIds, [profile.billingPersonId]);
    assert.equal(checked.profile.authorized, false);
    assert.equal(checked.profile.enabled, false);
    await assert.rejects(() => f.service.saveProfile(admin, { ...profile, expectedVersion: checked.profile.version, billingPersonId: "" }), /billing person/);
    const enabled = await f.service.saveProfile(admin, { ...profile, expectedVersion: checked.profile.version, billingPersonId: checked.billingPersonIds[0] });
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.authorized, true);
  } finally { f.close(); }
});

it("validates buyer identity and never records an unverified issuance as success", async () => {
  const f = await fixture({ status: "ISSUED" });
  try {
    await f.service.saveProfile(admin, profile);
    await assert.rejects(() => f.service.createAndIssue(owner, { ...application, taxId: "" }), /tax ID/);
    await assert.rejects(() => f.service.createAndIssue(owner, { ...application, buyerType: "INDIVIDUAL" }), /leave it empty/);
    await assert.rejects(() => f.service.createAndIssue(owner, { ...application, amountCents: 1 }), /Unrecognized key/);
    const unresolved = await f.service.createAndIssue(owner, { ...application, buyerType: "INDIVIDUAL", taxId: "" });
    assert.equal(unresolved.status, "UNKNOWN");
    assert.equal(unresolved.invoiceNo, null);
    assert.equal(unresolved.errorCode, "invoice_provider_unavailable");
    assert.equal(f.db.read(sql => sql.prepare("SELECT count(*) n FROM pragma_table_info('epay_tax_invoice_requests') WHERE name='download_url'").get()?.n), 0n);
  } finally { f.close(); }
});

it("blocks the legacy invoice path after any tax request without charging the merchant", async () => {
  const f = await fixture({ status: "FAILED", errorCode: "wechat_issue_failed" });
  try {
    const orderId = "00000000-0000-4000-8000-000000000001";
    const access = f.db.write(sql => {
      sql.prepare(`INSERT INTO epay_main_native_orders VALUES('native',?,'main-1','api-1',1,'wechat_native','main_form_hmac_v1',?,? ,?,?,?,0)`)
        .run(orderId, "a".repeat(64), "00000000-0000-4000-8000-000000000002", Buffer.alloc(12), Buffer.from("fixture"), Buffer.alloc(16));
      return issueMainOrderAccess(sql, orderId, 1, 1_800_000_000_000);
    });
    await f.service.saveProfile(admin, profile);
    assert.equal((await f.service.createAndIssue(owner, application)).status, "FAILED");
    assert.throws(() => requestMainInvoice(f.db, { orderId, token: access.invoice, input: { title: application.title, taxId: application.taxId, email: application.email }, feeCents: 5, now: 1_800_000_000_001 }), /invoice_already_requested/);
    assert.equal(f.db.read(sql => sql.prepare("SELECT count(*) n FROM epay_invoice_applications").get()?.n), 0n);
    assert.equal(f.db.read(sql => sql.prepare("SELECT count(*) n FROM epay_balance_ledger WHERE entry_type='invoice_fee'").get()?.n), 0n);
    assert.throws(() => f.db.write(sql => sql.exec("INSERT INTO epay_invoices(invoice_id,trade_no,kind,merchant_id,title,amount_cents,status,provider,created_at,updated_at) VALUES('old-invoice','native','normal',1,'old',1000,'ISSUED','legacy',0,0)")), /tax invoice/);
  } finally { f.close(); }
});

it("retries a provider-confirmed failure with a new invoice ID and the same application ID", async () => {
  const f = await fixture({ status: "FAILED", errorCode: "wechat_issue_failed" });
  try {
    await f.service.saveProfile(admin, profile);
    const failed = await f.service.createAndIssue(owner, application);
    assert.equal(failed.applicationNo, failed.requestNo);
    await f.service.saveProfile(admin, { ...profile, expectedVersion: 1, itemName: "修正后的服务", taxRateBps: 300 });
    f.outcome({ status: "PROCESSING" });
    f.queryOutcome({ status: "FAILED", errorCode: "wechat_issue_failed" });
    const retryInput = { ...application, requestId: "invoice-request-002" };
    const retry = await f.service.createAndIssue(owner, retryInput);
    assert.notEqual(retry.requestNo, failed.requestNo);
    assert.equal(retry.applicationNo, failed.applicationNo);
    assert.equal(retry.attempt, 2);
    assert.equal(retry.status, "PROCESSING");
    assert.equal(f.calls[1]?.profile.taxRateBps, 300);
    assert.equal(f.calls[1]?.profile.itemName, "修正后的服务");
    assert.deepEqual(f.calls[1]?.buyer, f.calls[0]?.buyer);
    assert.equal(f.service.read(owner, failed.id).status, "FAILED");
    assert.equal((await f.service.createAndIssue(owner, application)).id, failed.id);
    assert.equal((await f.service.createAndIssue(owner, retryInput)).id, retry.id);
    assert.equal(f.calls.length, 2);
    assert.throws(() => f.db.write(sql => sql.prepare("UPDATE epay_tax_invoice_requests SET status='UNKNOWN' WHERE invoice_id=?").run(failed.id)), /terminal/);
  } finally { f.close(); }
});

for (const [field, change] of Object.entries({
  buyerType: { buyerType: "INDIVIDUAL" as const, taxId: "" },
  title: { title: "另一家购买方" },
  taxId: { taxId: "91310000123456789A" },
  email: { email: "other@example.test" },
})) {
  it(`rejects a retry that changes the original buyer ${field} before another issuance`, async () => {
    const f = await fixture({ status: "FAILED", errorCode: "wechat_issue_failed" });
    try {
      await f.service.saveProfile(admin, profile);
      const failed = await f.service.createAndIssue(owner, application);
      f.queryOutcome({ status: "FAILED", errorCode: "wechat_issue_failed" });
      f.outcome({ status: "PROCESSING" });
      await assert.rejects(() => f.service.createAndIssue(owner, { ...application, ...change, requestId: "invoice-request-002" }),
        error => error instanceof Error && "code" in error && error.code === "invoice_buyer_conflict" && "status" in error && error.status === 409);
      assert.equal(f.calls.length, 1);
      assert.equal(f.service.read(owner, failed.id).status, "FAILED");
      assert.equal(f.db.read(sql => sql.prepare("SELECT count(*) n FROM epay_tax_invoice_requests").get()?.n), 1n);
    } finally { f.close(); }
  });
}

it("requires fresh failure proof, caps attempts, and permits safe retry only when the adapter proves no submission", async () => {
  const uncertain = await fixture({ status: "FAILED", errorCode: "wechat_issue_failed" });
  try {
    await uncertain.service.saveProfile(admin, profile);
    await uncertain.service.createAndIssue(owner, application);
    uncertain.queryOutcome({ status: "UNKNOWN" });
    await assert.rejects(() => uncertain.service.createAndIssue(owner, { ...application, requestId: "invoice-request-002" }), /could not be verified/);
    uncertain.queryFails();
    await assert.rejects(() => uncertain.service.createAndIssue(owner, { ...application, requestId: "invoice-request-002" }), /could not be verified/);
    assert.equal(uncertain.calls.length, 1);
  } finally { uncertain.close(); }
  const safe = await fixture({ status: "FAILED", errorCode: "invoice_not_submitted" });
  try {
    await safe.service.saveProfile(admin, profile);
    safe.queryFails();
    for (let attempt = 1; attempt <= 5; attempt++) {
      const record = await safe.service.createAndIssue(owner, { ...application, requestId: `invoice-request-00${attempt}` });
      assert.equal(record.attempt, attempt);
    }
    await assert.rejects(() => safe.service.createAndIssue(owner, { ...application, requestId: "invoice-request-006" }), error => error instanceof Error && "code" in error && error.code === "invoice_retry_limit");
    assert.equal(safe.calls.length, 5);
    assert.equal(new Set(safe.calls.map(call => call.applicationNo)).size, 1);
    assert.equal(new Set(safe.calls.map(call => call.requestNo)).size, 5);
  } finally { safe.close(); }
});

it("allows only one concurrent retry after the previous failed attempt", async () => {
  const f = await fixture({ status: "FAILED", errorCode: "wechat_issue_failed" });
  try {
    await f.service.saveProfile(admin, profile);
    await f.service.createAndIssue(owner, application);
    f.queryOutcome({ status: "FAILED", errorCode: "wechat_issue_failed" });
    f.outcome({ status: "PROCESSING" });
    const attempts = await Promise.allSettled([
      f.service.createAndIssue(owner, { ...application, requestId: "invoice-request-002" }),
      f.service.createAndIssue(owner, { ...application, requestId: "invoice-request-003" }),
    ]);
    assert.equal(attempts.filter(attempt => attempt.status === "fulfilled").length, 1);
    assert.equal(attempts.filter(attempt => attempt.status === "rejected").length, 1);
    assert.equal(f.calls.length, 2);
    assert.equal(f.db.read(sql => sql.prepare("SELECT count(*) n FROM epay_tax_invoice_requests WHERE status<>'FAILED'").get()?.n), 1n);
  } finally { f.close(); }
});

it("rejects an email that cannot fit RSA encryption before reserving an invoice", async () => {
  const f = await fixture();
  try {
    await f.service.saveProfile(admin, profile);
    const email = `${"a".repeat(60)}@${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(30)}.com`;
    assert.ok(email.length > 214 && email.length < 254);
    await assert.rejects(() => f.service.createAndIssue(owner, { ...application, email }), /encryption limit/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.db.read(sql => sql.prepare("SELECT count(*) n FROM epay_tax_invoice_requests").get()?.n), 0n);
  } finally { f.close(); }
});
