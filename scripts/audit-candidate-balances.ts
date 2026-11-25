import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { auditLegacyDashboardBalance, type LegacyBalanceInput } from "../src/epay-compat/legacy-balance-audit.ts";
import { auditConfirmedPayments } from "../src/epay-compat/confirmation-audit.ts";

const [appRoot, databasePath, keyPath, reportPath] = process.argv.slice(2);
if (!appRoot || !databasePath || !keyPath || !reportPath || !appRoot.startsWith("/opt/perpay-candidate-") || !databasePath.startsWith("/var/lib/perpay-candidate-") || !keyPath.startsWith("/var/lib/perpay-candidate-") || !reportPath.startsWith("/root/perpay-recovery-")) throw new Error("candidate audit requires explicit private paths");
process.umask(0o077);
const { RuntimeSecretCipher } = await import(pathToFileURL(`${appRoot}/dist/settings/crypto.js`).href);
const { projectMerchantLedgerBalance } = await import(pathToFileURL(`${appRoot}/dist/epay-compat/ledger-balance.js`).href);
const key = Buffer.from(readFileSync(keyPath, "utf8").trim(), "hex");
const database = new DatabaseSync(databasePath, { readOnly: true });
try {
  database.exec("BEGIN");
  const instance = database.prepare("SELECT value FROM system_metadata WHERE key='instance_id'").get();
  if (!instance || key.length !== 32) throw new Error("candidate identity is unavailable");
  const cipher = new RuntimeSecretCipher(key, String(instance.value));
  const native = database.prepare("SELECT (SELECT count(*) FROM epay_alipay_intents)+(SELECT count(*) FROM epay_wechat_intents) n").get();
  if (Number(native?.n) !== 0) throw new Error("legacy baseline audit refuses a candidate with new orders");
  const rows = database.prepare(`SELECT b.main_merchant_id,b.epay_merchant_id,m.fee_rate_bps FROM epay_merchant_bindings b
    JOIN epay_merchant_accounts m ON m.merchant_id=b.epay_merchant_id WHERE m.enabled=1 ORDER BY b.epay_merchant_id`).all();
  const summaries = rows.map(binding => {
    const merchantId = Number(binding.epay_merchant_id);
    const main = projectMerchantLedgerBalance(database, cipher, merchantId);
    const mainOrders = database.prepare("SELECT order_id id,merchant_order_id merchantOrderId,amount_cents amountCents,status,created_at createdAt FROM epay_main_order_sources WHERE merchant_id=?").all(merchantId);
    const gatewayOrders = database.prepare("SELECT trade_no tradeNo,out_trade_no merchantOrderId,money_cents amountCents,get_money_cents receivedCents,paid_at paidAt,created_at createdAt,status FROM epay_orders WHERE merchant_id=?").all(merchantId);
    const invoiceApplications = database.prepare("SELECT application_id id,fee_cents feeCents,status FROM epay_invoice_applications WHERE merchant_id=?").all(merchantId);
    const audit = auditLegacyDashboardBalance({ mainAvailableCents: main.availableCents, mainFrozenCents: main.frozenCents, feeBps: Number(binding.fee_rate_bps), mainOrders, gatewayOrders, invoiceApplications } as LegacyBalanceInput);
    const legacyDigest = createHash("sha256").update(JSON.stringify([binding.main_merchant_id, audit.legacyAvailableCents, audit.frozenCents])).digest("hex");
    return { merchantId: String(binding.main_merchant_id), ...audit, legacyDigest };
  });
  const paymentAudit = auditConfirmedPayments(database);
  const ledgerEntries = database.prepare(`SELECT source,entry_type entryType,count(*) entries FROM epay_balance_ledger
    GROUP BY source,entry_type ORDER BY source,entry_type`).all();
  const callbackJobs = database.prepare("SELECT status,count(*) entries FROM epay_callback_jobs GROUP BY status ORDER BY status").all();
  database.exec("COMMIT");
  const report = { createdAt: new Date().toISOString(), readOnly: true, productionCutover: false, financiallyReconciled: false, paymentAudit, ledgerEntries, callbackJobs, summaries };
  writeFileSync(reportPath, JSON.stringify(report), { flag: "wx", mode: 0o600, flush: true });
  console.log(JSON.stringify({ readOnly: true, financiallyReconciled: false, paymentAudit, ledgerEntries, callbackJobs,
    merchants: summaries.map(({ counts, issues, legacyDigest, fullAvailableCents, legacyAvailableCents }) => ({ counts, issues, legacyDigest, formulasAgree: fullAvailableCents === legacyAvailableCents })) }));
} finally {
  if (database.isTransaction) database.exec("ROLLBACK");
  database.close();
  key.fill(0);
}
