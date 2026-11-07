import assert from "node:assert/strict";
import { it } from "node:test";
import { createCipheriv, generateKeyPairSync, privateDecrypt, sign, verify, constants } from "node:crypto";
import { balanceFixture } from "./epay-live-balance-fixture.ts";
import { registerWechatCredential } from "../src/epay-compat/wechat-credentials.ts";
import { registerWechatSigningKey } from "../src/epay-compat/wechat-signing-keys.ts";
import { createWechatPayoutService } from "../src/epay-compat/payout-wechat.ts";
import { addPayoutAccount, reviewPayoutAccount } from "../src/epay-compat/payout-accounts.ts";
import { requirePayoutProof } from "../src/epay-compat/payout-evidence.ts";
import type { PayoutLease } from "../src/epay-compat/payout-model.ts";
import { Hono } from "hono";
import { createPayoutRoutes } from "../src/epay-compat/payout-routes.ts";
import { createWechatPayoutCallback } from "../src/epay-compat/payout-wechat-callback.ts";

it("binds WeChat recipients through one-use OAuth and verifies authorization before submitting the original payout", async () => {
  const f = await balanceFixture(), merchant = generateKeyPairSync("rsa", { modulusLength: 2048 }), platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let now = Date.now(), state = "WAIT_USER_CONFIRM", lost = false, wrongIdentity = false;
  const appId = "wx1234567890123456", payer = "1234567890", openid = "openid-synthetic-recipient", apiKey = "x".repeat(32);
  const owner = { merchantId: "main-1", mainApiId: "api-1", epayMerchantId: 1, userId: "owner", role: "owner" as const };
  const admin = { ...owner, userId: "admin", role: "admin" as const }, calls: string[] = [];
  let authorizationNo = "", payoutNo = "";
  const signed = (value: unknown) => {
    const body = Buffer.from(JSON.stringify(value)), timestamp = String(Math.floor(now / 1000));
    const headers = new Headers({ "content-type": "application/json", "wechatpay-timestamp": timestamp, "wechatpay-serial": "platform-test", "wechatpay-nonce": "test",
      "wechatpay-signature": sign("RSA-SHA256", Buffer.concat([Buffer.from(`${timestamp}\ntest\n`), body, Buffer.from("\n")]), platform.privateKey).toString("base64") });
    return { body, headers };
  };
  const authFields = () => ({ out_authorization_no: authorizationNo, appid: appId, openid: wrongIdentity ? "wrong-recipient" : openid, state, transfer_scene_id: "fixture-scene", authorization_id: state === "WAIT_USER_CONFIRM" ? undefined : "provider-authorization", package_info: "fixture-package" });
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    assert.equal(init?.redirect, "error");
    if (url.hostname === "api.weixin.qq.com") return Response.json({ access_token: "fixture-token", openid, scope: "snsapi_base", expires_in: 7200 });
    assert.equal(url.origin, "https://api.mch.weixin.qq.com");
    const requestHeaders = new Headers(init?.headers), authHeader = requestHeaders.get("authorization")!;
    const attrs = Object.fromEntries([...authHeader.matchAll(/([a-z_]+)="([^"]+)"/g)].map(match => [match[1], match[2]]));
    assert.equal(attrs.mchid, payer); assert.equal(attrs.serial_no, "merchant-test");
    assert.equal(verify("RSA-SHA256", Buffer.from(`${init?.method}\n${url.pathname}\n${attrs.timestamp}\n${attrs.nonce_str}\n${init?.body ?? ""}\n`), merchant.publicKey, Buffer.from(attrs.signature!, "base64")), true);
    let value: unknown;
    if (url.pathname.endsWith("/user-confirm-authorization")) {
      const body = JSON.parse(String(init?.body)); authorizationNo = body.out_authorization_no;
      assert.equal(body.openid, openid); assert.equal(body.appid, appId);
      value = { out_authorization_no: authorizationNo, state, package_info: "fixture-package" };
      if (lost) throw new Error("synthetic lost authorization response");
    } else if (url.pathname.includes("/out-authorization-no/")) value = authFields();
    else if (url.pathname.endsWith("/transfer-bills/transfer")) {
      const body = JSON.parse(String(init?.body)); payoutNo = body.out_bill_no;
      assert.equal(body.authorization_id, "provider-authorization"); assert.equal(body.transfer_amount, 123);
      assert.equal(privateDecrypt({ key: platform.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" }, Buffer.from(body.user_name, "base64")).toString(), "合成用户");
      value = { out_bill_no: payoutNo };
    } else value = { out_bill_no: payoutNo, transfer_bill_no: "provider-transfer", mch_id: payer, appid: appId, openid, state: "SUCCESS", transfer_amount: 123 };
    const reply = signed(value); return new Response(reply.body, { headers: reply.headers });
  };
  try {
    registerWechatCredential(f.db, f.key, { id: "payout-platform", appId, merchantId: payer, platformKey: platform.publicKey.export({ type: "spki", format: "pem" }).toString(), platformKeyId: "platform-test", apiV3Key: apiKey, validFrom: now - 1000, validUntil: now + 7 * 86400000, actor: "test" }, now);
    registerWechatSigningKey(f.db, f.key, { id: "payout-signer", appId, merchantId: payer, serial: "merchant-test", privateKey: merchant.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKey: merchant.publicKey.export({ type: "spki", format: "pem" }).toString(), validFrom: now - 1000, validUntil: now + 7 * 86400000, actor: "test" }, now);
    const options = { database: f.db, cipher: f.cipher, appId, payer, credentialId: "payout-platform", signingKeyId: "payout-signer", sceneId: "fixture-scene", notifyUrl: "https://gateway.example/pay/epay/payouts/wechat/notify", displayName: "StarPAY", reports: [{ info_type: "fixture", info_content: "isolated" }], transport, clock: () => now,
      oauth: { appSecret: "fixture-oauth-secret", returnUrl: "https://gateway.example/pay/merchant/payouts", transport } };
    const disabled = createWechatPayoutService(options);
    assert.throws(() => disabled.beginBinding(owner, "cookie", "合成用户"), /unavailable/);
    const service = createWechatPayoutService({ ...options, enabled: true });
    const app = new Hono().route("/callbacks/wechat", createWechatPayoutCallback(service)).route("/payouts", createPayoutRoutes({ database: f.db, masterKey: f.key, enabled: true, wechat: service,
      publicOrigin: "https://gateway.example", identityOrigin: "http://127.0.0.1:8787", clock: () => now, identityFetch: async (input, init) => {
        const role = new Headers(init?.headers).get("cookie");
        if (!["owner", "admin", "member"].includes(role ?? "")) return Response.json({ ok: false }, { status: 401 });
        if (new URL(String(input)).searchParams.get("merchantId") !== "main-1") return Response.json({ ok: false }, { status: 403 });
        return Response.json({ ok: true, merchantId: "main-1", apiId: "api-1", userId: role, role });
      } }));
    for (const role of ["owner", "member"]) assert.equal((await app.request("/payouts/reconciliations?merchantId=main-1", { headers: { cookie: role } })).status, 403);
    assert.equal((await app.request("/payouts/reconciliations?merchantId=main-1", { headers: { cookie: "admin" } })).status, 200);
    const memberSession = await (await app.request("/payouts/session?merchantId=main-1", { headers: { cookie: "member" } })).json() as { data: { csrfToken: string; wechatAuthorization: boolean } };
    assert.equal(memberSession.data.wechatAuthorization, false);
    assert.equal((await app.request("/payouts/wechat/binding/begin?merchantId=main-1", { method: "POST", headers: { cookie: "member", origin: "https://gateway.example", "content-type": "application/json", "x-csrf-token": memberSession.data.csrfToken }, body: JSON.stringify({ holderName: "合成用户" }) })).status, 403);
    assert.throws(() => service.beginBinding({ ...owner, role: "member" }, "cookie", "合成用户"), /forbidden/);
    const manual = addPayoutAccount(f.db, f.cipher, owner, { requestId: "manual-wechat-001", kind: "wechat", account: openid, holderName: "合成用户", appId }, now);
    reviewPayoutAccount(f.db, admin, manual.id, { decision: "approve", reference: "fixture" }, now);
    await assert.rejects(service.authorize(owner, manual.id), /OAuth/);
    const redirect = service.beginBinding(owner, "cookie", "合成用户");
    const nonce = new URL(redirect.url).searchParams.get("state")!;
    await assert.rejects(service.completeBinding(owner, "other-cookie", nonce, "code"), /binding/);
    const account = await service.completeBinding(owner, "cookie", nonce, "code");
    await assert.rejects(service.completeBinding(owner, "cookie", nonce, "code"), /binding/);
    reviewPayoutAccount(f.db, admin, account.id, { decision: "approve", reference: "fixture" }, now);
    await assert.rejects(service.authorize({ ...owner, userId: "other-owner" }, account.id), /owner/);
    await assert.rejects(service.authorize({ ...owner, epayMerchantId: 2 }, account.id), /binding/);
    lost = true; await assert.rejects(service.authorize(owner, account.id)); lost = false;
    const pending = await service.authorize(owner, account.id);
    assert.equal(pending.state, "WAIT_USER_CONFIRM"); assert.equal(pending.bridge?.package, "fixture-package");
    assert.equal(calls.filter(path => path === "POST /v3/fund-app/mch-transfer/user-confirm-authorization").length, 1);
    const lease: PayoutLease = { id: "fixture", merchantId: 1, accountId: account.id, channel: "wechat", payer, outNo: "a".repeat(32), amountCents: 123, action: "SUBMIT", token: "fixture", until: now + 30000 };
    const destination = { kind: "wechat" as const, account: openid, holderName: "合成用户", appId };
    await assert.rejects(service.adapter.execute(lease, destination, new AbortController().signal), /authorization/);
    state = "TAKING_EFFECT"; wrongIdentity = true;
    await assert.rejects(service.authorize(owner, account.id), /identity/); wrongIdentity = false;
    assert.equal((await service.authorize(owner, account.id)).state, "TAKING_EFFECT");
    await assert.rejects(service.adapter.execute(lease, { ...destination, account: "openid-different-recipient" }, new AbortController().signal), /recipient/);
    const proof = await service.adapter.execute(lease, destination, new AbortController().signal);
    requirePayoutProof(proof); assert.equal(proof.state, "SUCCEEDED");
    const notify = (status: string) => {
      const encrypted = createCipheriv("aes-256-gcm", Buffer.from(apiKey), Buffer.from("0123456789ab")); encrypted.setAAD(Buffer.from("fixture"));
      const ciphertext = Buffer.concat([encrypted.update(JSON.stringify({ ...authFields(), state: status })), encrypted.final(), encrypted.getAuthTag()]).toString("base64");
      return signed({ id: `fixture-${status}`, event_type: status === "CLOSED" ? "MCHTRANSFER.AUTHORIZATION.CLOSED" : "MCHTRANSFER.AUTHORIZATION.CONFIRMED", resource_type: "encrypt-resource", resource: { algorithm: "AEAD_AES_256_GCM", nonce: "0123456789ab", associated_data: "fixture", ciphertext } });
    };
    const closed = notify("CLOSED"); service.notify(closed.body, closed.headers); service.notify(closed.body, closed.headers);
    assert.equal((await app.request("/callbacks/wechat/notify", { method: "POST", headers: closed.headers, body: closed.body })).status, 204);
    assert.equal((await app.request("/callbacks/wechat/notify", { method: "POST", headers: closed.headers, body: "{}" })).status, 400);
    const late = notify("TAKING_EFFECT"); service.notify(late.body, late.headers);
    assert.equal(service.status(owner, account.id).state, "CLOSED");
    assert.throws(() => service.notify(Buffer.from("{}"), closed.headers), /signature/);
    await assert.rejects(service.adapter.execute(lease, destination, new AbortController().signal), /authorization/);
    const queried = await service.adapter.execute({ ...lease, action: "QUERY" }, destination, new AbortController().signal);
    assert.equal(queried.state, "SUCCEEDED");
    assert.equal(calls.filter(path => path.endsWith("/transfer-bills/transfer")).length, 1);
    now += 1000; state = "WAIT_USER_CONFIRM";
    await service.authorize(owner, account.id);
    assert.equal(Number(f.db.read(sql => sql.prepare("SELECT count(*) n FROM epay_wechat_payout_authorizations").get()?.n)), 2);
    const serialized = JSON.stringify(f.db.read(sql => sql.prepare("SELECT * FROM epay_wechat_payout_authorizations").all()), (_, value) => typeof value === "bigint" ? String(value) : value);
    assert.ok(!serialized.includes("fixture-package") && !serialized.includes("provider-authorization"));
  } finally { f.close(); }
});
