import assert from 'node:assert/strict';
const base = new URL(process.argv[2] ?? 'https://star-web.top/pay');
assert.equal(base.protocol, 'https:');
const checks = [];
for (const action of ['orders', 'query', 'refund']) {
  const response = await fetch(base.href.replace(/\/$/, '') + '/epay/balance/' + action, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  assert.match(response.headers.get('content-type') ?? '', /application\/json/, 'balance API reached an unexpected upstream');
  const reply = await response.json();
  assert.equal(response.status, 401, `balance ${action} must reject unsigned requests`);
  assert.equal(reply.code, 'unauthenticated');
  checks.push({ action, status: response.status, code: reply.code });
}
console.log(JSON.stringify({ checks, financialWrites: 0 }));
