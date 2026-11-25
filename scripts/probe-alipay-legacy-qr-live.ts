import { createPrivateKey, randomUUID, sign, verify } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { readEncryptedChannelConfig } from "../src/epay-compat/channel-config.ts";
import { readBoundedBody } from "../src/epay-compat/main-order-auth.ts";
import { parseStrictJson } from "../src/http/strict-json.ts";

const [root, destination] = process.argv.slice(2);
if (process.env.STARPAY_UNPAID_CHANNEL_TEST !== "1" || !root || !/^\/var\/lib\/perpay-candidate-\d{8}[a-z]$/.test(root) || !destination || !/^\/root\/perpay-recovery-[a-z0-9-]+\/v2-probe-[a-z0-9-]+\.json$/.test(destination) || existsSync(destination)) throw new Error("explicit unpaid probe destination required");
process.umask(0o077);
const sql = new DatabaseSync(root + "/data/perpay.sqlite3", { readOnly: true });
const master = Buffer.from(readFileSync(root + "/secrets/master-key", "utf8").trim(), "hex");
const tradeNo = `SPV${randomUUID().replaceAll("-", "").slice(0, 28)}`;
try {
  const cipher = new RuntimeSecretCipher(master, String(sql.prepare("SELECT value FROM system_metadata WHERE key='instance_id'").get()?.value));
  const marker = JSON.parse(String(sql.prepare("SELECT value FROM system_metadata WHERE key='epay_configured_channels'").get()?.value));
  const config = JSON.parse(readEncryptedChannelConfig(sql, cipher, marker.alipayChannelId)!);
  const key = createPrivateKey(config.privateKey);
  const platform = sql.prepare("SELECT DISTINCT platform_public_key FROM epay_alipay_bindings").all();
  if (platform.length !== 1) throw new Error("ambiguous Alipay key");
  const state: Record<string, unknown> = { tradeNo, amountCents: 1, startedAt: Date.now(), phase: "reserved" };
  writeFileSync(destination, JSON.stringify(state), { flag: "wx", mode: 0o600, flush: true });
  async function request(method: string) {
    const responseName = method.replaceAll(".", "_") + "_response";
    const fields: Record<string, string> = { app_id: config.appId, method, charset: "utf-8", sign_type: "RSA2", format: "JSON", version: "1.0",
      timestamp: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19).replace("T", " "), app_cert_sn: config.appCertSn, alipay_root_cert_sn: config.rootCertSn,
      biz_content: JSON.stringify({ out_trade_no: tradeNo, ...(method === "alipay.trade.precreate" ? { total_amount: "0.01", subject: "StarPAY通道核验勿付款", timeout_express: "1m" } : {}) }) };
    if (method === "alipay.trade.precreate") fields.notify_url = "https://star-web.top/pay/epay/alipay/notify";
    fields.sign = sign("RSA-SHA256", Buffer.from(Object.keys(fields).sort().map(name => `${name}=${fields[name]}`).join("&")), key).toString("base64");
    const response = await fetch("https://openapi.alipay.com/gateway.do", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8" }, body: new URLSearchParams(fields), redirect: "error", signal: AbortSignal.timeout(10000) });
    const bytes = await readBoundedBody(response.body, 65536), envelope = parseStrictJson(bytes) as Record<string, unknown>, raw = bytes.toString("utf8");
    const marker = `"${responseName}":`, offset = raw.indexOf(marker);
    if (offset < 0 || typeof envelope.sign !== "string") throw new Error("Alipay signed envelope missing");
    let start = offset + marker.length; while (/\s/.test(raw[start] ?? "")) start++;
    if (raw[start] !== "{") throw new Error("Alipay response object missing");
    let depth = 0, quoted = false, escaped = false, end = start;
    for (; end < raw.length; end++) {
      const char = raw[end];
      if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; }
      else if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) { end++; break; }
    }
    if (depth !== 0 || !verify("RSA-SHA256", Buffer.from(raw.slice(start, end)), String(platform[0]!.platform_public_key), Buffer.from(envelope.sign, "base64"))) throw new Error("Alipay v2 signature invalid");
    const payload = envelope[responseName] as Record<string, unknown>;
    return { httpStatus: response.status, payload };
  }
  const observed = await request("alipay.trade.precreate");
  const code = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : null;
  const report = { protocol: "v2", httpStatus: observed.httpStatus, code: code(observed.payload.code), subCode: code(observed.payload.sub_code), signatureVerified: true,
    qrReturned: typeof observed.payload.qr_code === "string", closed: false, amountCents: 1, precreateRequests: 1, payments: 0, refunds: 0, databaseWrites: 0 };
  const encrypted = cipher.encrypt(`epay:config:probe:${tradeNo}`, 1, JSON.stringify(observed));
  state.response = { nonce: encrypted.nonce.toString("base64"), ciphertext: encrypted.ciphertext.toString("base64"), tag: encrypted.authenticationTag.toString("base64") };
  writeFileSync(destination, JSON.stringify({ ...state, phase: "observed", report }), { mode: 0o600, flush: true });
  if (observed.payload.code === "10000" && report.qrReturned && observed.payload.out_trade_no === tradeNo) {
    const closed = await request("alipay.trade.close"), query = await request("alipay.trade.query");
    report.closed = closed.payload.code === "10000" && closed.payload.out_trade_no === tradeNo && (query.payload.trade_status === "TRADE_CLOSED" || query.payload.sub_code === "ACQ.TRADE_NOT_EXIST");
    if (!report.closed) throw new Error("Alipay probe closure requires investigation");
  }
  writeFileSync(destination, JSON.stringify({ ...state, phase: "complete", report }), { mode: 0o600, flush: true });
  console.log(JSON.stringify(report));
} finally { sql.close(); master.fill(0); }
