import assert from "node:assert/strict";
import { createHash, createPrivateKey } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NodeV3Transport } from "../src/infrastructure/alipay/node-transport.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { readEncryptedChannelConfig } from "../src/epay-compat/channel-config.ts";
import { verifyAlipayQueryAccount } from "../src/epay-compat/alipay-query-account.ts";
import { buildAlipayTradeQuery } from "../src/epay-compat/alipay-query.ts";
import { verifyAlipayQueryEvidence } from "../src/epay-compat/alipay-query-evidence.ts";
import { observeLegacyWechatPayment } from "../src/epay-compat/legacy-wechat-observation.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
let phase = "arguments";

async function verifyChannels() {
  const [root, certificateFile, reportFile] = process.argv.slice(2);
  assert.equal(process.env.EPAY_READONLY_AUDIT, "1");
  assert.equal(process.argv.length, 5);
  assert.ok(root && /^\/var\/lib\/perpay-candidate-\d{8}[a-z]$/.test(root));
  assert.ok(certificateFile && resolve(certificateFile) === certificateFile);
  assert.ok(reportFile && (/^\/root\/perpay-recovery-[a-z0-9-]+\/audits\/[a-z0-9-]+\.json$/.test(reportFile) ||
    reportFile.startsWith(root + "/backups/") && /^[a-z0-9-]+\.json$/.test(reportFile.slice((root + "/backups/").length))) && !existsSync(reportFile));
  process.umask(0o077);
  const key = Buffer.from(readFileSync(join(root, "secrets/master-key"), "utf8").trim(), "hex");
  assert.equal(key.length, 32);
  const sql = new DatabaseSync(join(root, "data/perpay.sqlite3"), { readOnly: true });
  try {
    phase = "snapshot";
    sql.exec("BEGIN");
    const instance = sql.prepare("SELECT value FROM system_metadata WHERE key='instance_id'").get();
    assert.ok(instance);
    const cipher = new RuntimeSecretCipher(key, String(instance.value));
    const metadata = sql.prepare("SELECT value FROM system_metadata WHERE key='epay_configured_channels'").get();
    assert.ok(metadata);
    const marker = JSON.parse(String(metadata.value)) as { alipayChannelId: number; wechatChannelId: number; certificateSha256: string };
    const readChannel = (id: number) => {
      const raw = readEncryptedChannelConfig(sql, cipher, id);
      assert.ok(raw);
      return JSON.parse(raw) as Record<string, string>;
    };
    const alipay = readChannel(marker.alipayChannelId);
    const bindings = sql.prepare("SELECT DISTINCT app_id,seller_id,platform_public_key FROM epay_alipay_bindings").all();
    assert.equal(bindings.length, 1);
    const binding = bindings[0]!;
    assert.equal(alipay.appId, binding.app_id);
    const privateKey = createPrivateKey(alipay.privateKey!);
    const account = verifyAlipayQueryAccount({ appId: String(binding.app_id), sellerId: String(binding.seller_id),
      platformPublicKey: String(binding.platform_public_key), privateKey,
      certificate: readFileSync(certificateFile, "utf8"), certificateSha256: marker.certificateSha256 }, Date.now());
    const sample = (id: number) => {
      const order = sql.prepare("SELECT trade_no,api_trade_no,money_cents FROM epay_orders WHERE channel_id=? AND status='PAID' AND api_trade_no IS NOT NULL ORDER BY paid_at DESC,trade_no DESC LIMIT 1").get(id);
      assert.ok(order, "paid channel sample is unavailable");
      return { tradeNo: String(order.trade_no), providerTradeNo: String(order.api_trade_no), amountCents: Number(order.money_cents) };
    };
    phase = "alipay_query";
    const alipayOrder = sample(marker.alipayChannelId);
    const signed = buildAlipayTradeQuery(alipayOrder.tradeNo, { appId: account.appId, privateKey,
      ...(alipay.appCertSn ? { appCertSn: alipay.appCertSn } : {}), ...(alipay.rootCertSn ? { alipayRootCertSn: alipay.rootCertSn } : {}) });
    const response = await new NodeV3Transport().request(signed, { timeoutMilliseconds: 10_000 });
    const verified = verifyAlipayQueryEvidence(response, { ...alipayOrder, appId: account.appId, sellerId: account.sellerId, platformPublicKey: String(binding.platform_public_key) }, Date.now(), account);
    assert.ok(verified.evidence);
    assert.equal(verified.evidence.providerTradeNo, alipayOrder.providerTradeNo);
    phase = "wechat_query";
    const wechatOrder = sample(marker.wechatChannelId);
    const wechat = await observeLegacyWechatPayment({ config: readChannel(marker.wechatChannelId), ...wechatOrder, transport: fetch });
    assert.equal(wechat.state, "SUCCESS");
    sql.exec("COMMIT");
    phase = "report";
    const report = { version: 1, checkedAt: new Date().toISOString(), readOnly: true, scope: "one historical paid order per configured channel",
      alipay: { signatureVerified: true, identityVerified: true, exactAmountVerified: true, transactionVerified: true, state: verified.tradeStatus, orderSha256: digest(alipayOrder.tradeNo) },
      wechat: { signatureVerified: true, identityVerified: true, exactAmountVerified: true, transactionVerified: true, state: wechat.state, orderSha256: digest(wechatOrder.tradeNo) },
      providerQueries: 2, paymentRequests: 0, refundRequests: 0, callbackDeliveries: 0, databaseWrites: 0 };
    const bytes = JSON.stringify(report, null, 2) + "\n";
    writeFileSync(reportFile, bytes, { flag: "wx", mode: 0o600, flush: true });
    console.log(JSON.stringify({ verified: true, reportSha256: digest(bytes), ...report }));
  } finally { sql.close(); key.fill(0); }
}

verifyChannels().catch(() => {
  console.error(JSON.stringify({ verified: false, phase, error: "channel_readonly_verification_failed" }));
  process.exitCode = 1;
});
