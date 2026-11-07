import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { auditConfirmedPayments } from "../src/epay-compat/confirmation-audit.ts";
import { auditNativeRefunds } from "../src/epay-compat/refund-audit.ts";
import { readLiveBalance } from "../src/epay-compat/live-balance.ts";
import { auditNativeSettlements } from "../src/epay-compat/settlement-workflow.ts";
import { auditPaymentQueries } from "../src/epay-compat/payment-query-jobs.ts";

const [root, reportPath] = process.argv.slice(2);
if (!root || !/^\/var\/lib\/perpay-candidate-\d{8}[a-z]$/.test(root) || (reportPath && !reportPath.startsWith("/root/perpay-recovery-"))) throw new Error("explicit production audit root required");
process.umask(0o077);
const sql = new DatabaseSync(join(root, "data/perpay.sqlite3"), { readOnly: true });
try {
  sql.exec("BEGIN");
  const payment = auditConfirmedPayments(sql), refunds = auditNativeRefunds(sql), settlements = auditNativeSettlements(sql);
  const merchants = sql.prepare("SELECT merchant_id FROM epay_balance_openings ORDER BY merchant_id").all();
  for (const merchant of merchants) readLiveBalance(sql, Number(merchant.merchant_id));
  const now = Date.now();
  const paymentRecovery = auditPaymentQueries(sql, now);
  const callback = sql.prepare(`SELECT count(*) total,
    coalesce(sum(CASE WHEN status='SUCCEEDED' THEN 1 ELSE 0 END),0) delivered,
    coalesce(sum(CASE WHEN status='FAILED' THEN 1 ELSE 0 END),0) failed,
    coalesce(sum(CASE WHEN status IN ('PENDING','LEASED') AND created_at<? THEN 1 ELSE 0 END),0) delayed
    FROM epay_callback_jobs`).get(now - 600_000)!;
  const sync = JSON.parse(String(sql.prepare("SELECT value FROM system_metadata WHERE key='epay_source_sync'").get()?.value));
  const submission = sql.prepare(`SELECT count(*) pending,coalesce(sum(CASE WHEN o.created_at<? THEN 1 ELSE 0 END),0) unresolved,
    coalesce(sum(CASE WHEN o.created_at<? AND (
      (o.type_code='alipay' AND NOT EXISTS(SELECT 1 FROM epay_alipay_prepay p WHERE p.trade_no=o.trade_no) AND NOT EXISTS(SELECT 1 FROM epay_alipay_web_links w WHERE w.trade_no=o.trade_no)) OR
      (o.type_code='wxpay' AND NOT EXISTS(SELECT 1 FROM epay_wechat_prepay_results p WHERE p.trade_no=o.trade_no))) THEN 1 ELSE 0 END),0) missingPaymentDetails
    FROM epay_orders o WHERE o.status='PENDING' AND
      (EXISTS(SELECT 1 FROM epay_alipay_submissions a WHERE a.trade_no=o.trade_no) OR EXISTS(SELECT 1 FROM epay_wechat_submissions w WHERE w.trade_no=o.trade_no))`).get(now - 24 * 60 * 60 * 1000, now - 60000)!;
  const financialHealthy = payment.inconsistent === 0 && payment.unconfirmedLedger === 0 && payment.unconfirmedCallbacks === 0 && payment.intentPaidWithoutConfirmation === 0 &&
    refunds.inconsistent === 0 && settlements.inconsistent === 0 && Number(callback.failed) === 0 && Number(callback.delayed) === 0 && sync.ok === true && now - sync.appliedAt < 90000;
  const healthy = financialHealthy && paymentRecovery.healthy && Number(submission.unresolved) === 0 && Number(submission.missingPaymentDetails) === 0;
  const report = { healthy, financialHealthy, observedAt: new Date(now).toISOString(), schema: Number(sql.prepare("SELECT max(version) v FROM schema_migrations").get()?.v),
    submissions: Object.fromEntries(Object.entries(submission).map(([key, value]) => [key, Number(value)])),
    merchantsBalanced: merchants.length, nativePayments: payment.confirmed, inconsistentPayments: payment.inconsistent, paymentRecovery,
    callbacks: Object.fromEntries(Object.entries(callback).map(([key, value]) => [key, Number(value)])), refunds, settlements,
    preservedOrders: Number(sql.prepare("SELECT count(*) n FROM epay_orders").get()?.n),
    preservedInvoices: Number(sql.prepare("SELECT count(*) n FROM epay_invoices").get()?.n),
    quarantinedOrders: Number(sql.prepare("SELECT count(*) n FROM epay_orders o WHERE NOT EXISTS(SELECT 1 FROM epay_merchant_bindings b WHERE b.epay_merchant_id=o.merchant_id)").get()?.n),
    sourceSyncAgeMs: now - sync.appliedAt, databaseWrites: 0, providerRequests: 0 };
  sql.exec("COMMIT");
  if (reportPath) writeFileSync(reportPath, JSON.stringify(report), { mode: 0o600, flag: "wx", flush: true });
  console.log(JSON.stringify(report));
  if (!healthy) process.exitCode = 1;
} finally { sql.close(); }
