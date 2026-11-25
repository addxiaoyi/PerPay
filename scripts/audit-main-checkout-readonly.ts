import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { issueCheckoutToken } from "../src/epay-compat/isolated-checkout-status.ts";

const [root, orderId] = process.argv.slice(2);
if (process.env.EPAY_READONLY_AUDIT !== "1" || !root || !/^\/var\/lib\/perpay-candidate-\d{8}[a-z]$/.test(root) || !orderId || !/^[a-f0-9-]{36}$/.test(orderId)) throw new Error("explicit checkout audit target required");
const sql = new DatabaseSync(join(root, "data/perpay.sqlite3"), { readOnly: true });
const key = Buffer.from(readFileSync(join(root, "secrets/master-key"), "utf8").trim(), "hex");
try {
  const row = sql.prepare(`SELECT o.trade_no,o.merchant_id,o.status,
    (SELECT count(*) FROM epay_balance_ledger l WHERE l.entry_id='epay_payment:'||o.trade_no) postings,
    (SELECT count(*) FROM epay_callback_jobs j WHERE j.trade_no=o.trade_no) callbacks,
    (SELECT count(*) FROM audit_events a WHERE a.action='epay.order.closed' AND a.subject_id=o.trade_no AND json_extract(a.details_json,'$.signatureVerified')=1) verified_closures
    FROM epay_main_native_orders n JOIN epay_orders o ON o.trade_no=n.trade_no WHERE n.order_id=?`).get(orderId);
  if (!row) throw new Error("checkout order not found");
  const instance = String(sql.prepare("SELECT value FROM system_metadata WHERE key='instance_id'").get()?.value);
  const token = issueCheckoutToken(key, instance, String(row.trade_no), Number(row.merchant_id), Date.now());
  const response = await fetch(`http://127.0.0.1:16191/pay/epay/main/checkout/${orderId}?token=${encodeURIComponent(token)}`, { redirect: "error", signal: AbortSignal.timeout(10000) });
  const html = await response.text();
  console.log(JSON.stringify({ status: row.status, paymentPostings: Number(row.postings), merchantCallbacks: Number(row.callbacks), verifiedClosures: Number(row.verified_closures),
    checkoutHttpStatus: response.status, htmlPage: response.headers.get("content-type")?.includes("text/html") === true,
    starpayBrand: html.includes("StarPAY"), closedMessage: html.includes("订单已关闭"), financialFieldsExposed: /merchantNetCents|callbackAttempts/.test(html), databaseWrites: 0, providerRequests: 0 }));
} finally { sql.close(); key.fill(0); }
