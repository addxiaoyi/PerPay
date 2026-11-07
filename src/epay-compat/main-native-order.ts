import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { AppDatabase } from "../database/database.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { createExactAlipayOrder } from "./exact-alipay-order.ts";
import { createExactWechatOrder } from "./exact-wechat-order.ts";
import { readCurrentMainPayment } from "./main-delta-store.ts";
import { readMerchantSecret } from "./merchant-secret.ts";
import { parseLegacyCents } from "./money.ts";
import { epaySign } from "./sign.ts";
import { issueMainOrderAccess } from "./main-order-access.ts";
import { recordAlipayWebMode } from "./alipay-web.ts";

type Database = Pick<AppDatabase, "read" | "write" | "instanceId">;
export type MainOrderIdentity = Readonly<{ merchantId: string; epayMerchantId: number; apiId: string; callbackUrl: string; callbackSecret: string }>;
const inputSchema = z.object({
  merchantOrderId: z.string().trim().regex(/^[A-Za-z0-9_-]{3,64}$/),
  amount: z.union([z.string().max(32), z.number().finite()]),
  channel: z.enum(["alipay_scan", "alipay_web", "wechat_native"]),
  subject: z.string().trim().min(1).max(127).regex(/^[^\x00-\x1f\x7f]+$/).default("网站订单"),
  notifyUrl: z.string().trim().max(2048).default(""),
  returnUrl: z.string().trim().max(2048).default(""),
}).strict();
type NativeRow = { trade_no: string; order_id: string; main_merchant_id: string; main_api_id: string; merchant_id: number; channel: "alipay_scan" | "wechat_native"; callback_id: string; nonce: Uint8Array; ciphertext: Uint8Array; authentication_tag: Uint8Array; request_fingerprint: string };

export class MainOrderConflict extends Error {}
export class LegacyMainOrder extends Error {}
export class MainOrderInputError extends Error {}

function secretName(row: Pick<NativeRow, "trade_no" | "merchant_id" | "main_api_id">) {
  return `epay:config:main-callback:${row.merchant_id}:${row.main_api_id}:${row.trade_no}` as const;
}

export function readMainOrderContract(sql: DatabaseSync, cipher: RuntimeSecretCipher, tradeNo: string, merchantId: number) {
  const row = sql.prepare("SELECT * FROM epay_main_native_orders WHERE trade_no=?").get(tradeNo) as NativeRow | undefined;
  if (!row) return null;
  if (Number(row.merchant_id) !== merchantId) throw new Error("main callback merchant differs");
  const plain = cipher.decrypt(secretName(row), 1, { cipherVersion: 1, nonce: Buffer.from(row.nonce), ciphertext: Buffer.from(row.ciphertext), authenticationTag: Buffer.from(row.authentication_tag) });
  try {
    const web = sql.prepare("SELECT 1 FROM epay_alipay_web_orders WHERE trade_no=?").get(tradeNo);
    return { orderId: row.order_id, merchantId: row.main_merchant_id, apiId: row.main_api_id, channel: web ? "alipay_web" : row.channel, callbackId: row.callback_id, secret: plain.toString("utf8") };
  } finally { plain.fill(0); }
}

