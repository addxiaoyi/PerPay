const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const mysql = require('mysql2/promise');

async function main() {
  const salt = process.argv[2];
  if (!salt || !/^[a-f0-9]{32}$/.test(salt)) throw new Error('invalid audit salt');
  const processes = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', timeout: 15000, maxBuffer: 20 * 1024 * 1024 }));
  const entry = processes.find(item => item?.name === 'epay-next-reconcile-v1' && item.pm2_env?.status === 'online');
  if (!entry?.pm2_env?.pm_cwd?.startsWith('/www/wwwroot/epay-next-releases/') || !entry.pm2_env.DATABASE_URL?.startsWith('mysql:')) throw new Error('database configuration unavailable');
  const connection = await mysql.createConnection(entry.pm2_env.DATABASE_URL);
  try {
    await connection.query('SET SESSION TRANSACTION READ ONLY');
    const [mode] = await connection.query('SELECT @@session.tx_read_only AS read_only');
    if (Number(mode[0]?.read_only) !== 1) throw new Error('read-only session unavailable');
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const [rows] = await connection.query("SELECT o.tradeNo, o.outTradeNo, o.apiTradeNo FROM `Order` o WHERE o.status='PAID' AND NOT EXISTS (SELECT 1 FROM MerchantBinding b WHERE b.epayMerchantId=o.merchantId)");
    const hash = value => {
      if (typeof value !== 'string' || !value || value.trim() !== value) throw new Error('invalid order reference');
      return createHash('sha256').update(salt + ':' + value).digest('hex');
    };
    const orders = rows.map(row => ({ trade: hash(row.tradeNo), merchantOrder: hash(row.outTradeNo), provider: row.apiTradeNo ? hash(row.apiTradeNo) : null }));
    console.log(JSON.stringify({ count: rows.length, orders, coordinatedCutoff: false }));
    await connection.rollback();
  } finally {
    await connection.end();
  }
}

main().catch(() => { console.error('unbound provider audit failed'); process.exitCode = 1; });
