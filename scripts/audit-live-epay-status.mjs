import { execFileSync } from "node:child_process";
import mysql from "mysql2/promise";

let connection;
try {
  const processes = JSON.parse(execFileSync("pm2", ["jlist"], { encoding: "utf8", timeout: 15000, maxBuffer: 20 * 1024 * 1024 }));
  if (!Array.isArray(processes)) throw new Error("invalid process inventory");
  const processEntry = processes.find((entry) => entry?.name === "epay-next-reconcile-v1" && entry.pm2_env?.status === "online");
  const url = processEntry?.pm2_env?.DATABASE_URL;
  if (typeof url !== "string" || !url.startsWith("mysql:")) throw new Error("database configuration unavailable");
  connection = await mysql.createConnection(url);
  await connection.query("SET SESSION TRANSACTION READ ONLY");
  const [mode] = await connection.query("SELECT @@session.tx_read_only AS read_only");
  if (Number(mode[0]?.read_only) !== 1) throw new Error("read-only session unavailable");
  await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
  const [rows] = await connection.query("SELECT status, notifyStatus, COUNT(*) AS count FROM `Order` GROUP BY status, notifyStatus ORDER BY status, notifyStatus");
  const groups = rows.map((row) => {
    if (typeof row.status !== "string" || typeof row.notifyStatus !== "string" || !Number.isSafeInteger(Number(row.count))) throw new Error("invalid order status aggregate");
    return { status: row.status, notifyStatus: row.notifyStatus, count: Number(row.count) };
  });
  const [pendingRows] = await connection.query(`SELECT
    COUNT(*) AS orders,
    COALESCE(SUM(EXISTS(SELECT 1 FROM NotifyLog n WHERE n.tradeNo=o.tradeNo)),0) AS with_logs,
    COALESCE(SUM(EXISTS(SELECT 1 FROM NotifyLog n WHERE n.tradeNo=o.tradeNo AND n.status='SUCCESS')),0) AS with_success,
    COALESCE(SUM(EXISTS(SELECT 1 FROM NotifyLog n WHERE n.tradeNo=o.tradeNo AND n.status='FAILED')),0) AS with_failure,
    COALESCE(SUM(EXISTS(SELECT 1 FROM MerchantBinding b WHERE b.epayMerchantId=o.merchantId)),0) AS with_binding,
    COALESCE(SUM(o.apiTradeNo IS NOT NULL AND TRIM(o.apiTradeNo) <> ''),0) AS with_provider_reference,
    COALESCE(SUM(o.notifyCount > 0),0) AS with_attempt_count
    FROM \`Order\` o WHERE o.status='PAID' AND o.notifyStatus='PENDING'`);
  const pending = pendingRows[0];
  const notificationAudit = Object.fromEntries(["orders", "with_logs", "with_success", "with_failure", "with_binding", "with_provider_reference", "with_attempt_count"].map((key) => {
    const value = Number(pending?.[key]);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid notification aggregate");
    return [key, value];
  }));
  await connection.rollback();
  console.log(JSON.stringify({ source: "epay-only", consistentSnapshot: true, readOnlySession: true, groups, paidPendingNotifications: notificationAudit }));
} catch (error) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "AUDIT_FAILED";
  console.error(`EPay status audit failed: ${code}`);
  process.exitCode = 1;
} finally {
  if (connection) await connection.end();
}
