import assert from "node:assert/strict";
import { it } from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createV3ResponseSignature } from "../src/infrastructure/alipay/v3.ts";
import { accountCertificate } from "./fixtures/alipay-account-certificate.ts";
import { verifyAlipayQueryAccount } from "../src/epay-compat/alipay-query-account.ts";
import { createAlipayPayoutAdapter } from "../src/epay-compat/payout-alipay.ts";
import { requirePayoutProof, verifyWechatPayoutQuery } from "../src/epay-compat/payout-evidence.ts";
import type { PayoutDestination, PayoutLease } from "../src/epay-compat/payout-model.ts";

it("keeps Alipay transfers off by default and verifies the exact original query after a signed submission", async () => {
  const directory = mkdtempSync(join(tmpdir(), "starpay-payout-provider-"));
  const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 }), platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = platform.publicKey.export({ type: "spki", format: "pem" }).toString();
  try {
    const certificate = accountCertificate(directory, merchant.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const now = Date.now();
    const account = verifyAlipayQueryAccount({ appId: "2026000000000000", sellerId: "2088000000000000", privateKey: merchant.privateKey, platformPublicKey: key, ...certificate }, now);
    const lease: PayoutLease = { id: "payout", merchantId: 1, accountId: "recipient", channel: "alipay", payer: account.sellerId, outNo: "a".repeat(32), amountCents: 101, action: "SUBMIT", token: "lease", until: now + 30_000 };
    const destination: PayoutDestination = { kind: "alipay", holderName: "合成用户", account: "fixture@example.test" };
    const calls: string[] = []; let wrongAmount = false, tampered = false;
    const options = { account, privateKey: merchant.privateKey, platformPublicKey: key, appCertSn: "a".repeat(32), alipayRootCertSn: "b".repeat(32), sceneName: "synthetic-scene", sceneReports: [{ info_type: "synthetic", info_content: "test only" }], clock: () => now,
      transport: { request: async (request: { method: string; path: string; body: string }) => {
        calls.push(request.method);
        if (request.method === "POST") {
          assert.equal(request.path, "/v3/alipay/fund/trans/uni/transfer");
          const input = JSON.parse(request.body);
          assert.equal(input.out_biz_no, lease.outNo); assert.equal(input.trans_amount, "1.01");
          assert.deepEqual(input.payee_info, { identity_type: "ALIPAY_LOGON_ID", identity: destination.account, name: destination.holderName });
        } else {
          const url = new URL(request.path, "https://openapi.alipay.com");
          assert.equal(url.pathname, "/v3/alipay/fund/trans/common/query"); assert.equal(url.searchParams.get("out_biz_no"), lease.outNo);
        }
        const body = JSON.stringify({ out_biz_no: lease.outNo, order_id: "provider-payout", status: "SUCCESS", trans_amount: wrongAmount ? "1.02" : "1.01" });
        return { status: 200, body: Buffer.from(tampered ? "{}" : body), headers: { "alipay-timestamp": String(now), "alipay-nonce": "test", "alipay-signature": createV3ResponseSignature(body, String(now), "test", platform.privateKey) } };
      } } };
    await assert.rejects(createAlipayPayoutAdapter(options).execute(lease, destination, new AbortController().signal), /unavailable/);
    assert.deepEqual(calls, []);
    const adapter = createAlipayPayoutAdapter({ ...options, enabled: true });
    const proof = await adapter.execute(lease, destination, new AbortController().signal);
    requirePayoutProof(proof); assert.equal(proof.state, "SUCCEEDED"); assert.deepEqual(calls, ["POST", "GET"]);
    await adapter.execute({ ...lease, action: "QUERY" }, destination, new AbortController().signal);
    assert.deepEqual(calls, ["POST", "GET", "GET"]);
    wrongAmount = true;
    await assert.rejects(adapter.execute({ ...lease, action: "QUERY" }, destination, new AbortController().signal), /amount/);
    wrongAmount = false; tampered = true;
    await assert.rejects(adapter.execute({ ...lease, action: "QUERY" }, destination, new AbortController().signal));
    assert.throws(() => requirePayoutProof({ ...proof }), /unverified/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it("validates WeChat payer, recipient, app, exact cents and final status before issuing payout evidence", () => {
  const platform = generateKeyPairSync("rsa", { modulusLength: 2048 }), now = Date.now();
  const key = { platformKey: platform.publicKey.export({ type: "spki", format: "pem" }).toString(), platformKeyId: "platform-test" };
  const destination: PayoutDestination = { kind: "wechat", holderName: "合成用户", account: "openid-synthetic-recipient", appId: "wx1234567890123456" };
  const lease: PayoutLease = { id: "payout", merchantId: 1, accountId: "recipient", channel: "wechat", payer: "mch-test", outNo: "a".repeat(32), amountCents: 101, action: "QUERY", token: "lease", until: now + 30_000 };
  const signed = (overrides: Record<string, unknown> = {}) => {
    const body = Buffer.from(JSON.stringify({ out_bill_no: lease.outNo, transfer_bill_no: "provider-payout", mch_id: lease.payer, appid: destination.appId, openid: destination.account, transfer_amount: 101, state: "SUCCESS", ...overrides }));
    const timestamp = String(Math.floor(now / 1000));
    const headers = new Headers({ "wechatpay-timestamp": timestamp, "wechatpay-serial": key.platformKeyId, "wechatpay-nonce": "test", "wechatpay-signature": sign("RSA-SHA256", Buffer.concat([Buffer.from(`${timestamp}\ntest\n`), body, Buffer.from("\n")]), platform.privateKey).toString("base64") });
    return { body, headers };
  };
  for (const overrides of [{ mch_id: "other" }, { openid: "other" }, { appid: "other" }, { transfer_amount: 102 }, { out_bill_no: "other" }, { state: "unexpected" }]) {
    const reply = signed(overrides); assert.throws(() => verifyWechatPayoutQuery(lease, destination, reply.body, reply.headers, key, now));
  }
  for (const [state, expected] of [["SUCCESS", "SUCCEEDED"], ["FAIL", "FAILED"], ["CANCELLED", "FAILED"], ["WAIT_USER_CONFIRM", "WAIT_USER_CONFIRM"], ["TRANSFERING", "PROCESSING"]]) {
    const reply = signed({ state }); const proof = verifyWechatPayoutQuery(lease, destination, reply.body, reply.headers, key, now);
    assert.equal(proof.state, expected); requirePayoutProof(proof);
  }
  const reply = signed(); assert.throws(() => verifyWechatPayoutQuery(lease, destination, Buffer.from("{}"), reply.headers, key, now));
});
