import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
const root = process.argv[2];
if (!root || !/^\/var\/lib\/perpay-candidate-\d{8}[a-z]$/.test(root)) throw new Error("invalid audit root");
const sql = new DatabaseSync(join(root, "data/perpay.sqlite3"), { readOnly: true });
try {
  sql.exec("BEGIN");
  const rows = sql.prepare(`SELECT o.trade_no,o.type_code,o.status,o.created_at,o.paid_at,
    coalesce(a.state,w.state) submission_state,coalesce(a.started_at,w.started_at) started_at,
    EXISTS(SELECT 1 FROM epay_alipay_web_links p WHERE p.trade_no=o.trade_no) web_link,
    EXISTS(SELECT 1 FROM epay_alipay_prepay p WHERE p.trade_no=o.trade_no) alipay_qr,
    EXISTS(SELECT 1 FROM epay_wechat_prepay_results p WHERE p.trade_no=o.trade_no) wechat_qr,
    m.value query_state FROM epay_orders o LEFT JOIN epay_alipay_submissions a ON a.trade_no=o.trade_no
    LEFT JOIN epay_wechat_submissions w ON w.trade_no=o.trade_no LEFT JOIN system_metadata m ON m.key='epay_payment_query:'||o.trade_no
    WHERE EXISTS(SELECT 1 FROM epay_alipay_intents i WHERE i.trade_no=o.trade_no) OR EXISTS(SELECT 1 FROM epay_wechat_intents i WHERE i.trade_no=o.trade_no)
    ORDER BY o.created_at DESC LIMIT 20`).all();
  const orders = rows.map(row => {
    const query = row.query_state ? JSON.parse(String(row.query_state)) : null;
    return { orderHash: createHash("sha256").update(String(row.trade_no)).digest("hex").slice(0, 16), provider: row.type_code, status: row.status,
      ageSeconds: Math.floor((Date.now() - Number(row.created_at)) / 1000), submitted: row.submission_state, webLink: Boolean(row.web_link),
      qr: Boolean(row.alipay_qr || row.wechat_qr), query: query ? { attempt: query.attempt, outcome: query.lastOutcome, nextAt: query.nextAt } : null };
  });
  console.log(JSON.stringify({ orders, databaseWrites: 0, providerRequests: 0 }));
} finally { sql.close(); }
