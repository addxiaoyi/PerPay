import { createHash, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { readEncryptedChannelConfig } from "../src/epay-compat/channel-config.ts";
import { buildAlipayTradeQuery } from "../src/epay-compat/alipay-query.ts";
import { NodeV3Transport } from "../src/infrastructure/alipay/node-transport.ts";
import { verifyV3Response } from "../src/infrastructure/alipay/v3.ts";
import { verifyAlipayQueryAccount } from "../src/epay-compat/alipay-query-account.ts";
import { verifyAlipayQueryEvidence } from "../src/epay-compat/alipay-query-evidence.ts";

const [root, orderId] = process.argv.slice(2);
if (process.env.EPAY_READONLY_AUDIT !== "1" || !root || !/^\/var\/lib\/perpay-candidate-\d{8}[a-z]$/.test(root) || !orderId || !/^[a-f0-9-]{36}$/.test(orderId)) throw new Error("explicit read-only order required");
const key = Buffer.from(readFileSync(join(root, "secrets/master-key"), "utf8").trim(), "hex");
const sql = new DatabaseSync(join(root, "data/perpay.sqlite3"), { readOnly: true });
try {
  const cipher = new RuntimeSecretCipher(key, String(sql.prepare("SELECT value FROM system_metadata WHERE key='instance_id'").get()?.value));
  const marker = JSON.parse(String(sql.prepare("SELECT value FROM system_metadata WHERE key='epay_configured_channels'").get()?.value));
  const config = JSON.parse(readEncryptedChannelConfig(sql, cipher, marker.alipayChannelId)!);
  const order = sql.prepare(`SELECT n.trade_no,i.app_id,i.seller_id,i.platform_public_key,i.amount_cents FROM epay_main_native_orders n JOIN epay_alipay_intents i ON i.trade_no=n.trade_no WHERE n.order_id=?`).get(orderId);
  if (!order) throw new Error("native Alipay order not found");
  const privateKey = createPrivateKey(config.privateKey);
  const account = verifyAlipayQueryAccount({ appId: String(order.app_id), sellerId: String(order.seller_id), platformPublicKey: String(order.platform_public_key), privateKey,
    certificate: readFileSync(join(root, "secrets/alipay-account.crt"), "utf8"), certificateSha256: marker.certificateSha256 }, Date.now());
  const request = buildAlipayTradeQuery(String(order.trade_no), { appId: String(order.app_id), privateKey, ...(config.appCertSn ? { appCertSn: config.appCertSn } : {}), ...(config.rootCertSn ? { alipayRootCertSn: config.rootCertSn } : {}) });
  const response = await new NodeV3Transport().request(request, { timeoutMilliseconds: 10000 });
  const verified = verifyV3Response(response, String(order.platform_public_key));
  const fields = JSON.parse(verified.body);
  const observation = response.status === 200 ? verifyAlipayQueryEvidence(response, { appId: String(order.app_id), sellerId: String(order.seller_id), platformPublicKey: String(order.platform_public_key), tradeNo: String(order.trade_no), amountCents: Number(order.amount_cents) }, Date.now(), account) : null;
  const code = (value: unknown) => typeof value === "string" && /^[A-Z0-9_.]{1,100}$/.test(value) ? value : null;
  console.log(JSON.stringify({ orderHash: createHash("sha256").update(String(order.trade_no)).digest("hex").slice(0,16), status: response.status, signatureVerified: true,
    state: observation?.tradeStatus ?? null, code: code(fields.code), subCode: code(fields.sub_code), fields: Object.keys(fields),
    expectedAccountVerified: true, paymentConfirmed: observation?.evidence !== null && observation !== null, databaseWrites: 0, providerQueries: 1, paymentRequests: 0 }));
} finally { sql.close(); key.fill(0); }
