import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createConnection } from 'mysql2/promise';
import { mysqlSnapshotConfig } from '../src/epay-compat/mysql-snapshot.ts';

const databasePath = process.argv[2];
if (!databasePath || !/^\/var\/lib\/perpay-candidate-[0-9a-z-]+\/data\/perpay\.sqlite3$/.test(databasePath)) throw new Error('explicit candidate path required');
let connection, prisma, database;
let stage = 'legacy-process';
try {
  const processes = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', timeout: 15_000, maxBuffer: 20 * 1024 * 1024 }));
  const entries = processes.filter(row => row.name === 'epay-next-reconcile-v1' && row.pm2_env?.status === 'online');
  if (entries.length !== 1) throw new Error('legacy process ambiguous');
  const env = entries[0].pm2_env;
  stage = 'source-connect';
  connection = await createConnection(mysqlSnapshotConfig(env.DATABASE_URL));
  await connection.query('SET SESSION TRANSACTION READ ONLY');
  await connection.query("SET SESSION time_zone='+00:00'");
  await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
  database = new DatabaseSync(databasePath, { readOnly: true });
  database.exec('BEGIN');
  const [columns] = await connection.query("SELECT TABLE_NAME,COLUMN_NAME,DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND DATA_TYPE IN ('timestamp','datetime') ORDER BY TABLE_NAME,COLUMN_NAME");
  stage = 'compare-orders';
  const [orders] = await connection.query('SELECT tradeNo,createdAt,updatedAt,paidAt,notifyLastAt FROM `Order` ORDER BY tradeNo');
  const timestamps = { createdAt: 'created_at', updatedAt: 'updated_at', paidAt: 'paid_at', notifyLastAt: 'notify_last_at' };
  const offsets = {};
  let missingOrders = 0, nullDifferences = 0;
  for (const order of orders) {
    const candidate = database.prepare('SELECT created_at,updated_at,paid_at,notify_last_at FROM epay_orders WHERE trade_no=?').get(order.tradeNo);
    if (!candidate) { missingOrders++; continue; }
    for (const [source, target] of Object.entries(timestamps)) {
      if (order[source] === null || candidate[target] === null) { if (order[source] !== candidate[target]) nullDifferences++; continue; }
      const epoch = Date.parse(order[source].replace(' ', 'T') + 'Z');
      if (!Number.isSafeInteger(epoch)) throw new Error('invalid source timestamp');
      const offset = Number(candidate[target]) - epoch;
      offsets[offset] = (offsets[offset] ?? 0) + 1;
    }
  }
  stage = 'legacy-prisma';
  const legacyRequire = createRequire(env.pm_cwd + '/package.json');
  const { PrismaClient } = legacyRequire('@prisma/client');
  prisma = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } }, log: [] });
  const legacy = await prisma.order.findMany({ select: { tradeNo: true, createdAt: true, updatedAt: true, paidAt: true, notifyLastAt: true }, orderBy: { tradeNo: 'asc' } });
  const sourceOrders = new Map(orders.map(order => [order.tradeNo, order]));
  let prismaCompared = 0, prismaUtcDifferences = 0;
  for (const order of legacy) for (const source of Object.keys(timestamps)) {
    const raw = sourceOrders.get(order.tradeNo)?.[source];
    if (raw == null || order[source] == null) continue;
    prismaCompared++;
    if (order[source].getTime() !== Date.parse(raw.replace(' ', 'T') + 'Z')) prismaUtcDifferences++;
  }
  console.log(JSON.stringify({ readOnly: true, sourceOrders: orders.length, legacyOrders: legacy.length, missingOrders, nullDifferences,
    timestampTypes: columns.map(row => ({ table: row.TABLE_NAME, column: row.COLUMN_NAME, type: row.DATA_TYPE })),
    candidateMinusUtcMilliseconds: offsets, prismaCompared, prismaUtcDifferences,
    evidenceSha256: createHash('sha256').update(JSON.stringify({ orders, legacy })).digest('hex') }));
} catch (error) {
  console.error(JSON.stringify({ error: 'timestamp_audit_failed', stage, name: error?.name ?? 'Error' }));
  process.exitCode = 1;
} finally {
  if (database?.isTransaction) database.exec('ROLLBACK');
  database?.close();
  await prisma?.$disconnect();
  if (connection) { await connection.rollback(); await connection.end(); }
}
