import { createDecipheriv, createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { readCurrentMainPayment } from "../src/epay-compat/main-delta-store.ts";

const [root, destination] = process.argv.slice(2);
if (process.env.STARPAY_UNPAID_CHANNEL_TEST !== "1" || !root || !/^\/var\/lib\/perpay-candidate-\d{8}[a-z]$/.test(root) || !destination || !/^\/root\/perpay-recovery-[a-z0-9-]+\/collections-probe-[a-z0-9-]+\.json$/.test(destination) || existsSync(destination)) throw new Error("explicit unpaid collection probe required");
process.umask(0o077);
const sql = new DatabaseSync(root + "/data/perpay.sqlite3", { readOnly: true });
const master = Buffer.from(readFileSync(root + "/secrets/master-key", "utf8").trim(), "hex");
type Probe = { channel: string; merchantOrderId: string; phase: string; orderId?: string; tradeNo?: string; response?: { nonce: string; ciphertext: string; tag: string }; summary?: Record<string, unknown> };
const probes: Probe[] = [];
const save = () => writeFileSync(destination!, JSON.stringify({ createdAt: new Date().toISOString(), purpose: "unpaid-channel-verification", amountCents: 1, probes }), { mode: 0o600, flush: true });
try {
  const instance = String(sql.prepare("SELECT value FROM system_metadata WHERE key='instance_id'").get()?.value);
  const cipher = new RuntimeSecretCipher(master, instance), source = readCurrentMainPayment(sql, cipher).payment;
  const binding = sql.prepare("SELECT main_merchant_id,main_api_id FROM epay_merchant_bindings WHERE epay_merchant_id=1001").get();
  const merchant = source.merchants.find(row => row.id === binding?.main_merchant_id && row.apiId === binding?.main_api_id && row.enabled === true);
  if (!merchant || typeof merchant.apiSecret !== "string") throw new Error("administrator merchant identity unavailable");
  const encrypted = merchant.apiSecret.split(":");
  if (encrypted.length !== 5 || encrypted[0] !== "enc" || encrypted[1] !== "v1") throw new Error("unexpected main merchant credential encoding");
  const env = readFileSync("/www/wwwroot/starmc-api/.env", "utf8");
  const filename = /^PAYMENT_SECRET_KEY_FILE=(.+)$/m.exec(env)?.[1]?.trim();
  if (filename !== "/etc/helstera/payment/master.key") throw new Error("main credential source differs");
  const authKey = createHash("sha256").update(readFileSync(filename)).digest();
  const decipher = createDecipheriv("aes-256-gcm", authKey, Buffer.from(encrypted[2]!, "base64url"));
  decipher.setAuthTag(Buffer.from(encrypted[3]!, "base64url"));
  const secret = Buffer.concat([decipher.update(Buffer.from(encrypted[4]!, "base64url")), decipher.final()]);
  authKey.fill(0);
  try {
    const ready = await fetch("https://star-web.top/pay/epay/readyz", { signal: AbortSignal.timeout(10000), redirect: "error" });
    if (!ready.ok || (await ready.json() as { status: string }).status !== "ready") throw new Error("gateway not ready for probes");
    writeFileSync(destination, "{}", { mode: 0o600, flag: "wx", flush: true });
    for (const channel of ["alipay_web", "wechat_native"]) {
      const merchantOrderId = `SPV_${channel}_${randomUUID().replaceAll("-", "").slice(0,20)}`;
      const probe: Probe = { channel, merchantOrderId, phase: "reserved" }; probes.push(probe); save();
      const body = JSON.stringify({ merchantOrderId, amount: "0.01", subject: "StarPAY通道核验勿付款", channel });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = "sha256=" + createHmac("sha256", secret).update(`${timestamp}\n${body}`).digest("hex");
      const response = await fetch("https://star-web.top/api/merchant/orders", { method: "POST", headers: { "content-type": "application/json", "x-lightpay-api-id": String(merchant.apiId), "x-lightpay-timestamp": timestamp, "x-lightpay-signature": signature }, body, redirect: "error", signal: AbortSignal.timeout(20000) });
      const reply = await response.json() as { ok?: boolean; code?: string; checkoutUrl?: string; order?: { id: string; status: string; amountCents: number; paymentUrl: string | null; qrCode: string | null } };
      const sealed = cipher.encrypt(`epay:config:probe:${merchantOrderId}`, 1, JSON.stringify(reply));
      probe.response = { nonce: sealed.nonce.toString("base64"), ciphertext: sealed.ciphertext.toString("base64"), tag: sealed.authenticationTag.toString("base64") };
      probe.phase = "responded";
      probe.summary = { httpStatus: response.status, ok: reply.ok === true, state: reply.order?.status ?? null, qrReturned: Boolean(reply.order?.qrCode), webLinkReturned: Boolean(reply.order?.paymentUrl), amountCents: reply.order?.amountCents ?? null };
      if (reply.order?.id) {
        probe.orderId = reply.order.id;
        const stored = sql.prepare("SELECT trade_no FROM epay_main_native_orders WHERE order_id=? AND main_merchant_id=?").get(reply.order.id, String(merchant.id));
        if (!stored) throw new Error("probe order ownership differs");
        probe.tradeNo = String(stored.trade_no);
      }
      save();
      if (!response.ok || !reply.ok || !reply.order || reply.order.amountCents !== 1 || !reply.checkoutUrl) throw new Error(`unpaid ${channel} probe creation failed`);
      const target = new URL(reply.checkoutUrl);
      if (target.origin !== "https://star-web.top" || !target.pathname.startsWith("/pay/epay/main/checkout/")) throw new Error("unexpected checkout target");
      const checkout = await fetch(target, { redirect: "manual", signal: AbortSignal.timeout(10000) });
      const html = await checkout.text();
      const redirect = checkout.headers.get("location");
      const summary = { ...probe.summary, checkoutHttpStatus: checkout.status, checkoutIsHtml: checkout.headers.get("content-type")?.includes("text/html") ?? false,
        renderedQr: /data:image\/png;base64/.test(html), officialRedirect: redirect ? new URL(redirect).origin === "https://openapi.alipay.com" : false,
        ledgerEntries: Number(sql.prepare("SELECT count(*) n FROM epay_balance_ledger WHERE entry_id=?").get("epay_payment:"+probe.tradeNo)?.n),
        callbacks: Number(sql.prepare("SELECT count(*) n FROM epay_callback_jobs WHERE trade_no=?").get(probe.tradeNo!)?.n) };
      probe.summary = summary; probe.phase = "checkout_verified"; save();
      console.log(JSON.stringify({ channel, ...summary, actualPayments: 0, refundRequests: 0 }));
    }
  } finally { secret.fill(0); }
} finally { sql.close(); master.fill(0); }
