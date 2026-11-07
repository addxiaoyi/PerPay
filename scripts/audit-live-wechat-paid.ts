import { spawnSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
import { observeLegacyWechatPayment } from "../src/epay-compat/legacy-wechat-observation.ts";

const SQL = `SET SESSION TRANSACTION READ ONLY;
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY;
SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('tradeNo',o.tradeNo,'providerTradeNo',o.apiTradeNo,'money',CAST(o.money AS CHAR),'config',c.config)),JSON_ARRAY())
FROM \`Order\` o JOIN Channel c ON c.id=o.channelId
WHERE o.status='PAID' AND o.notifyStatus='PENDING' AND c.provider='WECHAT' AND c.product='native';
ROLLBACK;`;

function cents(value: unknown): number {
  if (typeof value !== "string" || !/^\d{1,13}(?:\.\d{1,2})?$/.test(value)) throw new Error("invalid source amount");
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (amount < 1n || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("invalid source amount");
  return Number(amount);
}

export async function auditWechatRows(rows: unknown, observe: typeof observeLegacyWechatPayment, transport: typeof fetch) {
  if (!Array.isArray(rows) || rows.length !== 2) throw new Error("unexpected source order count");
  const parsed = rows.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid source row");
    const row = value as Record<string, unknown>;
    if (typeof row.tradeNo !== "string" || typeof row.providerTradeNo !== "string" || !row.config || typeof row.config !== "object" || Array.isArray(row.config)) throw new Error("invalid source row");
    return { config: row.config, tradeNo: row.tradeNo, providerTradeNo: row.providerTradeNo, amountCents: cents(row.money), transport };
  });
  if (new Set(parsed.map(row => row.tradeNo)).size !== parsed.length) throw new Error("duplicate source order");
  const totals: Record<string, number> = {};
  for (const row of parsed) {
    const observation = await observe(row);
    totals[observation.state] = (totals[observation.state] ?? 0) + 1;
  }
  return totals;
}

export async function runLiveWechatAudit(pid: string) {
  if (process.env.EPAY_READONLY_AUDIT !== "1" || !/^[1-9]\d{0,9}$/.test(pid)) throw new Error("audit is not explicitly enabled");
  const cwd = readlinkSync(`/proc/${pid}/cwd`);
  if (!cwd.startsWith("/www/wwwroot/epay-next-releases/") || !cwd.endsWith("/.next/standalone")) throw new Error("unexpected source process");
  const entries = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(entry => entry.startsWith("DATABASE_URL="));
  if (entries.length !== 1) throw new Error("source database unavailable");
  const url = new URL(entries[0]!.slice("DATABASE_URL=".length));
  if (url.protocol !== "mysql:" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname) || !url.pathname.slice(1)) throw new Error("source database must be local");
  const result = spawnSync("mysql", ["--no-defaults", "--protocol=tcp", "--host", url.hostname.replace(/^\[|\]$/g, ""), "--port", url.port || "3306", "--user", decodeURIComponent(url.username), "--database", decodeURIComponent(url.pathname.slice(1)), "--batch", "--raw", "--skip-column-names", "--execute", SQL], {
    encoding: "utf8", timeout: 15_000, maxBuffer: 512 * 1024,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", MYSQL_PWD: decodeURIComponent(url.password) },
  });
  if (result.status !== 0 || result.error) throw new Error("source snapshot query failed");
  const rows: unknown = JSON.parse(result.stdout);
  return auditWechatRows(rows, observeLegacyWechatPayment, fetch);
}
