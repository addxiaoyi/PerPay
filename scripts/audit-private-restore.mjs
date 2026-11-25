import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createConnection } from "mysql2/promise";
import { auditMerchantSnapshots } from "../src/epay-compat/merchant-audit.ts";
import { auditOrderLinks } from "../src/epay-compat/order-link-audit.ts";
import { verifyAuditPermissions } from "../src/epay-compat/audit-permissions.ts";
import { auditCallbackTargets } from "../src/epay-compat/callback-target-audit.ts";

const id = process.env.EPAY_AUDIT_CONTAINER;
if (process.env.EPAY_ISOLATED_TEST !== "1" || !id || !/^[a-f0-9]{64}$/.test(id)) throw new Error("isolated restore container is required");
const inspected = JSON.parse(execFileSync("docker", ["inspect", id], { encoding: "utf8", maxBuffer: 1_048_576 }));
const container = inspected[0];
const tmpfs = container?.HostConfig?.Tmpfs?.["/work"];
if (inspected.length !== 1 || container?.Id !== id || container?.Config?.Labels?.["starmc.epay.audit"] !== "isolated-restore-v1" || container?.HostConfig?.NetworkMode !== "none" || container?.HostConfig?.ReadonlyRootfs !== true || typeof tmpfs !== "string" || !tmpfs.includes("nosuid") || !tmpfs.includes("nodev") || container?.State?.Running !== true || !Number.isSafeInteger(container?.State?.Pid) || container.State.Pid < 1) throw new Error("container is not the designated isolated restore");

const chunks = [];
const digest = createHash("sha256");
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 128 * 1024 * 1024) throw new Error("main store exceeds audit size limit");
  digest.update(chunk);
  chunks.push(chunk);
}
const bytes = Buffer.concat(chunks);
let main;
try { main = JSON.parse(bytes.toString("utf8")); }
finally { bytes.fill(0); for (const chunk of chunks) chunk.fill(0); }
if (!main?.payment || !Array.isArray(main.payment.orders)) throw new Error("main payment store is incomplete");

const source = await createConnection({ socketPath: `/proc/${container.State.Pid}/root/work/mysql.sock`, user: "epay_audit", database: "epay_starmc", dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, decimalNumbers: false, multipleStatements: false, connectTimeout: 10000 });
try {
  const [identity] = await source.query("SELECT CURRENT_USER() AS account, CURRENT_ROLE() AS activeRole, @@skip_networking AS skipNetworking");
  const [grantRows] = await source.query("SHOW GRANTS FOR CURRENT_USER");
  if (!Array.isArray(identity) || identity.length !== 1 || Number(identity[0].skipNetworking) !== 1 || !Array.isArray(grantRows)) throw new Error("isolated source identity is unavailable");
  const grants = grantRows.map((row) => {
    const values = Object.values(row);
    if (values.length !== 1) throw new Error("invalid isolated audit grant");
    return values[0];
  });
  verifyAuditPermissions(identity[0].account, identity[0].activeRole, grants);
  await assert.rejects(source.query("CREATE TABLE audit_permission_probe (id INT)"), /denied/i);
  await source.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  await source.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
  const [merchants] = await source.query("SELECT id, CAST(money AS CHAR) AS money FROM Merchant");
  const [bindings] = await source.query("SELECT mainMerchantId, mainApiId, epayMerchantId FROM MerchantBinding");
  const [orders] = await source.query("SELECT tradeNo, merchantId, outTradeNo, apiTradeNo, CAST(money AS CHAR) AS money, status, notifyUrl FROM `Order`");
  const [invoices] = await source.query("SELECT id, tradeNo, merchantId, CAST(amount AS CHAR) AS amount FROM Invoice");
  const [invoiceApplications] = await source.query("SELECT id, tradeNo, outTradeNo, merchantId FROM InvoiceApplication");
  const report = auditMerchantSnapshots({ mainPayment: main.payment, merchants, bindings, orders, invoices, invoiceApplications });
  const links = auditOrderLinks(bindings, main.payment.orders, orders);
  const countIssues = (issues) => {
    const counts = Object.create(null);
    for (const issue of issues) counts[issue.code] = (counts[issue.code] ?? 0) + 1;
    return counts;
  };
  await source.query("COMMIT");
  console.log(JSON.stringify({ mainStoreSha256: digest.digest("hex"), counts: { merchants: merchants.length, bindings: bindings.length, orders: orders.length, invoices: invoices.length, invoiceApplications: invoiceApplications.length }, merchants: report.summaries.map((summary, index) => ({ index: index + 1, mainMerchantPresent: summary.balance !== null, epayBalancePresent: summary.epayRecordedBalanceCents !== null, orders: summary.orderCount, paidOrders: summary.paidOrderCount, invoices: summary.invoiceCount, invoiceApplications: summary.invoiceApplicationCount })), issues: countIssues(report.issues), orderLinks: { matched: links.matched, issues: countIssues(links.issues), projectionCandidates: links.projectionCandidates, providerCandidates: links.providerCandidates }, callbackTargets: auditCallbackTargets(orders), readOnlyVerified: true, samePointInTime: false, financiallyReconciled: false, productionReady: false }));
} finally {
  await source.end();
}
