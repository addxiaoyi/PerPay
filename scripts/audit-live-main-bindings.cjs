const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const mysql = require('mysql2/promise');

async function main() {
  const expected = process.argv.slice(2);
  if (!expected.length || expected.some(value => !/^[a-f0-9]{64}$/.test(value)) || new Set(expected).size !== expected.length) {
    throw new Error('invalid main merchant digests');
  }
  const processes = JSON.parse(execFileSync('pm2', ['jlist'], { encoding: 'utf8', timeout: 15000, maxBuffer: 20 * 1024 * 1024 }));
  const entry = processes.find(item => item?.name === 'epay-next-reconcile-v1' && item.pm2_env?.status === 'online');
  const cwd = entry?.pm2_env?.pm_cwd;
  const url = entry?.pm2_env?.DATABASE_URL;
  if (typeof cwd !== 'string' || !cwd.startsWith('/www/wwwroot/epay-next-releases/') || typeof url !== 'string' || !url.startsWith('mysql:')) throw new Error('database configuration unavailable');
  const connection = await mysql.createConnection(url);
  try {
    await connection.query('SET SESSION TRANSACTION READ ONLY');
    const [mode] = await connection.query('SELECT @@session.tx_read_only AS read_only');
    if (Number(mode[0]?.read_only) !== 1) throw new Error('read-only session unavailable');
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const [rows] = await connection.query('SELECT mainMerchantId,mainApiId FROM MerchantBinding');
    const actual = rows.map(row => {
      if (typeof row.mainMerchantId !== 'string' || typeof row.mainApiId !== 'string') throw new Error('invalid merchant binding');
      return createHash('sha256').update(JSON.stringify([row.mainMerchantId, row.mainApiId])).digest('hex');
    });
    if (new Set(actual).size !== actual.length) throw new Error('duplicate merchant binding');
    const main = new Set(expected), epay = new Set(actual);
    console.log(JSON.stringify({ mainMerchants: main.size, epayBindings: epay.size, matched: expected.filter(value => epay.has(value)).length, mainWithoutBinding: expected.filter(value => !epay.has(value)).length, bindingsWithoutMain: actual.filter(value => !main.has(value)).length, transaction: 'read-only', coordinatedCutoff: false }));
    await connection.rollback();
  } finally {
    await connection.end();
  }
}

main().catch(() => { console.error('binding audit failed'); process.exitCode = 1; });
