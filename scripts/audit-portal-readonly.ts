import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { portalOverview, portalRecords } from "../src/epay-compat/portal-read-model.ts";

const root = process.argv[2];
if (process.env.EPAY_READONLY_AUDIT !== "1" || !root || !/^\/var\/lib\/perpay-candidate-\d{8}[a-z]$/.test(root)) throw new Error("explicit portal audit root required");
const key = Buffer.from(readFileSync(join(root, "secrets/master-key"), "utf8").trim(), "hex");
const sql = new DatabaseSync(join(root, "data/perpay.sqlite3"), { readOnly: true });
try {
  sql.exec("BEGIN");
  const cipher = new RuntimeSecretCipher(key, String(sql.prepare("SELECT value FROM system_metadata WHERE key='instance_id'").get()?.value));
  const bindings = sql.prepare("SELECT epay_merchant_id,main_merchant_id,main_api_id FROM epay_merchant_bindings ORDER BY epay_merchant_id").all();
  const counts = [];
  for (const [index, row] of [...bindings, bindings[0]!].entries()) {
    const scope = { all: index === bindings.length, epayMerchantId: Number(row.epay_merchant_id), merchantId: String(row.main_merchant_id), mainApiId: String(row.main_api_id) };
    const overview = portalOverview(sql, scope, Date.now(), 30);
    const records = Object.fromEntries((["orders", "notifications", "ledger", "refunds", "settlements"] as const).map(kind => {
      const rows = portalRecords(sql, cipher, scope, kind);
      if (!scope.all && rows.some(record => record.epayMerchantId !== scope.epayMerchantId)) throw new Error("portal merchant scope mismatch");
      return [kind, rows.length];
    }));
    counts.push({ scope: scope.all ? "admin" : "merchant", merchants: overview.merchants.length, records });
  }
  console.log(JSON.stringify({ verified: true, scopes: counts, databaseWrites: 0, providerRequests: 0 }));
} finally { sql.close(); key.fill(0); }
