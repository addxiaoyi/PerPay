import assert from "node:assert/strict";
import { constants, generateKeyPairSync, privateDecrypt, sign, verify } from "node:crypto";
import { it } from "node:test";
import { balanceFixture } from "./epay-live-balance-fixture.ts";
import { registerWechatCredential, revokeWechatCredential } from "../src/epay-compat/wechat-credentials.ts";
import { registerWechatSigningKey } from "../src/epay-compat/wechat-signing-keys.ts";
import { createWechatInvoiceProvider } from "../src/invoices/wechat-provider.ts";
import type { InvoiceIssue } from "../src/invoices/model.ts";

const request: InvoiceIssue = {
  applicationNo: "invoice_apply_0123456789", requestNo: "invoice_request_0123456789", merchantId: 1, tradeNo: "perpay-order-1", amountCents: 1200,
  paymentType: "wxpay", providerTradeNo: "4200000008202508080512076713",
  profile: { subMchId: "1234567891", sellerName: "Fixture seller", sellerTaxId: "91310000123456789X",
    billingPersonId: "billing-person-1", itemName: "Software service", taxCode: "3040201000000000000", taxRateBps: 600 },
  buyer: { type: "ORGANIZATION", title: "Fixture buyer", taxId: "91310000987654321X", email: "buyer@example.test" },
};

