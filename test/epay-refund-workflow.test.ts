import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { it } from "node:test";
import { balanceFixture } from "./epay-live-balance-fixture.ts";
import { recordSyntheticAlipayConfirmation } from "./epay-payment-fixture.ts";
import { requestRefund, approveRefund, claimRefund, deferRefund, settleRefund, readRefund } from "../src/epay-compat/refund-workflow.ts";
import { verifyWechatRefundResponse, type RefundEvidence } from "../src/epay-compat/refund-evidence.ts";
import type { RefundLease } from "../src/epay-compat/refund-queue.ts";
import { readLiveBalance } from "../src/epay-compat/live-balance.ts";
import { Hono } from "hono";
import { createRefundRoutes } from "../src/epay-compat/refund-routes.ts";
import { auditNativeRefunds } from "../src/epay-compat/refund-audit.ts";

const owner = { merchantId: "main-1", mainApiId: "api-1", epayMerchantId: 1, role: "owner" as const, userId: "owner" };
const admin = { ...owner, role: "admin" as const, userId: "administrator" };
const platformKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const platformPem = platformKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
async function fixture(provider: "alipay" | "wxpay" = "alipay") {
  const f = await balanceFixture();
  f.db.write(sql => {
    sql.exec(`INSERT INTO epay_balance_openings VALUES(1,'fixture',0,0,0,'${"a".repeat(64)}','${"b".repeat(64)}',0);
      INSERT INTO epay_live_balances VALUES(1,0,0,0);
      INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at)
      VALUES('native','native',1,'fixture',1000,1000,'https://merchant.example/notify','PAID','PENDING',0,0,0)`);
    if (provider === "alipay") recordSyntheticAlipayConfirmation(sql, "native", 1, 1000, 50);
    else {
      const secret = f.cipher.encrypt("epay:config:wechat-intent:native", 1, "x".repeat(32));
      sql.prepare("INSERT INTO epay_wechat_intents VALUES('native',1,'app','merchant',?,'platform',?,?,?,1000,50,0)").run(platformPem, secret.nonce, secret.ciphertext, secret.authenticationTag);
      sql.exec("UPDATE epay_orders SET type_code='wxpay',get_money_cents=1000,api_trade_no='transaction' WHERE trade_no='native'; INSERT INTO epay_wechat_confirmations VALUES('native','transaction',1,1000,50,0)");
      sql.exec("INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,frozen_delta_cents,occurred_at,source) VALUES('epay_payment:native',1,'payment_paid',950,0,0,'perpay_epay')");
    }
  });
  return { ...f, balance: () => f.db.read(sql => readLiveBalance(sql, 1)) };
}

it("requires current merchant ownership and administrator approval before freezing a refund", async () => {
  const f = await fixture();
  const input = { requestId: "request-00000001", tradeNo: "native", amountCents: 600, reason: "退货" };
  try {
    assert.throws(() => requestRefund(f.db, { ...owner, epayMerchantId: 2 }, input, 1), /binding/);
    assert.throws(() => requestRefund(f.db, owner, { ...input, tradeNo: "legacy-1" }, 1), /confirmed/);
    const first = requestRefund(f.db, owner, input, 1);
    assert.equal(f.balance().availableCents, 950);
    assert.equal(requestRefund(f.db, owner, input, 2).refundNo, first.refundNo);
    assert.throws(() => requestRefund(f.db, owner, { ...input, amountCents: 601 }, 2), /conflict/);
    assert.throws(() => approveRefund(f.db, owner, first.refundNo, 3), /administrator/);
    const approved = approveRefund(f.db, admin, first.refundNo, 3);
    assert.equal(approved.status, "READY");
    assert.equal(f.balance().availableCents, 350);
    assert.equal(f.balance().frozenCents, 600);
    approveRefund(f.db, admin, first.refundNo, 4);
    assert.equal(f.balance().frozenCents, 600);
    assert.throws(() => requestRefund(f.db, owner, { ...input, requestId: "request-00000002" }, 5), /active/);
  } finally { f.close(); }
});

function wechatProof(lease: RefundLease, state: string, now: number) {
  const raw = Buffer.from(JSON.stringify({ out_trade_no: lease.tradeNo, transaction_id: lease.providerTradeNo, out_refund_no: lease.refundNo,
    refund_id: `provider-${lease.refundNo}`, status: state, amount: { total: lease.totalCents, refund: lease.amountCents, currency: "CNY" } }));
  const timestamp = String(Math.floor(now / 1000));
  const headers = new Headers({ "wechatpay-timestamp": timestamp, "wechatpay-nonce": "fixture", "wechatpay-serial": "platform",
    "wechatpay-signature": sign("RSA-SHA256", Buffer.from(`${timestamp}\nfixture\n${raw.toString()}\n`), platformKeys.privateKey).toString("base64") });
  return verifyWechatRefundResponse(lease, raw, headers, { platformKey: platformPem, platformKeyId: "platform" }, now);
}

