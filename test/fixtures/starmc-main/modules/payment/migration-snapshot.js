import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'

const SNAPSHOT_PATH = '/api/internal/payment/migration-snapshot'
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024
const REQUEST_WINDOW_MS = 5000

function readMigrationSecret() {
  const path = process.env.PERPAY_MIGRATION_SECRET_FILE || '/etc/helstera/perpay-migration.secret'
  const stat = statSync(path)
  if (!stat.isFile() || (stat.mode & 0o027) !== 0 || stat.size > 128) throw new Error('migration secret permissions are invalid')
  const raw = readFileSync(path, 'utf8').trim()
  if (!/^[a-f0-9]{64}$/.test(raw)) throw new Error('migration secret is invalid')
  return Buffer.from(raw, 'hex')
}

export function createPaymentSnapshotHandler({ getStore, readSecret = readMigrationSecret, clock = Date.now }) {
  return (req, res) => {
    res.set('Cache-Control', 'no-store')
    const nonce = req.headers['x-perpay-snapshot-nonce']
    const time = req.headers['x-perpay-snapshot-time']
    const auth = req.headers['x-perpay-snapshot-auth']
    const now = clock()
    if (req.method !== 'GET' || req.originalUrl !== SNAPSHOT_PATH || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress) || typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce) || typeof time !== 'string' || !/^\d{13}$/.test(time) || Math.abs(now - Number(time)) > REQUEST_WINDOW_MS || typeof auth !== 'string' || !/^[a-f0-9]{64}$/.test(auth)) return res.status(403).json({ ok: false, error: 'snapshot_forbidden' })
    let secret
    try {
      secret = Buffer.from(readSecret())
      if (secret.length !== 32) throw new Error('migration secret length is invalid')
      const signature = createHmac('sha256', secret).update(`GET\n${SNAPSHOT_PATH}\n${nonce}\n${time}`).digest()
      if (!timingSafeEqual(signature, Buffer.from(auth, 'hex'))) return res.status(403).json({ ok: false, error: 'snapshot_forbidden' })
      const payment = getStore()?.payment
      if (!payment || typeof payment !== 'object' || Array.isArray(payment)) throw new Error('payment source is unavailable')
      // No await or persistence call may split this event-loop-consistent capture.
      const raw = JSON.stringify({ version: 1, nonce, capturedAt: new Date(now).toISOString(), payment })
      if (Buffer.byteLength(raw) > MAX_SNAPSHOT_BYTES) throw new Error('payment snapshot exceeds limit')
      res.set('Content-Type', 'application/json; charset=utf-8')
      res.set('X-PerPay-Snapshot-Signature', createHmac('sha256', secret).update(raw).digest('hex'))
      return res.send(raw)
    } catch {
      return res.status(503).json({ ok: false, error: 'snapshot_unavailable' })
    } finally { secret?.fill(0) }
  }
}

export function registerPaymentMigrationSnapshot(app, getStore) {
  app.get(SNAPSHOT_PATH, createPaymentSnapshotHandler({ getStore }))
}
