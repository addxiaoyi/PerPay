import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { it } from 'node:test';
import { createPaymentSnapshotHandler } from './fixtures/starmc-main/modules/payment/migration-snapshot.js';

it('authenticates a loopback-only memory snapshot without changing the source or echoing secrets in failures', () => {
  const secret = Buffer.alloc(32, 7), now = 1_800_000_000_000, nonce = 'a'.repeat(32);
  const payment = { merchants: [{ id: 'merchant-1' }], orders: [{ id: 'order-1', status: 'paid' }], privateConfig: 'snapshot-private-field' };
  const initial = JSON.stringify(payment);
  const path = '/api/internal/payment/migration-snapshot';
  const signature = createHmac('sha256', secret).update(`GET\n${path}\n${nonce}\n${now}`).digest('hex');
  const handler = createPaymentSnapshotHandler({ getStore: () => ({ payment }), readSecret: () => secret, clock: () => now });
  function invoke(overrides = {}) {
    const req = { method: 'GET', originalUrl: path, socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-perpay-snapshot-nonce': nonce, 'x-perpay-snapshot-time': String(now), 'x-perpay-snapshot-auth': signature }, ...overrides };
    const res = { statusCode: 200, headers: {}, raw: '', set(name, value) { this.headers[name.toLowerCase()] = value; return this; }, status(value) { this.statusCode = value; return this; }, send(value) { this.raw = value; return this; }, json(value) { this.raw = JSON.stringify(value); return this; } };
    handler(req, res);
    return res;
  }
  const snapshot = invoke();
  assert.equal(snapshot.statusCode, 200);
  assert.equal(snapshot.headers['cache-control'], 'no-store');
  const body = JSON.parse(snapshot.raw);
  assert.deepEqual(body, { version: 1, nonce, capturedAt: new Date(now).toISOString(), payment });
  assert.equal(snapshot.headers['x-perpay-snapshot-signature'], createHmac('sha256', secret).update(snapshot.raw).digest('hex'));
  assert.equal(JSON.stringify(payment), initial);
  for (const request of [{ socket: { remoteAddress: '192.0.2.1' } }, { headers: {} }, { originalUrl: path + '?extra=1' }, { method: 'POST' }, { headers: { 'x-perpay-snapshot-nonce': nonce, 'x-perpay-snapshot-time': String(now - 6000), 'x-perpay-snapshot-auth': signature } }]) {
    const denied = invoke(request);
    assert.notEqual(denied.statusCode, 200);
    assert.doesNotMatch(denied.raw, /snapshot-private-field|merchant-1|order-1/);
  }
});