it("settles partial refunds once, caps the total debit at the original merchant net and rolls back failed accounting", async () => {
  const f = await fixture("wxpay"), start = 1_800_000_000_000;
  try {
    const first = requestRefund(f.db, owner, { requestId: "request-00000001", tradeNo: "native", amountCents: 600, reason: "部分退货" }, start);
    approveRefund(f.db, admin, first.refundNo, start + 1);
    const lease = claimRefund(f.db, start + 2)!;
    const proof = wechatProof(lease, "SUCCESS", start + 3);
    f.db.write(sql => sql.exec("CREATE TRIGGER fail_refund_audit BEFORE INSERT ON audit_events WHEN NEW.action='epay.refund.succeeded' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END"));
    assert.throws(() => settleRefund(f.db, lease, proof, start + 3), /audit failure/);
    assert.equal(f.balance().frozenCents, 600);
    assert.equal(readRefund(f.db, owner, first.refundNo).status, "UNKNOWN");
    f.db.write(sql => sql.exec("DROP TRIGGER fail_refund_audit"));
    assert.equal(settleRefund(f.db, lease, proof, start + 3), true);
    assert.equal(settleRefund(f.db, lease, proof, start + 4), false);
    assert.equal(f.balance().availableCents, 350);
    assert.equal(f.balance().frozenCents, 0);
    assert.equal(f.db.read(sql => sql.prepare("SELECT status FROM epay_order_states WHERE trade_no='native'").get()?.status), "PARTIAL_REFUND");
    assert.throws(() => requestRefund(f.db, owner, { requestId: "request-00000002", tradeNo: "native", amountCents: 401, reason: "退货" }, start + 5), /exceeds/);
    const rest = requestRefund(f.db, owner, { requestId: "request-00000002", tradeNo: "native", amountCents: 400, reason: "剩余退货" }, start + 5);
    assert.equal(rest.debitCents, 350);
    approveRefund(f.db, admin, rest.refundNo, start + 6);
    const next = claimRefund(f.db, start + 7)!;
    settleRefund(f.db, next, wechatProof(next, "SUCCESS", start + 8), start + 8);
    assert.equal(f.balance().availableCents, 0);
    assert.equal(f.balance().frozenCents, 0);
    assert.equal(f.db.read(sql => sql.prepare("SELECT status FROM epay_order_states WHERE trade_no='native'").get()?.status), "REFUNDED");
    assert.equal(f.db.read(sql => sql.prepare("SELECT status FROM epay_orders WHERE trade_no='native'").get()?.status), "PAID", "payment proof survives refunds and duplicate callbacks");
    assert.deepEqual(f.db.read(auditNativeRefunds), { refunds: 2, pending: 0, uncertain: 0, inconsistent: 0 });
    f.db.write(sql => sql.exec("DROP TRIGGER epay_opened_ledger_no_delete; DELETE FROM epay_balance_ledger WHERE entry_id=(SELECT entry_id FROM epay_balance_ledger WHERE entry_type='refund_paid' LIMIT 1)"));
    assert.equal(f.db.read(auditNativeRefunds).inconsistent, 1);
  } finally { f.close(); }
});

it("keeps processing refunds frozen and releases only a signed closed result", async () => {
  const f = await fixture("wxpay"), now = 1_800_000_000_000;
  try {
    const first = requestRefund(f.db, owner, { requestId: "request-00000001", tradeNo: "native", amountCents: 1000, reason: "退货" }, now);
    approveRefund(f.db, admin, first.refundNo, now + 1);
    const lease = claimRefund(f.db, now + 2)!;
    settleRefund(f.db, lease, wechatProof(lease, "PROCESSING", now + 3), now + 3);
    assert.equal(f.balance().frozenCents, 950);
    const retry = claimRefund(f.db, now + 30_003)!;
    assert.equal(retry.action, "QUERY");
    const proof = wechatProof(retry, "CLOSED", now + 30_004);
    assert.throws(() => settleRefund(f.db, retry, { ...proof }, now + 30_004), /evidence/);
    settleRefund(f.db, retry, proof, now + 30_004);
    assert.equal(f.balance().availableCents, 950);
    assert.equal(f.balance().frozenCents, 0);
  } finally { f.close(); }
});