// The callback contract must commit before a provider can observe the new intent.
export function createMainNativeOrder(options: { database: Database; masterKey: Uint8Array; identity: MainOrderIdentity; input: unknown; now: number; wechatCredentialId?: string }) {
  const { database, masterKey, identity, now } = options;
  let input: z.infer<typeof inputSchema>, amountCents: number;
  try {
    input = inputSchema.parse(options.input);
    amountCents = parseLegacyCents(String(input.amount));
    if (amountCents < 1) throw new Error("amount must be positive");
  } catch (cause) { throw new MainOrderInputError("invalid main order input or unsupported channel", { cause }); }
  if (!Number.isSafeInteger(now) || now < 0 || !identity.callbackSecret || identity.callbackSecret.length > 4096 || !/^[A-Za-z0-9_-]{1,80}$/.test(identity.apiId)) throw new Error("main order identity is unavailable");
  const cipher = new RuntimeSecretCipher(masterKey, database.instanceId());
  const fingerprint = createHash("sha256").update(JSON.stringify([identity.merchantId, identity.apiId, input.merchantOrderId, amountCents, input.channel, input.subject, input.notifyUrl, input.returnUrl])).digest("hex");
  return database.write(sql => {
    const bound = sql.prepare(`SELECT 1 FROM epay_merchant_bindings b JOIN epay_merchant_accounts m ON m.merchant_id=b.epay_merchant_id AND m.enabled=1
      WHERE b.main_merchant_id=? AND b.main_api_id=? AND b.epay_merchant_id=?`).get(identity.merchantId, identity.apiId, identity.epayMerchantId);
    if (!bound) throw new Error("main order binding changed");
    const existing = sql.prepare(`SELECT n.*,o.notify_url FROM epay_orders o LEFT JOIN epay_main_native_orders n ON n.trade_no=o.trade_no
      WHERE o.merchant_id=? AND o.out_trade_no=?`).get(identity.epayMerchantId, input.merchantOrderId) as (NativeRow & { notify_url: string }) | undefined;
    if (existing && (!existing.order_id || existing.request_fingerprint !== fingerprint || existing.main_merchant_id !== identity.merchantId || existing.main_api_id !== identity.apiId)) throw new MainOrderConflict("main order conflict");
    if (!existing) {
      const legacy = readCurrentMainPayment(sql, cipher).payment.orders.some(row => row.merchantId === identity.merchantId && row.merchantOrderId === input.merchantOrderId);
      if (legacy) throw new LegacyMainOrder("legacy order remains owned by the previous gateway");
    }
    const params = {
      pid: String(identity.epayMerchantId), type: input.channel === "wechat_native" ? "wxpay" : "alipay", out_trade_no: input.merchantOrderId,
      money: `${Math.floor(amountCents / 100)}.${String(amountCents % 100).padStart(2, "0")}`, name: input.subject,
      notify_url: existing?.notify_url ?? (input.notifyUrl || identity.callbackUrl), return_url: input.returnUrl, clientip: "127.0.0.1", device: "pc",
    };
    const signed = { ...params, sign: epaySign(params, readMerchantSecret(sql, cipher, identity.epayMerchantId)), sign_type: "MD5" };
    // Reuse the exact-order validator inside the caller's transaction, never nest BEGIN.
    const transaction = { instanceId: () => database.instanceId(), write: <T>(operation: (db: DatabaseSync) => T) => operation(sql) };
    const order = input.channel !== "wechat_native"
      ? createExactAlipayOrder(transaction, masterKey, signed, "api", now)
      : createExactWechatOrder(transaction, masterKey, signed, "api", options.wechatCredentialId ?? "", now);
    if (input.channel === "alipay_web") recordAlipayWebMode(sql, order.tradeNo, "pc", now);
    if (existing) return { ...order, orderId: existing.order_id, params: signed, access: issueMainOrderAccess(sql, existing.order_id, identity.epayMerchantId, now) };
    const orderId = randomUUID(), callbackId = randomUUID();
    const sealed = cipher.encrypt(secretName({ trade_no: order.tradeNo, merchant_id: identity.epayMerchantId, main_api_id: identity.apiId }), 1, identity.callbackSecret);
    sql.prepare(`INSERT INTO epay_main_native_orders VALUES (?,?,?,?,?,?,'main_form_hmac_v1',?,?,?,?,?,?)`).run(
      order.tradeNo, orderId, identity.merchantId, identity.apiId, identity.epayMerchantId, input.channel === "alipay_web" ? "alipay_scan" : input.channel, fingerprint, callbackId,
      sealed.nonce, sealed.ciphertext, sealed.authenticationTag, now);
    return { ...order, orderId, params: signed, access: issueMainOrderAccess(sql, orderId, identity.epayMerchantId, now) };
  });
}
