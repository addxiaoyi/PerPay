import { createPrivateKey, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { readEncryptedChannelConfig } from "../src/epay-compat/channel-config.ts";
import { buildAlipayTradeQuery } from "../src/epay-compat/alipay-query.ts";
import { verifyAlipayQueryEvidence } from "../src/epay-compat/alipay-query-evidence.ts";
import { verifyAlipayQueryAccount } from "../src/epay-compat/alipay-query-account.ts";
import { NodeV3Transport } from "../src/infrastructure/alipay/node-transport.ts";
import { signV3Request, verifyV3Response } from "../src/infrastructure/alipay/v3.ts";
import { signWechatRequest } from "../src/epay-compat/wechat-signing-keys.ts";
import { observeWechatQuery, verifyWechatSignature } from "../src/epay-compat/wechat-evidence.ts";
import { readBoundedBody } from "../src/epay-compat/main-order-auth.ts";
import { appendAuditEvent } from "../src/database/identity-store.ts";

type Probe = { channel: "alipay_web" | "wechat_native"; merchantOrderId: string; orderId: string; tradeNo: string; summary: Record<string, unknown>; closure?: Record<string, unknown> };
const [root, filename] = process.argv.slice(2);
if (process.env.STARPAY_CLOSE_UNPAID_PROBES !== "1" || !root || !/^\/var\/lib\/perpay-candidate-\d{8}[a-z]$/.test(root) || !filename || !/^\/root\/perpay-recovery-[a-z0-9-]+\/collections-probe-[a-z0-9-]+\.json$/.test(filename)) throw new Error("explicit probe closure required");
process.umask(0o077);
const manifest = JSON.parse(readFileSync(filename, "utf8")) as { purpose: string; amountCents: number; probes: Probe[] };
if (manifest.purpose !== "unpaid-channel-verification" || manifest.amountCents !== 1 || manifest.probes.length !== 2) throw new Error("probe manifest differs");
const sql = new DatabaseSync(root + "/data/perpay.sqlite3", { enableForeignKeyConstraints: true, timeout: 5000 });
const master = Buffer.from(readFileSync(root + "/secrets/master-key", "utf8").trim(), "hex");
try {
  const cipher = new RuntimeSecretCipher(master, String(sql.prepare("SELECT value FROM system_metadata WHERE key='instance_id'").get()?.value));
  const marker = JSON.parse(String(sql.prepare("SELECT value FROM system_metadata WHERE key='epay_configured_channels'").get()?.value));
  for (const probe of manifest.probes) {
    if (!/^SPV_(alipay_web|wechat_native)_[a-f0-9]{20}$/.test(probe.merchantOrderId)) throw new Error("not a verification order");
    const current = sql.prepare(`SELECT o.status FROM epay_orders o JOIN epay_main_native_orders n ON n.trade_no=o.trade_no
      WHERE n.order_id=? AND o.trade_no=? AND o.out_trade_no=? AND o.money_cents=1 AND o.merchant_id=1001`).get(probe.orderId, probe.tradeNo, probe.merchantOrderId);
    if (!current || !["PENDING", "CLOSED"].includes(String(current.status))) throw new Error("probe has unexpected financial state");
    let observedState: string, beforeState: string;
    if (probe.channel === "alipay_web") {
      const config = JSON.parse(readEncryptedChannelConfig(sql, cipher, marker.alipayChannelId)!);
      const intent = sql.prepare("SELECT * FROM epay_alipay_intents WHERE trade_no=?").get(probe.tradeNo)!;
      const privateKey = createPrivateKey(config.privateKey), platformPublicKey = String(intent.platform_public_key);
      const expected = { appId: String(intent.app_id), sellerId: String(intent.seller_id), platformPublicKey, tradeNo: probe.tradeNo, amountCents: 1 };
      const account = verifyAlipayQueryAccount({ ...expected, privateKey, certificate: readFileSync(root + "/secrets/alipay-account.crt", "utf8"), certificateSha256: marker.certificateSha256 }, Date.now());
      const signer = { appId: expected.appId, privateKey, appCertSn: config.appCertSn, alipayRootCertSn: config.rootCertSn }, transport = new NodeV3Transport();
      const query = async () => verifyAlipayQueryEvidence(await transport.request(buildAlipayTradeQuery(probe.tradeNo, signer), { timeoutMilliseconds: 10000 }), expected, Date.now(), account);
      const before = await query(); beforeState = before.tradeStatus;
      if (before.evidence) throw new Error("probe was paid; do not close or refund");
      if (["WAIT_BUYER_PAY", "TRADE_NOT_EXIST"].includes(beforeState)) {
        const response = await transport.request(signV3Request({ method: "POST", path: "/v3/alipay/trade/close", body: JSON.stringify({ out_trade_no: probe.tradeNo }) }, signer), { timeoutMilliseconds: 10000 });
        const value = JSON.parse(verifyV3Response(response, platformPublicKey).body);
        const closed = response.status === 200 && value.out_trade_no === probe.tradeNo;
        const absent = response.status === 400 && value.code === "ACQ.TRADE_NOT_EXIST";
        if (!closed && !absent) throw new Error("Alipay probe close not acknowledged");
      }
      const after = await query();
      if (after.evidence || !["TRADE_CLOSED", "TRADE_NOT_EXIST"].includes(after.tradeStatus)) throw new Error("Alipay probe is not verified closed or absent");
      observedState = after.tradeStatus;
    } else {
      const intent = sql.prepare("SELECT * FROM epay_wechat_intents WHERE trade_no=?").get(probe.tradeNo)!;
      const appId = String(intent.app_id), merchantId = String(intent.provider_merchant_id);
      async function call(close: boolean) {
        const path = `/v3/pay/transactions/out-trade-no/${probe.tradeNo}${close ? "/close" : `?mchid=${encodeURIComponent(merchantId)}`}`;
        const method = close ? "POST" : "GET", body = close ? JSON.stringify({ mchid: merchantId }) : "";
        const now = Date.now(), timestamp = String(Math.floor(now / 1000)), nonce = randomBytes(16).toString("hex");
        const signed = signWechatRequest(sql, cipher, marker.signingKeyId, appId, merchantId, now, `${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`);
        const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${merchantId}",nonce_str="${nonce}",signature="${signed.signature}",timestamp="${timestamp}",serial_no="${signed.serial}"`;
        const response = await fetch("https://api.mch.weixin.qq.com"+path, { method, headers: { authorization, "content-type": "application/json", accept: "application/json" }, ...(body ? { body } : {}), redirect: "error", signal: AbortSignal.timeout(10000) });
        const raw = response.body ? await readBoundedBody(response.body, 65536) : Buffer.alloc(0), at = Date.now();
        const credentials = sql.prepare(`SELECT c.platform_key,c.platform_key_id FROM epay_wechat_credentials c LEFT JOIN epay_wechat_credential_revocations r ON r.credential_id=c.credential_id
          WHERE c.app_id=? AND c.provider_merchant_id=? AND c.platform_key_id=? AND c.valid_from<=? AND c.valid_until>? AND r.credential_id IS NULL`).all(appId, merchantId, response.headers.get("wechatpay-serial") ?? "", at, at);
        if (credentials.length !== 1) throw new Error("WeChat probe response key differs");
        const expected = { appId, merchantId, tradeNo: probe.tradeNo, amountCents: 1, platformKey: String(credentials[0]!.platform_key), platformKeyId: String(credentials[0]!.platform_key_id), now: at };
        verifyWechatSignature(raw, response.headers, expected, at);
        if (close) { if (response.status !== 204) throw new Error("WeChat close not acknowledged"); return null; }
        if (response.status !== 200) throw new Error("WeChat probe query unavailable");
        return observeWechatQuery(raw, response.headers, expected);
      }
      const before = await call(false); beforeState = before!.state;
      if (!["NOTPAY", "CLOSED"].includes(beforeState)) throw new Error("WeChat probe is not unpaid");
      if (beforeState === "NOTPAY") await call(true);
      const after = await call(false);
      if (after?.state !== "CLOSED") throw new Error("WeChat probe is not verified closed");
      observedState = after.state;
    }
    sql.exec("BEGIN IMMEDIATE");
    try {
      const changed = sql.prepare(`UPDATE epay_orders SET status='CLOSED',updated_at=? WHERE trade_no=? AND out_trade_no=? AND merchant_id=1001 AND money_cents=1
        AND status='PENDING' AND paid_at IS NULL AND api_trade_no IS NULL
        AND NOT EXISTS(SELECT 1 FROM epay_balance_ledger l WHERE l.entry_id='epay_payment:'||epay_orders.trade_no)
        AND NOT EXISTS(SELECT 1 FROM epay_callback_jobs j WHERE j.trade_no=epay_orders.trade_no)`)
        .run(Date.now(), probe.tradeNo, probe.merchantOrderId);
      if (Number(changed.changes) === 1) appendAuditEvent(sql, { occurredAt: Date.now(), actorType: "SYSTEM", actorId: "payment-query", action: "epay.order.closed", outcome: "SUCCESS", subjectType: "epay_order", subjectId: probe.tradeNo,
        details: { provider: probe.channel === "alipay_web" ? "alipay" : "wxpay", observedState, signatureVerified: true, purpose: "unpaid-channel-verification" } });
      if (sql.prepare("SELECT status FROM epay_orders WHERE trade_no=?").get(probe.tradeNo)?.status !== "CLOSED") throw new Error("probe order changed before closure");
      sql.exec("COMMIT");
    } catch (error) { sql.exec("ROLLBACK"); throw error; }
    probe.closure = { beforeState, afterState: observedState, responseSignatureVerified: true, channelIdentityVerified: true, amountCents: 1,
      localStatus: "CLOSED", ledgerEntries: Number(sql.prepare("SELECT count(*) n FROM epay_balance_ledger WHERE entry_id=?").get("epay_payment:"+probe.tradeNo)?.n),
      callbacks: Number(sql.prepare("SELECT count(*) n FROM epay_callback_jobs WHERE trade_no=?").get(probe.tradeNo)?.n), closedAt: Date.now() };
    writeFileSync(filename, JSON.stringify(manifest), { mode: 0o600, flush: true });
    console.log(JSON.stringify({ channel: probe.channel, ...probe.closure, actualPayments: 0, refundRequests: 0 }));
  }
} finally { sql.close(); master.fill(0); }