it("uses separate service-provider credentials and encrypts buyer details before accepting asynchronous issuance", async () => {
  const f = await providerFixture();
  try {
    const authorization = await f.provider.authorize(request.profile);
    assert.equal(authorization.authorized, true);
    assert.equal(authorization.subMchId, request.profile.subMchId);
    assert.deepEqual(authorization.billingPersonIds, [request.profile.billingPersonId]);
    assert.deepEqual(await f.provider.issue(request), { status: "PROCESSING" });
    const submitted = f.bodies.find(row => row.path.endsWith("/issue-general"))!.body;
    assert.equal(submitted.sub_mchid, request.profile.subMchId);
    assert.equal(submitted.fapiao_apply_id, request.applicationNo);
    const invoice = submitted.fapiao_information as Record<string, unknown>;
    assert.equal(invoice.fapiao_id, request.requestNo);
    assert.equal(invoice.total_amount, 1200);
    assert.equal(invoice.billing_person_id, "billing-person-1");
    assert.deepEqual(invoice.transaction_information, [{ pay_channel: "WECHAT_PAY", transaction_id: request.providerTradeNo, amount: 1200 }]);
    const buyer = submitted.buyer_information as Record<string, unknown>;
    assert.equal(privateDecrypt({ key: f.platform.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" }, Buffer.from(String(buyer.email), "base64")).toString(), request.buyer.email);
    const notSubmitted = { status: "FAILED", errorCode: "invoice_not_submitted" };
    assert.deepEqual(await f.provider.issue({ ...request, paymentType: "alipay" }), notSubmitted);
    assert.deepEqual(await f.provider.issue({ ...request, providerTradeNo: "" }), notSubmitted);
    assert.deepEqual(await f.provider.issue({ ...request, buyer: { ...request.buyer, email: "a".repeat(230) + "@example.test" } }), notSubmitted);
    assert.equal(f.bodies.filter(row => row.path.endsWith("/issue-general")).length, 1);
  } finally { f.close(); }
});

it("rejects mismatched authorization, unsigned responses, and issued invoices belonging to another seller or buyer", async () => {
  const f = await providerFixture();
  try {
    f.state.authorization = { ...f.state.authorization, sub_mchid: "9999999999" };
    await assert.rejects(f.provider.authorize(request.profile), /identity/);
    f.state.authorization = authorization();
    f.state.authorization.digital_tax_mode = { status: "ENABLED", billing_person_info: [{ id: request.profile.billingPersonId }],
      ability_info: [{ type: "BASE_ABILITY", status: "AUTHORIZE_PENDING" }] };
    assert.equal((await f.provider.authorize(request.profile)).authorized, false);
    f.state.authorization.digital_tax_mode = { status: "ENABLED", billing_person_info: [{ id: request.profile.billingPersonId }],
      expired_time: "2020-01-01T00:00:00+08:00", ability_info: [{ type: "BASE_ABILITY", status: "AUTHORIZED" }] };
    assert.equal((await f.provider.authorize(request.profile)).authorized, false);
    f.state.authorization = authorization();
    f.state.authorization.digital_tax_mode = { status: "ENABLED", billing_person_info: [{ id: "other" }], ability_info: [{ type: "BASE_ABILITY", status: "AUTHORIZED" }] };
    assert.equal((await f.provider.authorize(request.profile)).authorized, false);
    f.state.authorization = authorization();
    f.state.unsigned = true;
    assert.deepEqual(await f.provider.issue(request), { status: "FAILED", errorCode: "invoice_not_submitted" });
    f.state.unsigned = false;
    assert.equal((await f.provider.query(request)).status, "ISSUED");
    f.state.invoice = { ...issuedInvoice(), status: "REVERSE_FAILED" };
    assert.equal((await f.provider.query(request)).reversalFailed, true);
    f.state.invoice = { ...issuedInvoice(), status: "ISSUE_FAILED", total_amount: 1 };
    await assert.rejects(f.provider.query(request), /amount/);
    for (const change of [
      { total_amount: 1201 }, { fapiao_id: "other" },
      { seller_information: { name: request.profile.sellerName, taxpayer_id: "91310000111111111X" } },
      { buyer_information: { type: "ORGANIZATION", name: "Other buyer", taxpayer_id: request.buyer.taxId } },
    ]) {
      f.state.invoice = { ...issuedInvoice(), ...change };
      await assert.rejects(f.provider.query(request), /identity|amount/);
    }
    revokeWechatCredential(f.db, "invoice-platform", "test", "isolated revocation", f.now);
    await assert.rejects(f.provider.authorize(request.profile), /credential unavailable/);
  } finally { f.close(); }
});

it("builds short-lived invoice download links from verified query details and blocks untrusted destinations", async () => {
  const f = await providerFixture();
  try {
    const download = await f.provider.download(request), url = new URL(download.downloadUrl);
    assert.equal(url.origin, "https://pay.wechatpay.cn");
    assert.equal(url.searchParams.get("token"), "fixture-token");
    assert.equal(url.searchParams.get("mchid"), "1234567890");
    assert.equal(url.searchParams.get("sub_mchid"), request.profile.subMchId);
    assert.equal(url.searchParams.get("openid"), "fixture-openid");
    assert.equal(url.searchParams.get("invoice_no"), "12345678901234567890");
    assert.equal(url.searchParams.get("fapiao_id"), request.requestNo);
    assert.equal(url.searchParams.get("file_format"), "PDF");
    f.state.invoice = { ...issuedInvoice(), status: "REVERSE_FAILED" };
    assert.equal(new URL((await f.provider.download(request)).downloadUrl).searchParams.get("invoice_no"), "12345678901234567890");
    f.state.downloadUrl = "https://evil.example/invoicing/fapiao/fapiao-file?token=fixture";
    await assert.rejects(f.provider.download(request), /download URL/);
    f.state.invoice = { ...issuedInvoice(), status: "REVERSED" };
    assert.equal((await f.provider.query(request)).status, "REVERSED");
    await assert.rejects(f.provider.download(request), /not issued/);
    assert.equal((await f.provider.invite(request.profile)).url, "https://wxacurl.cn/?fixture=1");
  } finally { f.close(); }
});

function authorization(): Record<string, unknown> {
  return { sub_mchid: request.profile.subMchId, digital_tax_mode: { status: "ENABLED",
    billing_person_info: [{ id: request.profile.billingPersonId, name: "*员 0001" }],
    expired_time: "2099-01-01T00:00:00+08:00", ability_info: [{ type: "BASE_ABILITY", status: "AUTHORIZED" }] } };
}

it("propagates scheduler shutdown to the signed WeChat query transport", async () => {
  const f = await providerFixture(signal => new Promise<void>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  try {
    const controller = new AbortController();
    const query = f.provider.query(request, controller.signal);
    controller.abort(new Error("scheduler stopped"));
    await assert.rejects(query, /scheduler stopped/);
  } finally { f.close(); }
});

function issuedInvoice(): Record<string, unknown> {
  return { fapiao_id: request.requestNo, status: "ISSUED", total_amount: 1200,
    seller_information: { name: request.profile.sellerName, taxpayer_id: request.profile.sellerTaxId },
    buyer_information: { type: request.buyer.type, name: request.buyer.title, taxpayer_id: request.buyer.taxId },
    blue_fapiao: { fapiao_number: "12345678901234567890", fapiao_time: "2026-11-21T15:00:00+08:00" },
    card_information: { card_openid: "fixture-openid" } };
}

async function providerFixture(waitForTransport?: (signal: AbortSignal) => Promise<void>) {
  const f = await balanceFixture(), merchant = generateKeyPairSync("rsa", { modulusLength: 2048 }), platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = Date.now(), appId = "wx1234567890123456", merchantId = "1234567890";
  registerWechatCredential(f.db, f.key, { id: "invoice-platform", appId, merchantId,
    platformKey: platform.publicKey.export({ type: "spki", format: "pem" }).toString(), platformKeyId: "invoice-public-key",
    apiV3Key: "x".repeat(32), validFrom: now - 1000, validUntil: now + 86400000, actor: "test" }, now);
  registerWechatSigningKey(f.db, f.key, { id: "invoice-signer", appId, merchantId, serial: "invoice-certificate",
    privateKey: merchant.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKey: merchant.publicKey.export({ type: "spki", format: "pem" }).toString(),
    validFrom: now - 1000, validUntil: now + 86400000, actor: "test" }, now);
  const state = { authorization: authorization(), invoice: issuedInvoice(), unsigned: false,
    downloadUrl: "https://pay.wechatpay.cn/invoicing/fapiao/fapiao-file?token=fixture-token" };
  const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];
  const transport: typeof fetch = async (input, init) => {
    if (waitForTransport) {
      assert.ok(init?.signal);
      await waitForTransport(init.signal);
    }
    const url = new URL(String(input)), headers = new Headers(init?.headers);
    assert.equal(url.origin, "https://api.mch.weixin.qq.com");
    assert.equal(init?.redirect, "error");
    const auth = Object.fromEntries([...headers.get("authorization")!.matchAll(/([a-z_]+)="([^"]+)"/g)].map(match => [match[1], match[2]]));
    assert.equal(auth.mchid, merchantId); assert.equal(auth.serial_no, "invoice-certificate");
    assert.equal(verify("RSA-SHA256", Buffer.from(`${init?.method}\n${url.pathname}${url.search}\n${auth.timestamp}\n${auth.nonce_str}\n${init?.body ?? ""}\n`), merchant.publicKey, Buffer.from(auth.signature!, "base64")), true);
    if (init?.body) bodies.push({ path: url.pathname, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    let payload: unknown = { total_count: 1, fapiao_information: [state.invoice] }, status = 200;
    if (url.pathname.endsWith("/check-status")) payload = state.authorization;
    if (url.pathname.endsWith("/issue-general")) { payload = undefined; status = 202; }
    if (url.pathname.endsWith("/fapiao-files")) payload = { fapiao_download_info_list: [{ fapiao_id: request.requestNo, status: "ISSUED", download_url: state.downloadUrl }] };
    if (url.pathname.endsWith("/getspinviteurl")) payload = { invite_url: "https://wxacurl.cn/?fixture=1" };
    const body = payload === undefined ? "" : JSON.stringify(payload), timestamp = String(Math.floor(now / 1000));
    const reply = new Headers({ "content-type": "application/json" });
    if (!state.unsigned) {
      reply.set("wechatpay-timestamp", timestamp); reply.set("wechatpay-nonce", "fixture"); reply.set("wechatpay-serial", "invoice-public-key");
      reply.set("wechatpay-signature", sign("RSA-SHA256", Buffer.from(`${timestamp}\nfixture\n${body}\n`), platform.privateKey).toString("base64"));
    }
    return new Response(body, { status, headers: reply });
  };
  return { ...f, platform, state, bodies, now, provider: createWechatInvoiceProvider({ database: f.db, cipher: f.cipher, appId, merchantId,
    credentialId: "invoice-platform", signingKeyId: "invoice-signer", transport, clock: () => now }) };
}
