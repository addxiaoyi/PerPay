import { randomBytes, type KeyObject } from "node:crypto";
import type { AppDatabase } from "../database/database.ts";
import type { V3Transport } from "../infrastructure/alipay/types.ts";
import { signV3Request, verifyV3Response } from "../infrastructure/alipay/v3.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { readBoundedBody } from "./main-order-auth.ts";
import { requireAlipayQueryAccount, type AlipayQueryAccount } from "./alipay-query-account.ts";
import { alipaySigningFingerprint } from "./isolated-alipay-client.ts";
import { activeWechatSigningKey, signWechatRequest } from "./wechat-signing-keys.ts";
import { verifyAlipayRefundQuery, verifyWechatRefundResponse } from "./refund-evidence.ts";
import { deferRefund, settleRefund, type RefundLease } from "./refund-queue.ts";
import { refundIdentity, refundRow } from "./refund-store.ts";
import { readConfirmedOrder } from "./confirmed-order.ts";

type Options = {
  database: Pick<AppDatabase, "read" | "write" | "instanceId">;
  masterKey: Uint8Array; clock?: () => number;
  alipay?: { privateKey: KeyObject | string; account: AlipayQueryAccount; transport: V3Transport; appCertSn?: string; alipayRootCertSn?: string };
  wechat?: { signingKeyId: string; transport: typeof fetch };
};
const money = (cents: number) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;

export async function processNativeRefund(options: Options, lease: RefundLease): Promise<void> {
  const clock = options.clock ?? Date.now, now = clock();
  const { database } = options;
  const check = () => database.read(sql => {
    const row = refundRow(sql, lease.refundNo);
    if (row.lease_token !== lease.leaseToken || row.lease_until !== lease.leaseUntil || lease.leaseUntil <= clock() ||
        Object.entries(refundIdentity(row)).some(([key, value]) => lease[key as keyof RefundLease] !== value) ||
        !readConfirmedOrder(sql, lease.tradeNo, lease.merchantId)) throw new Error("refund lease or payment identity differs");
  });
  check();
  if (lease.provider === "alipay") {
    const channel = options.alipay;
    if (!channel || alipaySigningFingerprint(channel.privateKey) !== channel.account.signingFingerprint) throw new Error("refund Alipay signing identity is unavailable");
    const intent = database.read(sql => sql.prepare("SELECT app_id,seller_id,platform_public_key FROM epay_alipay_intents WHERE trade_no=? AND merchant_id=?").get(lease.tradeNo, lease.merchantId));
    if (!intent || intent.seller_id !== lease.providerAccount) throw new Error("refund Alipay account differs");
    const expected = { appId: String(intent.app_id), sellerId: String(intent.seller_id), platformPublicKey: String(intent.platform_public_key) };
    requireAlipayQueryAccount(channel.account, expected, now);
    const query = lease.action === "QUERY";
    const payload = { trade_no: lease.providerTradeNo, out_request_no: lease.refundNo,
      ...(query ? { query_options: ["refund_detail_item_list"] } : { refund_amount: money(lease.amountCents), refund_reason: lease.reason }) };
    const signed = signV3Request({ method: "POST", path: query ? "/v3/alipay/trade/fastpay/refund/query" : "/v3/alipay/trade/refund", body: JSON.stringify(payload) },
      { appId: expected.appId, privateKey: channel.privateKey, ...(channel.appCertSn ? { appCertSn: channel.appCertSn } : {}), ...(channel.alipayRootCertSn ? { alipayRootCertSn: channel.alipayRootCertSn } : {}), clock });
    const response = await channel.transport.request(signed, { timeoutMilliseconds: 10_000 });
    check();
    if (!query) {
      verifyV3Response(response, expected.platformPublicKey);
      // Query with the original request number after the provider's recommended delay.
      deferRefund(database, lease, clock(), "awaiting_refund_query");
      return;
    }
    database.write(sql => {
      requireAlipayQueryAccount(channel.account, expected, clock());
      settleRefund({ read: action => action(sql), write: action => action(sql) }, lease,
        verifyAlipayRefundQuery(lease, response, channel.account, expected.platformPublicKey, clock()), clock());
    });
    return;
  }
  const channel = options.wechat;
  if (!channel) throw new Error("refund WeChat signing identity is unavailable");
  const cipher = new RuntimeSecretCipher(options.masterKey, database.instanceId());
  const intent = database.read(sql => sql.prepare("SELECT app_id,provider_merchant_id FROM epay_wechat_intents WHERE trade_no=? AND merchant_id=?").get(lease.tradeNo, lease.merchantId));
  if (!intent || intent.provider_merchant_id !== lease.providerAccount) throw new Error("refund WeChat account differs");
  const method = lease.action === "SUBMIT" ? "POST" : "GET";
  const path = "/v3/refund/domestic/refunds" + (method === "GET" ? `/${encodeURIComponent(lease.refundNo)}` : "");
  const body = method === "GET" ? "" : JSON.stringify({ transaction_id: lease.providerTradeNo, out_refund_no: lease.refundNo, reason: lease.reason,
    amount: { refund: lease.amountCents, total: lease.totalCents, currency: "CNY" } });
  const nonce = randomBytes(16).toString("hex"), timestamp = String(Math.floor(now / 1000));
  const signature = database.read(sql => signWechatRequest(sql, cipher, channel.signingKeyId, String(intent.app_id), lease.providerAccount, now,
    `${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`));
  const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${lease.providerAccount}",nonce_str="${nonce}",signature="${signature.signature}",timestamp="${timestamp}",serial_no="${signature.serial}"`;
  const response = await channel.transport(new URL(path, "https://api.mch.weixin.qq.com"), { method,
    ...(method === "POST" ? { body } : {}), headers: { "content-type": "application/json", accept: "application/json", authorization },
    redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (response.status !== 200 || !response.headers.get("content-type")?.includes("application/json")) {
    await response.body?.cancel();
    throw new Error("refund WeChat response unavailable");
  }
  const raw = await readBoundedBody(response.body, 65_536), verifiedAt = clock();
  check();
  database.write(sql => {
    activeWechatSigningKey(sql, channel.signingKeyId, String(intent.app_id), lease.providerAccount, verifiedAt);
    const credentials = sql.prepare(`SELECT c.platform_key,c.platform_key_id FROM epay_wechat_credentials c
      LEFT JOIN epay_wechat_credential_revocations r ON r.credential_id=c.credential_id
      WHERE c.app_id=? AND c.provider_merchant_id=? AND c.platform_key_id=? AND c.valid_from<=? AND c.valid_until>? AND c.created_at<=? AND r.credential_id IS NULL LIMIT 2`)
      .all(String(intent.app_id), lease.providerAccount, response.headers.get("wechatpay-serial") ?? "", verifiedAt, verifiedAt, verifiedAt);
    if (credentials.length !== 1) throw new Error("refund WeChat verification identity unavailable");
    const proof = verifyWechatRefundResponse(lease, raw, response.headers, { platformKey: String(credentials[0]!.platform_key), platformKeyId: String(credentials[0]!.platform_key_id) }, verifiedAt);
    settleRefund({ read: action => action(sql), write: action => action(sql) }, lease, proof, verifiedAt);
  });
}
