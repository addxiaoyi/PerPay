import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { verifyAlipayQueryAccount } from "../src/epay-compat/alipay-query-account.ts";
import { verifyAlipayQueryEvidence } from "../src/epay-compat/alipay-query-evidence.ts";
import { createV3ResponseSignature } from "../src/infrastructure/alipay/v3.ts";
import { buildAlipayPrecreate } from "../src/epay-compat/alipay-precreate.ts";

it("uses a pinned account certificate for signed queries that omit seller_id", () => {
  const directory = mkdtempSync(join(tmpdir(), "perpay-query-account-"));
  const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const platform = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKey = merchant.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKey = platform.publicKey.export({ type: "spki", format: "pem" }).toString();
  const keyPath = join(directory, "fixture-key.pem"), certPath = join(directory, "fixture-cert.pem");
  writeFileSync(keyPath, privateKey, { mode: 0o600 });
  const windowsOpenSSL = "C:/Program Files/Git/usr/bin/openssl.exe";
  const openssl = process.env.TEST_OPENSSL ?? (process.platform === "win32" && existsSync(windowsOpenSSL) ? windowsOpenSSL : "openssl");
  execFileSync(openssl, ["req", "-new", "-x509", "-key", keyPath, "-out", certPath, "-days", "2", "-subj", "/C=CN/O=Synthetic fixture/CN=2088000000000000"], { stdio: "pipe", windowsHide: true });
  try {
    const now = Date.now(), certificate = readFileSync(certPath, "utf8");
    const certificateSha256 = createHash("sha256").update(new X509Certificate(certificate).raw).digest("hex");
    const identity = { appId: "2026000000000000", sellerId: "2088000000000000", platformPublicKey: publicKey };
    const proof = verifyAlipayQueryAccount({ ...identity, privateKey, certificate, certificateSha256 }, now);
    const expected = { ...identity, tradeNo: "order_one", amountCents: 100 };
    const reply = (changes: Record<string, unknown> = {}) => {
      const body = JSON.stringify({ out_trade_no: expected.tradeNo, total_amount: "1.00", trade_status: "TRADE_SUCCESS", trade_no: "provider_one", ...changes });
      const timestamp = String(now), nonce = "fixture";
      return { status: 200, body: Buffer.from(body), headers: { "alipay-timestamp": timestamp, "alipay-nonce": nonce, "alipay-signature": createV3ResponseSignature(body, timestamp, nonce, platform.privateKey) } };
    };
    assert.throws(() => verifyAlipayQueryEvidence(reply(), expected, now), /seller identity/);
    const verified = verifyAlipayQueryEvidence(reply(), expected, now, proof);
    assert.equal(verified.evidence?.sellerId, identity.sellerId);
    assert.equal(verified.evidence?.providerTradeNo, "provider_one");
    for (const changes of [{ seller_id: "2088999999999999" }, { seller_id: null }, { app_id: "other" }, { total_amount: "1.01" }, { out_trade_no: "order_two" }, { trade_no: undefined }]) {
      assert.throws(() => verifyAlipayQueryEvidence(reply(changes), expected, now, proof));
    }
    assert.throws(() => verifyAlipayQueryEvidence(reply(), { ...expected, appId: "other" }, now, proof));
    assert.throws(() => verifyAlipayQueryEvidence(reply(), expected, now, { ...proof }));
    assert.throws(() => verifyAlipayQueryAccount({ ...identity, privateKey, certificate, certificateSha256: "0".repeat(64) }, now));
    assert.throws(() => verifyAlipayQueryAccount({ ...identity, sellerId: "2088999999999999", privateKey, certificate, certificateSha256 }, now));
    assert.throws(() => verifyAlipayQueryAccount({ ...identity, privateKey: platform.privateKey, certificate, certificateSha256 }, now));
    assert.throws(() => verifyAlipayQueryEvidence(reply(), expected, now + 301_000, proof));
    const request = buildAlipayPrecreate({ tradeNo: "order_one", amountCents: 100, subject: "fixture", notifyUrl: "https://example.com/notify", sellerId: identity.sellerId }, { appId: identity.appId, privateKey });
    assert.equal(JSON.parse(request.body).seller_id, identity.sellerId);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
