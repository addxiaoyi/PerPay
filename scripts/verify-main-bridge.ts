import assert from "node:assert/strict";
import { createDecipheriv, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { readCurrentMainPayment } from "../src/epay-compat/main-delta-store.ts";

const [root, reportPath] = process.argv.slice(2);
if (process.env.EPAY_READONLY_AUDIT !== "1" || !root || !reportPath || !/^\/var\/lib\/perpay-candidate-\d{8}[a-z]$/.test(root) || !reportPath.startsWith("/root/perpay-recovery-")) throw new Error("explicit read-only bridge audit required");
process.umask(0o077);
const sql = new DatabaseSync(join(root, "data/perpay.sqlite3"), { readOnly: true });
const key = Buffer.from(readFileSync(join(root, "secrets/master-key"), "utf8").trim(), "hex");
const bridge = readFileSync(join(root, "secrets/main-bridge.secret"), "utf8").trim();
function merchantSecret(value: string) {
  if (!value.startsWith("enc:v1:")) return value;
  const processes = JSON.parse(execFileSync("pm2", ["jlist"], { encoding: "utf8", timeout: 15000, maxBuffer: 20 * 1024 * 1024 })) as Array<{ name?: string; pm2_env?: Record<string, unknown> }>;
  const matches = processes.filter(row => row.name === "starmc-api" && row.pm2_env?.status === "online");
  assert.equal(matches.length, 1);
  const env = readFileSync("/www/wwwroot/starmc-api/.env", "utf8");
  const configuredFile = /^PAYMENT_SECRET_KEY_FILE=(.+)$/m.exec(env)?.[1]?.trim();
  const file = matches[0]!.pm2_env?.PAYMENT_SECRET_KEY_FILE ?? matches[0]!.pm2_env?.LIGHTPAY_BRIDGE_SECRET_FILE ?? configuredFile;
  if (typeof file !== "string" || !file.startsWith("/etc/helstera/")) throw new Error("main merchant key file is unavailable");
  const master = createHash("sha256").update(readFileSync(file)).digest();
  try {
    const parts = value.split(":");
    assert.equal(parts.length, 5);
    const decipher = createDecipheriv("aes-256-gcm", master, Buffer.from(parts[2]!, "base64url"));
    decipher.setAuthTag(Buffer.from(parts[3]!, "base64url"));
    const plain = Buffer.concat([decipher.update(Buffer.from(parts[4]!, "base64url")), decipher.final()]);
    try { return plain.toString("utf8"); } finally { plain.fill(0); }
  } finally { master.fill(0); }
}
try {
  const instanceId = String(sql.prepare("SELECT value FROM system_metadata WHERE key='instance_id'").get()?.value);
  const source = readCurrentMainPayment(sql, new RuntimeSecretCipher(key, instanceId)).payment;
  let verified = 0;
  for (const row of source.merchants) {
    if (row.enabled !== true) continue;
    assert.equal(typeof row.apiId, "string"); assert.equal(typeof row.apiSecret, "string");
    const timestamp = String(Math.floor(Date.now() / 1000)), raw = "{}", secret = merchantSecret(String(row.apiSecret));
    const signature = `sha256=${createHmac("sha256", secret).update(`${timestamp}\n${raw}`).digest("hex")}`;
    const response = await fetch("http://127.0.0.1:8787/api/internal/payment/merchant-auth", { method: "POST", headers: { "content-type": "application/json", "x-lightpay-bridge": bridge },
      body: JSON.stringify({ apiId: row.apiId, timestamp, signature, raw }), redirect: "error", signal: AbortSignal.timeout(5000) });
    if (response.status !== 200) {
      const rejected = await response.json() as { code?: string };
      throw new Error(`main bridge rejected: ${typeof rejected.code === "string" && /^[a-z_]+$/.test(rejected.code) ? rejected.code : "unavailable"}`);
    }
    const value = await response.json() as { ok?: boolean; merchantId?: string; callbackSecret?: string; callbackUrl?: string };
    assert.equal(value.ok, true); assert.equal(value.merchantId, row.id);
    const supplied = Buffer.from(value.callbackSecret ?? ""), expected = Buffer.from(secret);
    assert.ok(supplied.length === expected.length && timingSafeEqual(supplied, expected));
    assert.equal(value.callbackUrl, row.callbackUrl);
    verified++;
  }
  assert.ok(verified > 0);
  const report = { bridgeVerified: true, merchants: verified, databaseWrites: 0, ordersCreated: 0, providerRequests: 0, verifiedAt: new Date().toISOString() };
  writeFileSync(reportPath, JSON.stringify(report), { flag: "wx", mode: 0o600, flush: true });
  console.log(JSON.stringify(report));
} finally { sql.close(); key.fill(0); }
