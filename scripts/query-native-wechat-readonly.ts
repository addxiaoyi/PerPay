import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { signWechatRequest } from "../src/epay-compat/wechat-signing-keys.ts";
import { observeWechatQuery } from "../src/epay-compat/wechat-evidence.ts";
import { readBoundedBody } from "../src/epay-compat/main-order-auth.ts";

const root = process.argv[2];
if (process.env.EPAY_READONLY_AUDIT !== "1" || !root || !/^\/var\/lib\/perpay-candidate-\d{8}[a-z]$/.test(root)) throw new Error("explicit audit root required");
const sql = new DatabaseSync(join(root, "data/perpay.sqlite3"), { readOnly: true });
const key = Buffer.from(readFileSync(join(root, "secrets/master-key"), "utf8").trim(), "hex");
try {
  sql.exec("BEGIN");
  const cipher = new RuntimeSecretCipher(key, String(sql.prepare("SELECT value FROM system_metadata WHERE key='instance_id'").get()?.value));
  const marker = JSON.parse(String(sql.prepare("SELECT value FROM system_metadata WHERE key='epay_configured_channels'").get()?.value));
  const order = sql.prepare(`SELECT i.trade_no,i.app_id,i.provider_merchant_id,i.amount_cents FROM epay_wechat_intents i JOIN epay_orders o ON o.trade_no=i.trade_no WHERE o.status='PENDING' ORDER BY o.created_at DESC LIMIT 1`).get();
  if (!order) { console.log(JSON.stringify({ pendingNativeWechat: 0, databaseWrites: 0 })); }
  else {
    const now = Date.now(), nonce = randomBytes(16).toString("hex"), timestamp = String(Math.floor(now / 1000));
    const url = new URL(`/v3/pay/transactions/out-trade-no/${String(order.trade_no)}`, "https://api.mch.weixin.qq.com");
    url.searchParams.set("mchid", String(order.provider_merchant_id));
    const signed = signWechatRequest(sql, cipher, marker.signingKeyId, String(order.app_id), String(order.provider_merchant_id), now, `GET\n${url.pathname}${url.search}\n${timestamp}\n${nonce}\n\n`);
    const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${order.provider_merchant_id}",nonce_str="${nonce}",signature="${signed.signature}",timestamp="${timestamp}",serial_no="${signed.serial}"`;
    const response = await fetch(url, { headers: { authorization, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10000) });
    if (response.status !== 200) throw new Error("native query unavailable");
    const raw = await readBoundedBody(response.body, 65536), verifiedAt = Date.now();
    const credentials = sql.prepare(`SELECT c.platform_key,c.platform_key_id FROM epay_wechat_credentials c LEFT JOIN epay_wechat_credential_revocations r ON r.credential_id=c.credential_id
      WHERE c.app_id=? AND c.provider_merchant_id=? AND c.platform_key_id=? AND c.valid_from<=? AND c.valid_until>? AND r.credential_id IS NULL`).all(String(order.app_id), String(order.provider_merchant_id), response.headers.get("wechatpay-serial") ?? "", verifiedAt, verifiedAt);
    if (credentials.length !== 1) throw new Error("native query key identity differs");
    const observation = observeWechatQuery(raw, response.headers, { tradeNo: String(order.trade_no), appId: String(order.app_id), merchantId: String(order.provider_merchant_id), amountCents: Number(order.amount_cents),
      platformKey: String(credentials[0]!.platform_key), platformKeyId: String(credentials[0]!.platform_key_id), now: verifiedAt });
    console.log(JSON.stringify({ orderHash: createHash("sha256").update(String(order.trade_no)).digest("hex").slice(0, 16), state: observation.state,
      signatureVerified: true, identityVerified: true, exactAmountVerified: observation.amountCents !== null, databaseWrites: 0, paymentRequests: 0, providerQueries: 1 }));
  }
} finally { sql.close(); key.fill(0); }
