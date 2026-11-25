import { createHash, createPrivateKey, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { readEncryptedChannelConfig } from "../src/epay-compat/channel-config.ts";
import { buildAlipayPrecreate } from "../src/epay-compat/alipay-precreate.ts";
import { buildAlipayTradeQuery } from "../src/epay-compat/alipay-query.ts";
import { verifyV3Response, signV3Request } from "../src/infrastructure/alipay/v3.ts";
import { NodeV3Transport } from "../src/infrastructure/alipay/node-transport.ts";

const [root, destination] = process.argv.slice(2);
if (process.env.STARPAY_UNPAID_CHANNEL_TEST !== "1" || !root || !/^\/var\/lib\/perpay-candidate-\d{8}[a-z]$/.test(root) || !destination || !/^\/root\/perpay-recovery-[a-z0-9-]+\/qr-probe-[a-z0-9-]+\.json$/.test(destination) || existsSync(destination)) throw new Error("explicit unpaid probe destination required");
process.umask(0o077);
const sql = new DatabaseSync(root + "/data/perpay.sqlite3", { readOnly: true });
const master = Buffer.from(readFileSync(root + "/secrets/master-key", "utf8").trim(), "hex");
const now = Date.now(), tradeNo = `SPV${randomUUID().replaceAll("-", "").slice(0, 28)}`;
const safeCode = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : null;
try {
  const cipher = new RuntimeSecretCipher(master, String(sql.prepare("SELECT value FROM system_metadata WHERE key='instance_id'").get()?.value));
  const marker = JSON.parse(String(sql.prepare("SELECT value FROM system_metadata WHERE key='epay_configured_channels'").get()?.value));
  const config = JSON.parse(readEncryptedChannelConfig(sql, cipher, marker.alipayChannelId)!);
  const binding = sql.prepare("SELECT DISTINCT app_id,seller_id,platform_public_key FROM epay_alipay_bindings").all();
  if (binding.length !== 1 || binding[0]!.app_id !== config.appId) throw new Error("Alipay probe identity differs");
  const signer = { appId: config.appId, privateKey: createPrivateKey(config.privateKey), appCertSn: config.appCertSn, alipayRootCertSn: config.rootCertSn };
  const transport = new NodeV3Transport();
  const checkpoint = { tradeNo, amountCents: 1, startedAt: now, phase: "reserved", provider: "alipay" };
  writeFileSync(destination, JSON.stringify(checkpoint), { mode: 0o600, flag: "wx", flush: true });
  const response = await transport.request(buildAlipayPrecreate({ tradeNo, amountCents: 1, subject: "StarPAY通道核验勿付款", notifyUrl: "https://star-web.top/pay/epay/alipay/notify", sellerId: String(binding[0]!.seller_id) }, signer), { timeoutMilliseconds: 10000 });
  const verified = verifyV3Response(response, String(binding[0]!.platform_public_key));
  const payload = JSON.parse(verified.body);
  const seal = cipher.encrypt(`epay:config:probe:${tradeNo}`, 1, JSON.stringify({ response: payload, request: checkpoint }));
  const encryptedResponse = { nonce: seal.nonce.toString("base64"), ciphertext: seal.ciphertext.toString("base64"), tag: seal.authenticationTag.toString("base64") };
  const qr = typeof payload.qr_code === "string" ? new URL(payload.qr_code) : null;
  const report = { status: response.status, code: safeCode(payload.code), signatureVerified: true, sameOrder: payload.out_trade_no === tradeNo,
    qrReturned: Boolean(qr), qrScheme: qr?.protocol ?? null, qrHost: qr?.hostname ?? null, amountCents: 1,
    paymentRequests: 0, refundRequests: 0, precreateRequests: 1, databaseWrites: 0, closed: false };
  writeFileSync(destination, JSON.stringify({ ...checkpoint, phase: "observed", report, encryptedResponse }), { mode: 0o600, flush: true });
  if (response.status === 200 && qr && report.sameOrder) {
    const close = await transport.request(signV3Request({ method: "POST", path: "/v3/alipay/trade/close", body: JSON.stringify({ out_trade_no: tradeNo }) }, signer), { timeoutMilliseconds: 10000 });
    const closed = JSON.parse(verifyV3Response(close, String(binding[0]!.platform_public_key)).body);
    const query = await transport.request(buildAlipayTradeQuery(tradeNo, signer), { timeoutMilliseconds: 10000 });
    const state = JSON.parse(verifyV3Response(query, String(binding[0]!.platform_public_key)).body);
    report.closed = close.status === 200 && closed.out_trade_no === tradeNo && (state.trade_status === "TRADE_CLOSED" || state.code === "ACQ.TRADE_NOT_EXIST") && state.out_trade_no === tradeNo;
    if (!report.closed) throw new Error("unpaid probe closure requires investigation");
  }
  writeFileSync(destination, JSON.stringify({ ...checkpoint, phase: "complete", report, encryptedResponse, finishedAt: Date.now() }), { mode: 0o600, flush: true });
  console.log(JSON.stringify({ ...report, reportSha256: createHash("sha256").update(readFileSync(destination)).digest("hex") }));
} finally { sql.close(); master.fill(0); }
