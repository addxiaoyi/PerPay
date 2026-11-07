import { execFileSync } from "node:child_process";
import mysql from "mysql2/promise";

const cutoff = process.argv[2];
if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(cutoff ?? "")) {
  throw new Error("expected maintenance cutoff in YYYY-MM-DD HH:MM:SS format");
}

let processes;
try {
  processes = JSON.parse(execFileSync("pm2", ["jlist"], {
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 20 * 1024 * 1024,
  }));
  if (!Array.isArray(processes)) throw new Error("invalid process inventory");
} catch {
  throw new Error("unable to read EPay process inventory");
}
const processEntry = processes.find((entry) => entry?.name === "epay-next-reconcile-v1" && entry.pm2_env?.status === "online");
const databaseUrl = processEntry?.pm2_env?.DATABASE_URL;
if (typeof databaseUrl !== "string" || !databaseUrl.startsWith("mysql:")) {
  throw new Error("online EPay database configuration is unavailable");
}

let connection;
try {
  connection = await mysql.createConnection(databaseUrl);
  await connection.query("SET SESSION time_zone = '+08:00'");
  await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  await connection.query("START TRANSACTION READ ONLY");
  const [rows] = await connection.execute(
    "SELECT COUNT(*) AS count, DATE_FORMAT(MAX(createdAt), '%Y-%m-%d %H:%i:%s') AS latest FROM `Order` WHERE createdAt >= ?",
    [cutoff],
  );
  await connection.rollback();
  const count = Number(rows[0]?.count);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("invalid order count");
  console.log(JSON.stringify({ cutoff, orderCount: count, latestCreatedAt: rows[0]?.latest ?? null, source: "epay-only", transaction: "read-only" }));
} catch (error) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "AUDIT_FAILED";
  console.error(`maintenance order audit failed: ${code}`);
  process.exitCode = 1;
} finally {
  try {
    await connection?.end();
  } catch {
    console.error("maintenance order audit failed: CONNECTION_CLOSE_FAILED");
    process.exitCode = 1;
  }
}