it("recovers expired refund leases by querying the same refund number and never resubmits an uncertain payment", async () => {
  const f = await fixture();
  try {
    const requested = requestRefund(f.db, owner, { requestId: "request-00000001", tradeNo: "native", amountCents: 1000, reason: "退货" }, 1);
    approveRefund(f.db, admin, requested.refundNo, 2);
    const first = claimRefund(f.db, 3, 1000)!;
    assert.equal(first.action, "SUBMIT");
    assert.equal(claimRefund(f.db, 1002, 1000), null);
    const recovered = claimRefund(f.db, 1003, 1000)!;
    assert.equal(recovered.action, "QUERY");
    assert.equal(recovered.refundNo, first.refundNo);
    assert.notEqual(recovered.leaseToken, first.leaseToken);
    assert.equal(deferRefund(f.db, first, 1004, "transport_unavailable"), false);
    assert.equal(deferRefund(f.db, recovered, 1004, "transport_unavailable"), true);
    assert.equal(readRefund(f.db, owner, requested.refundNo).status, "UNKNOWN");
    assert.equal(f.balance().availableCents, 0);
    assert.equal(f.balance().frozenCents, 950);
    assert.throws(() => settleRefund(f.db, recovered, { ...recovered, state: "SUCCEEDED" } as unknown as RefundEvidence, 1004), /evidence|lease/);
    assert.equal(f.balance().frozenCents, 950);
  } finally { f.close(); }
});

it("does not treat processing or changed refund amounts as authenticated completion", () => {
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 }), now = 1_800_000_000_000;
  const identity = { refundNo: "refund-000000001", tradeNo: "native", merchantId: 1, provider: "wxpay" as const,
    providerAccount: "merchant", providerTradeNo: "transaction", totalCents: 1000, amountCents: 600 };
  const response = (amount: number, state: string) => {
    const raw = Buffer.from(JSON.stringify({ out_trade_no: "native", transaction_id: "transaction", out_refund_no: identity.refundNo,
      refund_id: "provider-refund", status: state, amount: { total: 1000, refund: amount, currency: "CNY" } }));
    const headers = new Headers({ "wechatpay-timestamp": String(now / 1000), "wechatpay-nonce": "fixture", "wechatpay-serial": "platform",
      "wechatpay-signature": sign("RSA-SHA256", Buffer.from(`${now / 1000}\nfixture\n${raw.toString()}\n`), key.privateKey).toString("base64") });
    return { raw, headers };
  };
  const platform = { platformKey: key.publicKey.export({ type: "spki", format: "pem" }).toString(), platformKeyId: "platform" };
  const processing = response(600, "PROCESSING");
  assert.equal(verifyWechatRefundResponse(identity, processing.raw, processing.headers, platform, now).state, "PROCESSING");
  const changed = response(601, "SUCCESS");
  assert.throws(() => verifyWechatRefundResponse(identity, changed.raw, changed.headers, platform, now), /amount/);
});

it("enforces current identity, CSRF and administrator checks at the mounted refund HTTP boundary", async () => {
  const f = await fixture(), now = 1_800_000_000_000;
  const app = new Hono().route("/api/merchant/epay/refunds", createRefundRoutes({ database: f.db, masterKey: f.key,
    identityOrigin: "http://127.0.0.1:8787", publicOrigin: "https://gateway.example", enabled: true, clock: () => now,
    identityFetch: async (input, init) => {
      const cookie = new Headers(init?.headers).get("cookie");
      if (!cookie) return Response.json({ ok: false }, { status: 401 });
      if (new URL(String(input)).searchParams.get("merchantId") !== "main-1") return Response.json({ ok: false }, { status: 403 });
      return Response.json({ ok: true, merchantId: "main-1", apiId: "api-1", role: cookie === "admin" ? "admin" : "owner", userId: cookie });
    } }));
  const root = "/api/merchant/epay/refunds", query = "?merchantId=main-1";
  try {
    assert.equal((await app.request(root + query)).status, 401);
    const ownerSession = await app.request(root + "/session" + query, { headers: { cookie: "owner" } });
    const token = (await ownerSession.json() as { data: { csrfToken: string } }).data.csrfToken;
    const request = (path: string, cookie: string, csrf = token, extra: Record<string, unknown> = {}) => app.request(root + path + query,
      { method: "POST", headers: { cookie, origin: "https://gateway.example", "content-type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify(path ? extra : { requestId: "request-00000001", tradeNo: "native", amountCents: 600, reason: "退货", ...extra }) });
    assert.equal((await request("", "owner", "forged")).status, 403);
    assert.equal((await request("", "owner", token, { role: "admin", allowNegative: true })).status, 400);
    const created = await request("", "owner");
    assert.equal(created.status, 201, await created.clone().text());
    const id = (await created.json() as { data: { refundNo: string } }).data.refundNo;
    assert.equal((await request(`/${id}/approve`, "owner")).status, 403);
    assert.equal(f.balance().frozenCents, 0);
    const adminSession = await app.request(root + "/session" + query, { headers: { cookie: "admin" } });
    const adminToken = (await adminSession.json() as { data: { csrfToken: string } }).data.csrfToken;
    assert.equal((await request(`/${id}/approve`, "admin", adminToken)).status, 200);
    assert.equal(f.balance().frozenCents, 600);
    const cross = await app.request(root + "?merchantId=main-2", { headers: { cookie: "owner" } });
    assert.equal(cross.status, 403);
    assert.equal(f.balance().frozenCents, 600);
  } finally { f.close(); }
});
