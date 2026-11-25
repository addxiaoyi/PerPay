import { execFileSync } from "node:child_process";
import mysql from "mysql2/promise";

let connection;
try {
  const processes = JSON.parse(execFileSync("pm2", ["jlist"], { encoding: "utf8", timeout: 15000, maxBuffer: 20 * 1024 * 1024 }));
  const entry = processes.find((item) => item?.name === "epay-next-reconcile-v1" && item.pm2_env?.status === "online");
  const url = entry?.pm2_env?.DATABASE_URL;
  if (typeof url !== "string" || !url.startsWith("mysql:")) throw new Error("database unavailable");
  connection = await mysql.createConnection(url);
  await connection.query("SET SESSION TRANSACTION READ ONLY");
  const [mode] = await connection.query("SELECT @@session.tx_read_only AS read_only");
  if (Number(mode[0]?.read_only) !== 1) throw new Error("read-only mode unavailable");
  await connection.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  await connection.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
  const [rows] = await connection.query(`SELECT c.enabled,
    CASE WHEN JSON_TYPE(JSON_EXTRACT(c.config, '$.appId')) = 'STRING' AND NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(c.config, '$.appId'))), '') IS NOT NULL THEN 1 ELSE 0 END AS has_app_id,
    CASE WHEN JSON_TYPE(JSON_EXTRACT(c.config, '$.alipayPublicKey')) = 'STRING' AND NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(c.config, '$.alipayPublicKey'))), '') IS NOT NULL THEN 1 ELSE 0 END AS has_public_key,
    COUNT(DISTINCT c.id) AS channels,
    COUNT(o.tradeNo) AS pending_orders
    FROM Channel c LEFT JOIN \`Order\` o ON o.channelId = c.id AND o.status = 'PENDING'
    WHERE c.provider = 'ALIPAY'
    GROUP BY c.enabled, has_app_id, has_public_key
    ORDER BY c.enabled, has_app_id, has_public_key`);
  const groups = rows.map((row) => {
    const values = [row.enabled, row.has_app_id, row.has_public_key, row.channels, row.pending_orders].map(Number);
    if (values.some((value) => !Number.isSafeInteger(value) || value < 0) || values.slice(0, 3).some((value) => value > 1)) throw new Error("invalid aggregate");
    return { enabled: values[0], hasAppId: values[1], hasPublicKey: values[2], channels: values[3], pendingOrders: values[4] };
  });
  const [unassigned] = await connection.query(`SELECT
    CASE WHEN LOWER(typeCode) IN ('alipay', 'ali') THEN 'alipay'
         WHEN LOWER(typeCode) IN ('wechat', 'wxpay', 'wx') THEN 'wechat'
         WHEN typeCode IS NULL OR TRIM(typeCode) = '' THEN 'missing' ELSE 'other' END AS kind,
    COUNT(*) AS count FROM \`Order\` WHERE status='PENDING' AND channelId IS NULL GROUP BY kind ORDER BY kind`);
  const unassignedPendingOrders = unassigned.map((row) => {
    const count = Number(row.count);
    if (!['alipay', 'wechat', 'missing', 'other'].includes(row.kind) || !Number.isSafeInteger(count) || count < 0) throw new Error("invalid unassigned aggregate");
    return { kind: row.kind, count };
  });
  const [evidenceRows] = await connection.query(`SELECT COUNT(*) AS orders,
    COALESCE(SUM(NULLIF(TRIM(o.apiTradeNo), '') IS NOT NULL), 0) AS provider_reference,
    COALESCE(SUM(NULLIF(TRIM(o.payUrl), '') IS NOT NULL OR NULLIF(TRIM(o.qrCode), '') IS NOT NULL OR NULLIF(TRIM(o.urlScheme), '') IS NOT NULL), 0) AS payment_link,
    COALESCE(SUM(o.providerResult IS NOT NULL AND JSON_TYPE(o.providerResult) NOT IN ('NULL')), 0) AS provider_result,
    COALESCE(SUM(o.paidAt IS NOT NULL), 0) AS paid_timestamp,
    COALESCE(SUM(EXISTS(SELECT 1 FROM NotifyLog n WHERE n.tradeNo = o.tradeNo)), 0) AS notification_log,
    COALESCE(SUM(EXISTS(SELECT 1 FROM MerchantBinding b WHERE b.epayMerchantId = o.merchantId)), 0) AS merchant_binding,
    COALESCE(SUM(o.createdAt >= UTC_TIMESTAMP() - INTERVAL 1 DAY), 0) AS created_last_day
    FROM \`Order\` o WHERE o.status = 'PENDING' AND o.channelId IS NULL`);
  const evidence = Object.fromEntries(['orders', 'provider_reference', 'payment_link', 'provider_result', 'paid_timestamp', 'notification_log', 'merchant_binding', 'created_last_day'].map((key) => {
    const count = Number(evidenceRows[0]?.[key]);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid evidence aggregate');
    return [key, count];
  }));
  const [alipayRows] = await connection.query(`SELECT COUNT(*) AS orders,
    COALESCE(SUM(NULLIF(TRIM(o.apiTradeNo), '') IS NOT NULL), 0) AS provider_reference,
    COALESCE(SUM(NULLIF(TRIM(o.payUrl), '') IS NOT NULL OR NULLIF(TRIM(o.qrCode), '') IS NOT NULL OR NULLIF(TRIM(o.urlScheme), '') IS NOT NULL), 0) AS payment_link,
    COALESCE(SUM(o.providerResult IS NOT NULL AND JSON_TYPE(o.providerResult) NOT IN ('NULL')), 0) AS provider_result,
    COALESCE(SUM(EXISTS(SELECT 1 FROM MerchantBinding b WHERE b.epayMerchantId = o.merchantId)), 0) AS merchant_binding,
    COALESCE(SUM(EXISTS(SELECT 1 FROM NotifyLog n WHERE n.tradeNo = o.tradeNo)), 0) AS notification_log,
    COALESCE(SUM(EXISTS(SELECT 1 FROM \`Order\` other JOIN Channel c2 ON c2.id=other.channelId AND c2.provider='ALIPAY'
      WHERE other.status='PENDING' AND other.money=o.money AND other.tradeNo<>o.tradeNo)), 0) AS same_amount_pending
    FROM \`Order\` o JOIN Channel c ON c.id=o.channelId WHERE o.status='PENDING' AND c.provider='ALIPAY'`);
  const alipayEvidence = Object.fromEntries(['orders', 'provider_reference', 'payment_link', 'provider_result', 'merchant_binding', 'notification_log', 'same_amount_pending'].map((key) => {
    const count = Number(alipayRows[0]?.[key]);
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid Alipay evidence aggregate');
    return [key, count];
  }));
  const [callbackRows] = await connection.query(`SELECT o.notifyUrl FROM \`Order\` o
    JOIN Channel c ON c.id=o.channelId WHERE o.status='PENDING' AND c.provider='ALIPAY'`);
  const callbackProtocols = { https: 0, http: 0, other: 0, invalid: 0, reservedFields: 0 };
  const reserved = new Set(['pid', 'trade_no', 'out_trade_no', 'type', 'name', 'money', 'trade_status', 'param', 'sign', 'sign_type']);
  for (const row of callbackRows) {
    try {
      if (typeof row.notifyUrl !== 'string') throw new Error('invalid callback');
      const url = new URL(row.notifyUrl);
      if (url.protocol === 'https:') callbackProtocols.https++;
      else if (url.protocol === 'http:') callbackProtocols.http++;
      else callbackProtocols.other++;
      if ([...url.searchParams.keys()].some((key) => reserved.has(key))) callbackProtocols.reservedFields++;
    } catch { callbackProtocols.invalid++; }
  }
  await connection.rollback();
  console.log(JSON.stringify({ readOnlySession: true, consistentSnapshot: true, groups, unassignedPendingOrders, evidence, alipayEvidence, callbackProtocols }));
} catch (error) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "AUDIT_FAILED";
  console.error(`Alipay readiness audit failed: ${code}`);
  process.exitCode = 1;
} finally {
  if (connection) await connection.end();
}
