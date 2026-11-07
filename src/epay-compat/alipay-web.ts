import { randomUUID, sign, type KeyObject } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AppDatabase } from "../database/database.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { alipaySigningFingerprint } from "./isolated-alipay-client.ts";
import { requireAlipayQueryAccount, type AlipayQueryAccount } from "./alipay-query-account.ts";
import { issueCheckoutToken } from "./isolated-checkout-status.ts";
import { expirationMinutes, orderAcceptsPayment } from "./order-expiration.ts";

type Database = Pick<AppDatabase, "read" | "write" | "instanceId">;
export type AlipayWebOptions = { database: Database; masterKey: Uint8Array; privateKey: KeyObject | string; account: AlipayQueryAccount;
  notifyUrl: string; returnBase: string; appCertSn?: string; alipayRootCertSn?: string; clock?: () => number };

export function recordAlipayWebMode(sql: DatabaseSync, tradeNo: string, product: "pc" | "wap", now: number) {
  if (!sql.isTransaction || !Number.isSafeInteger(now) || !["pc", "wap"].includes(product)) throw new Error("invalid Alipay web mode");
  const existing = sql.prepare("SELECT product FROM epay_alipay_web_orders WHERE trade_no=?").get(tradeNo);
  if (existing) { if (existing.product !== product) throw new Error("Alipay web product differs"); return; }
  if (sql.prepare("SELECT 1 FROM epay_alipay_submissions WHERE trade_no=?").get(tradeNo)) throw new Error("existing Alipay submission has another product");
  sql.prepare("INSERT INTO epay_alipay_web_orders VALUES(?,?,?)").run(tradeNo, product, now);
}

export function readAlipayWebUrl(sql: DatabaseSync, cipher: RuntimeSecretCipher, tradeNo: string): string | null {
  const record = sql.prepare("SELECT nonce,ciphertext,authentication_tag FROM epay_alipay_web_links WHERE trade_no=?").get(tradeNo);
  if (!record) return null;
  const plain = cipher.decrypt(`epay:config:alipay-web:${tradeNo}`, 1, { cipherVersion: 1, nonce: Buffer.from(record.nonce as Uint8Array), ciphertext: Buffer.from(record.ciphertext as Uint8Array), authenticationTag: Buffer.from(record.authentication_tag as Uint8Array) });
  try {
    const url = new URL(plain.toString("utf8"));
    if (url.origin !== "https://openapi.alipay.com" || url.pathname !== "/gateway.do" || url.username || url.password || url.hash) throw new Error("stored Alipay web URL is invalid");
    return url.toString();
  } finally { plain.fill(0); }
}

// A signed redirect creates no channel-side order until the payer opens it.
export function prepareAlipayWebPayment(options: AlipayWebOptions, tradeNo: string) {
  const now = (options.clock ?? Date.now)(), fingerprint = alipaySigningFingerprint(options.privateKey);
  const cipher = new RuntimeSecretCipher(options.masterKey, options.database.instanceId());
  for (const path of [options.notifyUrl, options.returnBase]) {
    const url = new URL(path);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw new Error("invalid configured Alipay callback URL");
  }
  return options.database.write(sql => {
    const intent = sql.prepare(`SELECT i.*,o.name,o.created_at,o.status,w.product,b.signing_key_fingerprint FROM epay_alipay_intents i
      JOIN epay_orders o ON o.trade_no=i.trade_no AND o.merchant_id=i.merchant_id AND o.money_cents=i.amount_cents
      JOIN epay_alipay_orders r ON r.trade_no=i.trade_no JOIN epay_alipay_web_orders w ON w.trade_no=i.trade_no
      JOIN epay_alipay_bindings b ON b.client_id=r.client_id AND b.app_id=i.app_id AND b.seller_id=i.seller_id AND b.platform_public_key=i.platform_public_key
      JOIN epay_site_bindings s ON s.merchant_id=i.merchant_id AND s.client_id=r.client_id
      JOIN sites site ON site.client_id=r.client_id AND site.deleted_at IS NULL AND json_extract(site.configuration,'$.accepting_orders')=1
      JOIN epay_merchant_accounts m ON m.merchant_id=i.merchant_id AND m.enabled=1
      WHERE i.trade_no=? AND o.type_code='alipay'`).get(tradeNo);
    if (!intent || intent.status !== "PENDING" || fingerprint !== intent.signing_key_fingerprint || options.account.signingFingerprint !== fingerprint) throw new Error("Alipay web intent or signer is unavailable");
    requireAlipayQueryAccount(options.account, { appId: String(intent.app_id), sellerId: String(intent.seller_id), platformPublicKey: String(intent.platform_public_key) }, now);
    const minutes = expirationMinutes(sql, cipher);
    if (!orderAcceptsPayment(intent.created_at as number | bigint, now, minutes)) throw new Error("Alipay web order expired");
    const cached = readAlipayWebUrl(sql, cipher, tradeNo);
    if (cached) return cached;
    if (sql.prepare("SELECT 1 FROM epay_alipay_submissions WHERE trade_no=?").get(tradeNo)) throw new Error("Alipay order already submitted by another product");
    const amount = Number(intent.amount_cents), merchantId = Number(intent.merchant_id);
    if (!Number.isSafeInteger(amount) || amount < 1) throw new Error("invalid Alipay web amount");
    const token = issueCheckoutToken(options.masterKey, options.database.instanceId(), tradeNo, merchantId, now);
    const timestamp = new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
    const params: Record<string, string> = {
      app_id: String(intent.app_id), method: intent.product === "wap" ? "alipay.trade.wap.pay" : "alipay.trade.page.pay", format: "JSON",
      charset: "utf-8", sign_type: "RSA2", timestamp, version: "1.0", notify_url: options.notifyUrl,
      return_url: `${options.returnBase}?token=${encodeURIComponent(token)}`,
      biz_content: JSON.stringify({ out_trade_no: tradeNo, seller_id: String(intent.seller_id), total_amount: `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, "0")}`,
        subject: String(intent.name), product_code: intent.product === "wap" ? "QUICK_WAP_WAY" : "FAST_INSTANT_TRADE_PAY", timeout_express: `${Math.max(1, Math.ceil((Number(intent.created_at) + minutes * 60000 - now) / 60000))}m` }),
    };
    if (options.appCertSn || options.alipayRootCertSn) {
      if (!options.appCertSn || !options.alipayRootCertSn) throw new Error("incomplete Alipay certificate serials");
      params.app_cert_sn = options.appCertSn; params.alipay_root_cert_sn = options.alipayRootCertSn;
    }
    const canonical = Object.keys(params).sort().map(key => `${key}=${params[key]}`).join("&");
    params.sign = sign("RSA-SHA256", Buffer.from(canonical), options.privateKey).toString("base64");
    const url = `https://openapi.alipay.com/gateway.do?${new URLSearchParams(params)}`, attemptId = randomUUID();
    const encrypted = cipher.encrypt(`epay:config:alipay-web:${tradeNo}`, 1, url);
    sql.prepare("INSERT INTO epay_alipay_submissions VALUES(?,?,'UNCERTAIN',NULL,NULL,?,?)").run(tradeNo, attemptId, now, now);
    sql.prepare("INSERT INTO epay_alipay_web_links VALUES(?,?,?,?,?,?)").run(tradeNo, attemptId, encrypted.nonce, encrypted.ciphertext, encrypted.authenticationTag, now);
    return url;
  });
}
