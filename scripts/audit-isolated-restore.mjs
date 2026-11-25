import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { auditMerchantSnapshots } from "../dist/epay-compat/merchant-audit.js";
import { auditOrderLinks } from "../dist/epay-compat/order-link-audit.js";
import { auditLightpayOrders } from "../dist/epay-compat/lightpay-audit.js";
import { auditUnboundCallbackEvidence } from "../dist/epay-compat/unbound-callback-audit.js";
import { auditUnboundTradeEvidence } from "../dist/epay-compat/unbound-trade-audit.js";

const container = process.env.EPAY_AUDIT_CONTAINER;
const mainStorePath = process.env.EPAY_MAIN_STORE;
if (!container || !/^[a-f0-9]{64}$/.test(container) || !mainStorePath) throw new Error("isolated container and main store path are required");
const inspected = JSON.parse(execFileSync("docker", ["inspect", container], { encoding: "utf8", maxBuffer: 1024 * 1024 }));
const instance = inspected[0];
if (inspected.length !== 1 || instance?.Config?.Labels?.["starmc.epay.audit"] !== "isolated-v1" || instance?.HostConfig?.NetworkMode !== "none" || !instance?.HostConfig?.Tmpfs?.["/var/lib/mysql"] || instance?.State?.Running !== true) {
  throw new Error("container is not the designated network-isolated temporary restore");
}

function rows(table, fields) {
  const object = Object.entries(fields).map(([name, expression]) => `'${name}', ${expression}`).join(", ");
  const sql = `SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(${object})), JSON_ARRAY()) FROM \`${table}\``;
  const output = execFileSync("docker", ["exec", container, "mysql", "-uroot", "-N", "-B", "epay_starmc", "-e", sql], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(output.trim());
}

const main = JSON.parse(readFileSync(mainStorePath, "utf8"));
const merchants = rows("Merchant", { id: "id", name: "name", money: "CAST(money AS CHAR)" });
const bindings = rows("MerchantBinding", { mainMerchantId: "mainMerchantId", mainApiId: "mainApiId", epayMerchantId: "epayMerchantId" });
const orders = rows("Order", { tradeNo: "tradeNo", merchantId: "merchantId", outTradeNo: "outTradeNo", apiTradeNo: "apiTradeNo", money: "CAST(money AS CHAR)", status: "status", notifyUrl: "notifyUrl" });
const invoices = rows("Invoice", { id: "CONCAT('invoice:',id)", tradeNo: "tradeNo", merchantId: "merchantId", amount: "CAST(amount AS CHAR)" });
const applications = rows("InvoiceApplication", { id: "CONCAT('application:',id)", tradeNo: "tradeNo", outTradeNo: "outTradeNo", merchantId: "merchantId", feeCents: "feeCents", status: "status" });
const report = auditMerchantSnapshots({ mainPayment: main.payment, merchants, bindings, orders, invoices, invoiceApplications: applications });
if (!Array.isArray(main.payment.orders)) throw new Error("main payment store is missing orders");
const orderLinks = auditOrderLinks(bindings, main.payment.orders, orders);
const issues = {};
for (const issue of report.issues) issues[issue.code] = (issues[issue.code] ?? 0) + 1;
const orderIssues = {};
for (const issue of orderLinks.issues) orderIssues[issue.code] = (orderIssues[issue.code] ?? 0) + 1;
const boundMerchantIds = new Set(bindings.map((binding) => binding.epayMerchantId));
const callbackEvidence = auditUnboundCallbackEvidence({ merchants: main.payment.merchants, orders: main.payment.orders, legacyOrders: orders, legacyMerchants: merchants, boundLegacyIds: [...boundMerchantIds] });
const tradeEvidence = auditUnboundTradeEvidence({ mainOrders: main.payment.orders, legacyOrders: orders, boundLegacyIds: [...boundMerchantIds] });
const unboundOrders = { PAID: 0, PENDING: 0, CLOSED: 0, REFUNDED: 0, FROZEN: 0, OTHER: 0 };
for (const order of orders) {
  if (boundMerchantIds.has(order.merchantId)) continue;
  const status = Object.hasOwn(unboundOrders, order.status) ? order.status : "OTHER";
  unboundOrders[status]++;
}
let bridgeAudit = null;
if (process.env.EPAY_LIGHTPAY_DB) {
  const bridge = new DatabaseSync(process.env.EPAY_LIGHTPAY_DB, { readOnly: true });
  try {
    const bridgeOrders = bridge.prepare("SELECT id, merchant_id AS merchantId, amount FROM orders").all();
    bridgeAudit = auditLightpayOrders(main.payment.merchants, main.payment.orders, bridgeOrders, bindings.map((binding) => binding.mainMerchantId));
  } finally {
    bridge.close();
  }
}
console.log(JSON.stringify({
  source: "isolated_restore_and_main_store_file",
  mainStoreIsVerifiedLiveSnapshot: false,
  samePointInTime: false,
  counts: { merchants: merchants.length, bindings: bindings.length, orders: orders.length, invoices: invoices.length, invoiceApplications: applications.length },
  merchants: report.summaries.map((summary, index) => ({ index: index + 1, mainMerchantPresent: summary.balance !== null, epayBalancePresent: summary.epayRecordedBalanceCents !== null, orders: summary.orderCount, paidOrders: summary.paidOrderCount, invoices: summary.invoiceCount, invoiceApplications: summary.invoiceApplicationCount })),
  issues,
  orderLinks: { matched: orderLinks.matched, issues: orderIssues, projectionCandidates: orderLinks.projectionCandidates, unboundOrders, snapshotsComparable: orderLinks.snapshotsComparable },
  bridgeAudit,
  callbackEvidence,
  tradeEvidence,
  snapshotsComparable: report.snapshotsComparable,
}));
