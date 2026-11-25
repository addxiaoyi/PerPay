import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { rootCertificates } from 'node:tls'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import express from 'express'

const PROJECT = fileURLToPath(new URL('../', import.meta.url))
const BASELINE = join(PROJECT, 'support/src')
const OVERLAY = join(PROJECT, 'overlay/src')
const SOURCE = resolve(process.env.STARPAY_MAIN_SOURCE_DIR || OVERLAY)
const BRIDGE_KEY = 'isolated-merchant-automation-bridge-key'
const MERCHANT_KEY = 'isolated-merchant-automation-signing-key'
const API_V3_KEY = '12345678901234567890123456789012'
const MIGRATION_KEY = 'ab'.repeat(32)
const INITIAL_AMOUNT = 100
const wait = delay => new Promise(resolveWait => setTimeout(resolveWait, delay))

async function runFixture(directory) {
  process.env.LIGHTPAY_BRIDGE_SECRET_FILE = join(directory, 'bridge-key')
  process.env.PAYMENT_ACCESS_TOKEN_SECRET_FILE = join(directory, 'bridge-key')
  process.env.PAYMENT_SECRET_KEY_FILE = join(directory, 'bridge-key')
  process.env.MERCHANT_AUTOMATION_API_V3_KEY = API_V3_KEY
  process.env.PERPAY_MIGRATION_SECRET_FILE = join(directory, 'migration-key')
  delete process.env.STARMC_MAIN_ORDER_SYNC_URL
  delete process.env.MAIN_SITE_ORDER_SYNC_URL
  globalThis.fetch = async () => { throw new Error('external requests are disabled in the merchant rehearsal') }
  const offlineFetch = globalThis.fetch
  globalThis.fetch = async (...args) => {
    process.send({ type: 'egress-attempt' })
    if (process.env.MERCHANT_AUTOMATION_MODE === 'hold-callback-response') {
      process.send({ type: 'callback-response-pending' })
      while (!existsSync(join(directory, 'release-callback-response'))) await wait(10)
      return new Response('fail')
    }
    if (process.env.MERCHANT_AUTOMATION_MODE === 'hold-order-response') {
      process.send({ type: 'order-response-pending' })
      while (!existsSync(join(directory, 'release-order-response'))) await wait(10)
      return Response.json({ ok: true, order_id: 'fixture-gateway-order', payment_url: 'https://merchant.example/checkout' })
    }
    return offlineFetch(...args)
  }
  const persist = await import(pathToFileURL(join(directory, 'source/persist.js')).href)
  const payment = await import(pathToFileURL(join(directory, 'source/modules/payment/routes.js')).href)
  persist.loadStore()
  const app = express()
  app.use(express.json({ verify: (req, _res, body) => { req.rawBody = Buffer.from(body) } }))
  app.use((req, _res, next) => {
    if (req.headers['x-test-owner'] === 'owner-a') req.user = { id: 'owner-a', roles: [] }
    next()
  })
  let writeCount = 0
  payment.registerPaymentRoutes(app, {
    config: {}, getStore: persist.getStore,
    requireUser: (req, res, next) => req.user ? next() : res.status(401).json({ ok: false }),
    requireAdmin: (_req, res) => res.status(403).json({ ok: false }),
    requireCsrf: (_req, _res, next) => next(),
    jsonOk: (res, body, status = 200) => res.status(status).json({ ok: true, ...body }),
    jsonErr: (res, status, message, code) => res.status(status).json({ ok: false, message, code }),
    scheduleSave: persist.scheduleSave,
    ...(process.env.MERCHANT_AUTOMATION_MODE === 'missing-writer' ? {} : { flushSave: async () => {
      const attempt = ++writeCount
      if (process.env.MERCHANT_AUTOMATION_MODE === 'hold-first-after-save' && attempt === 2) throw new Error('a newer isolated commit failed')
      if (process.env.MERCHANT_AUTOMATION_MODE === 'hold-before-save') {
        process.send({ type: 'pending-commit' })
        while (!existsSync(join(directory, 'release-before-save'))) await wait(10)
      }
      if (existsSync(join(directory, 'fail-write'))) throw new Error('isolated disk write failure')
      await persist.flushSaveSyncAndPg()
      if (process.env.MERCHANT_AUTOMATION_MODE === 'hold-first-after-save' && attempt === 1) {
        process.send({ type: 'first-durable' })
        while (!existsSync(join(directory, 'release-first'))) await wait(10)
      }
      if (process.env.MERCHANT_AUTOMATION_MODE === 'pause-after-save') {
        process.send({ type: 'committed' })
        await new Promise(() => {})
      }
    } }),
  })
  let stopWorkers
  app.post('/__test/start-workers', async (_req, res) => {
    const fixtureDns = (await import('node:dns/promises')).default
    fixtureDns.lookup = async () => {
      if (process.env.MERCHANT_AUTOMATION_MODE === 'hold-callback-dns') {
        process.send({ type: 'worker-dns-pending' })
        while (!existsSync(join(directory, 'release-worker-dns'))) await wait(10)
      }
      return [{ address: '203.0.113.10', family: 4 }]
    }
    stopWorkers?.()
    stopWorkers = payment.startPaymentWorkers({ getStore: persist.getStore, scheduleSave: persist.scheduleSave, logger: { warn() {} } })
    res.json({ ok: true })
  })
  app.get('/__test/queues', (_req, res) => res.json({ callbacks: persist.getStore().payment.callbacks.map(row => ({ status: row.status, attempts: row.attempts || 0 })) }))
  const server = app.listen(0, '127.0.0.1', () => {
    process.send({ type: 'ready', url: `http://127.0.0.1:${server.address().port}` })
  })
}

function createRehearsal(status = 'pending_payment') {
  const directory = mkdtempSync(join(tmpdir(), 'starpay-merchant-automation-'))
  const copy = (name, source = BASELINE) => {
    const target = join(directory, 'source', name)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(source, name), target)
  }
  copy('persist.js', existsSync(join(SOURCE, 'persist.js')) ? SOURCE : BASELINE)
  for (const name of ['services/storeBackups.js', 'utils/permission.js', 'modules/payment/migration-snapshot.js']) copy(name)
  if (process.platform === 'win32') {
    // Windows cannot represent the production secret file's POSIX 0600 mode.
    copyFileSync(join(directory, 'source/modules/payment/migration-snapshot.js'), join(directory, 'source/modules/payment/migration-snapshot-native.js'))
    writeFileSync(join(directory, 'source/modules/payment/migration-snapshot.js'), `import { createPaymentSnapshotHandler } from './migration-snapshot-native.js'; export function registerPaymentMigrationSnapshot(app, getStore) { app.get('/api/internal/payment/migration-snapshot', createPaymentSnapshotHandler({ getStore, readSecret: () => Buffer.from('${MIGRATION_KEY}', 'hex') })) }`)
  }
  copy('modules/payment/routes.js', SOURCE)
  mkdirSync(join(directory, 'data'))
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}')
  writeFileSync(join(directory, 'source/config.js'), `export const config = ${JSON.stringify({ dataDir: join(directory, 'data'), databaseUrl: null, storeBackupEnabled: false })}`)
  writeFileSync(join(directory, 'bridge-key'), BRIDGE_KEY, { mode: 0o600 })
  writeFileSync(join(directory, 'migration-key'), MIGRATION_KEY, { mode: 0o600 })
  const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })
  writeFileSync(join(directory, 'private.pem'), keys.privateKey, { mode: 0o600 })
  writeFileSync(join(directory, 'public.pem'), keys.publicKey)
  writeFileSync(join(directory, 'merchant-cert.pem'), rootCertificates[0])
  const order = { id: 'payment-1', merchantId: 'merchant-a', merchantOrderId: 'ORDER_001', amountCents: INITIAL_AMOUNT, feeRate: 0.05, platformFeeCents: 5, merchantNetCents: 95, channel: 'alipay_web', status, callbackUrl: 'https://merchant.example/notify', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1800000).toISOString() }
  const payment = {
    merchants: [{ id: 'merchant-a', apiId: 'api-a', userId: 'owner-a', enabled: true, apiSecret: MERCHANT_KEY, callbackUrl: 'https://merchant.example/notify' }],
    orders: [order], ledger: [], paymentEvents: [], callbacks: [], orderMirrors: [],
    channels: {
      alipay: { enabled: true, appId: 'fixture-app', merchantId: 'fixture-merchant', privateKeyPath: join(directory, 'private.pem'), platformPublicKeyPath: join(directory, 'public.pem'), modes: ['alipay_web', 'alipay_scan'] },
      wechat: { enabled: true, appId: 'fixture-wx-app', merchantId: 'fixture-wx-merchant', privateKeyPath: join(directory, 'private.pem'), publicKeyPath: join(directory, 'public.pem'), certificatePath: join(directory, 'merchant-cert.pem'), apiV3KeyEnv: 'MERCHANT_AUTOMATION_API_V3_KEY', publicKeyId: 'PUB_KEY_FIXTURE', verifyMode: 'wechat_public_key', modes: ['wechat_native'] },
    },
  }
  const file = join(directory, 'data/store.json')
  writeFileSync(file, JSON.stringify({ payment }))
  return { directory, file, keys, disk: () => JSON.parse(readFileSync(file, 'utf8')).payment }
}

async function start(rehearsal, mode = '') {
  const child = fork(fileURLToPath(import.meta.url), ['--payment-fixture', rehearsal.directory], {
    env: { ...process.env, MERCHANT_AUTOMATION_MODE: mode }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [],
  })
  let logs = ''
  child.stderr.on('data', chunk => { logs += chunk.toString() })
  const ready = await new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`merchant fixture did not start: ${logs}`)) }, 15000)
    child.once('error', reject)
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`merchant fixture exited ${code}: ${logs}`)) })
    child.on('message', message => {
      if (message.type !== 'ready') return
      clearTimeout(timeout)
      resolveReady(message)
    })
  })
  return {
    child, url: ready.url,
    stop: async () => { if (child.exitCode !== null || child.signalCode !== null) return; const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited },
  }
}

const paidBody = { merchantId: 'merchant-a', orderId: 'payment-1', eventId: 'event-1', tradeNo: 'trade-1', amount: '1.00', channel: 'alipay_web' }
const createBody = { merchantOrderId: 'RETRY_001', amount: '1.00', channel: 'alipay_web', notifyUrl: 'https://merchant.example/notify', returnUrl: 'https://merchant.example/return' }
function post(runtime, path, body, headers = {}) {
  return fetch(runtime.url + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
}
const confirm = (runtime, body = paidBody, key = BRIDGE_KEY) => post(runtime, '/api/internal/payment/paid', body, { 'x-lightpay-bridge': key })
const createOrder = (runtime, body = createBody) => post(runtime, '/api/merchant/orders', body, { 'x-test-owner': 'owner-a' })
function waitMessage(child, type) {
  return new Promise((resolveMessage, reject) => {
    const timeout = setTimeout(() => { child.off('message', receive); reject(new Error(`fixture did not send ${type}`)) }, 4000)
    const receive = message => {
      if (message.type !== type) return
      clearTimeout(timeout)
      child.off('message', receive)
      resolveMessage(message)
    }
    child.on('message', receive)
  })
}
function snapshot(runtime) {
  const path = '/api/internal/payment/migration-snapshot'
  const nonce = crypto.randomBytes(16).toString('hex')
  const timestamp = String(Date.now())
  const auth = crypto.createHmac('sha256', Buffer.from(MIGRATION_KEY, 'hex')).update(`GET\n${path}\n${nonce}\n${timestamp}`).digest('hex')
  return fetch(runtime.url + path, { headers: { 'x-perpay-snapshot-nonce': nonce, 'x-perpay-snapshot-time': timestamp, 'x-perpay-snapshot-auth': auth } })
}
function addSecondOrder(rehearsal) {
  const seed = rehearsal.disk()
  seed.orders.push({ ...seed.orders[0], id: 'payment-2', merchantOrderId: 'ORDER_002' })
  writeFileSync(rehearsal.file, JSON.stringify({ payment: seed }))
}

if (process.argv[2] === '--payment-fixture') {
  await runFixture(process.argv[3])
} else {
  test('six concurrent confirmations persist one ledger credit and one callback before acknowledging', async () => {
    const rehearsal = createRehearsal()
    const runtime = await start(rehearsal)
    try {
      const replies = await Promise.all(Array.from({ length: 6 }, () => confirm(runtime)))
      assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 200, 200, 200, 200, 201])
      const saved = rehearsal.disk()
      assert.equal(saved.orders[0].status, 'paid')
      assert.equal(saved.ledger.length, 1)
      assert.equal(saved.ledger[0].availableDelta, 95)
      assert.equal(saved.callbacks.length, 1)
      assert.equal(saved.paymentEvents.length, 1)
    } finally { await runtime.stop(); rmSync(rehearsal.directory, { recursive: true, force: true }) }
  })

  test('a process killed after durable commit and before acknowledgement resumes without a second credit', async () => {
    const rehearsal = createRehearsal()
    let runtime = await start(rehearsal, 'pause-after-save')
    try {
      const committed = new Promise(resolveCommit => runtime.child.on('message', message => { if (message.type === 'committed') resolveCommit() }))
      const controller = new AbortController()
      const pending = fetch(runtime.url + '/api/internal/payment/paid', { method: 'POST', headers: { 'content-type': 'application/json', 'x-lightpay-bridge': BRIDGE_KEY }, body: JSON.stringify(paidBody), signal: controller.signal }).catch(() => null)
      await Promise.race([committed, new Promise((_, reject) => setTimeout(() => reject(new Error('confirmation was acknowledged without its durable writer')), 3000))])
      assert.equal(rehearsal.disk().callbacks.length, 1)
      await runtime.stop()
      controller.abort()
      await pending
      runtime = await start(rehearsal)
      const replay = await confirm(runtime)
      assert.equal(replay.status, 200)
      assert.equal((await replay.json()).duplicate, true)
      assert.equal(rehearsal.disk().ledger.length, 1)
      assert.equal(rehearsal.disk().callbacks.length, 1)
    } finally { await runtime.stop(); rmSync(rehearsal.directory, { recursive: true, force: true }) }
  })

  test('failed persistence returns 503 and a repeated notification flushes the pending confirmation', async () => {
    const rehearsal = createRehearsal()
    const runtime = await start(rehearsal)
    try {
      writeFileSync(join(rehearsal.directory, 'fail-write'), '')
      const failed = await confirm(runtime)
      assert.equal(failed.status, 503)
      assert.equal((await failed.json()).code, 'payment_persistence_unavailable')
      assert.equal(rehearsal.disk().orders[0].status, 'pending_payment')
      rmSync(join(rehearsal.directory, 'fail-write'))
      assert.equal((await confirm(runtime)).status, 200)
      assert.equal(rehearsal.disk().orders[0].status, 'paid')
      assert.equal(rehearsal.disk().ledger.length, 1)
      assert.equal(rehearsal.disk().callbacks.length, 1)
    } finally { await runtime.stop(); rmSync(rehearsal.directory, { recursive: true, force: true }) }
  })

  test('an unconfigured durable writer cannot acknowledge a payment', async () => {
    const rehearsal = createRehearsal()
    const runtime = await start(rehearsal, 'missing-writer')
    try { assert.equal((await confirm(runtime)).status, 503) }
    finally { await runtime.stop(); rmSync(rehearsal.directory, { recursive: true, force: true }) }
  })

  test('wrong bridge credentials, amounts and channels never change persisted business state', async () => {
    const rehearsal = createRehearsal()
    const runtime = await start(rehearsal)
    try {
      const before = readFileSync(rehearsal.file, 'utf8')
      assert.equal((await confirm(runtime, paidBody, 'forged-key')).status, 401)
      assert.equal((await confirm(runtime, { ...paidBody, amount: '1.01' })).status, 409)
      assert.equal((await confirm(runtime, { ...paidBody, channel: 'wechat_native' })).status, 409)
      assert.equal(readFileSync(rehearsal.file, 'utf8'), before)
    } finally { await runtime.stop(); rmSync(rehearsal.directory, { recursive: true, force: true }) }
  })

  test('a late paid notification cannot re-credit a refunded order', async () => {
    const rehearsal = createRehearsal('refunded')
    const seed = JSON.parse(readFileSync(rehearsal.file, 'utf8'))
    seed.payment.ledger = [
      { id: 'credit-1', merchantId: 'merchant-a', orderId: 'payment-1', type: 'payment_paid', provider: 'lightpay', eventId: 'event-1', availableDelta: 95, frozenDelta: 0 },
      { id: 'refund-1', merchantId: 'merchant-a', orderId: 'payment-1', type: 'refund_completed', availableDelta: -95, frozenDelta: 0 },
    ]
    seed.payment.paymentEvents = [{ id: 'saved-event-1', provider: 'lightpay', eventId: 'event-1', orderId: 'payment-1', amountCents: INITIAL_AMOUNT, tradeNo: 'trade-1' }]
    writeFileSync(rehearsal.file, JSON.stringify(seed))
    const runtime = await start(rehearsal)
    try {
      assert.equal((await confirm(runtime)).status, 200)
      assert.equal((await confirm(runtime, { ...paidBody, eventId: 'late-new-event' })).status, 409)
      assert.equal(rehearsal.disk().orders[0].status, 'refunded')
      assert.equal(rehearsal.disk().ledger.length, 2)
      assert.equal(rehearsal.disk().balanceSummaries['merchant-a'].availableCents, 0)
      assert.equal(rehearsal.disk().callbacks.length, 0)
    } finally { await runtime.stop(); rmSync(rehearsal.directory, { recursive: true, force: true }) }
  })

  test('order creation is persisted before acknowledgement and retries reuse it after restart', async () => {
    const rehearsal = createRehearsal()
    let runtime = await start(rehearsal)
    try {
      const replies = await Promise.all(Array.from({ length: 6 }, () => createOrder(runtime)))
      assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 200, 200, 200, 200, 201])
      const first = (await replies.find(reply => reply.status === 201).json()).order.id
      assert.equal(rehearsal.disk().orders.length, 2)
      assert.equal(rehearsal.disk().syncJobs.length, 1)
      await runtime.stop()
      runtime = await start(rehearsal)
      const retry = await createOrder(runtime)
      assert.equal(retry.status, 200)
      assert.equal((await retry.json()).order.id, first)
      assert.equal(rehearsal.disk().syncJobs.length, 1)
    } finally { await runtime.stop(); rmSync(rehearsal.directory, { recursive: true, force: true }) }
  })

  test('changed order retries fail without rotating access tokens or saving altered parameters', async () => {
    const rehearsal = createRehearsal()
    const runtime = await start(rehearsal)
    try {
      assert.equal((await createOrder(runtime)).status, 201)
      const before = readFileSync(rehearsal.file, 'utf8')
      for (const change of [{ amount: '1.01' }, { channel: 'alipay_scan' }, { notifyUrl: 'https://merchant.example/other' }, { returnUrl: 'https://merchant.example/other' }]) {
        const reply = await createOrder(runtime, { ...createBody, ...change })
        assert.equal(reply.status, 409)
        assert.equal((await reply.json()).code, 'order_conflict')
        assert.equal(readFileSync(rehearsal.file, 'utf8'), before)
      }
      assert.equal((await snapshot(runtime)).status, 200)
      assert.equal((await createOrder(runtime, { ...createBody, merchantOrderId: 'INVALID_001', amount: '0' })).status, 400)
      assert.equal((await snapshot(runtime)).status, 200)
    } finally { await runtime.stop(); rmSync(rehearsal.directory, { recursive: true, force: true }) }
  })

  test('order creation cannot report success until its order and projection task are durable', async () => {
    const rehearsal = createRehearsal()
    const runtime = await start(rehearsal)
    try {
      writeFileSync(join(rehearsal.directory, 'fail-write'), '')
      assert.equal((await createOrder(runtime)).status, 503)
      assert.equal(rehearsal.disk().orders.length, 1)
      rmSync(join(rehearsal.directory, 'fail-write'))
      const retry = await createOrder(runtime)
      assert.equal(retry.status, 200)
      assert.equal((await retry.json()).duplicate, true)
      assert.equal(rehearsal.disk().orders.length, 2)
      assert.equal(rehearsal.disk().syncJobs.length, 1)
    } finally { await runtime.stop(); rmSync(rehearsal.directory, { recursive: true, force: true }) }
  })

  test('signed EPay bridge order retries also reject changed parameters', async () => {
    const rehearsal = createRehearsal()
    const runtime = await start(rehearsal)
    const body = { pid: 'api-a', out_trade_no: 'EPAY_RETRY_001', money: '1.00', type: 'alipay', name: 'isolated order', notify_url: 'https://merchant.example/notify', return_url: 'https://merchant.example/return', sign_type: 'MD5' }
    const request = params => {
      const canonical = Object.keys(params).filter(name => name !== 'sign_type' && String(params[name] ?? '') !== '').sort().map(name => `${name}=${params[name]}`).join('&')
      return post(runtime, '/api/internal/payment/epay-order', { ...params, sign: crypto.createHash('md5').update(canonical + MERCHANT_KEY).digest('hex') }, { 'x-lightpay-bridge': BRIDGE_KEY })
    }
    try {
      assert.equal((await request(body)).status, 201)
      const before = readFileSync(rehearsal.file, 'utf8')
      assert.equal((await request({ ...body, money: '2.00' })).status, 409)
      assert.equal(readFileSync(rehearsal.file, 'utf8'), before)
      const forged = await post(runtime, '/api/internal/payment/epay-order', { ...body, sign: '0'.repeat(32) }, { 'x-lightpay-bridge': BRIDGE_KEY })
      assert.equal(forged.status, 401)
    } finally { await runtime.stop(); rmSync(rehearsal.directory, { recursive: true, force: true }) }
  })

  test('authenticated WeChat callbacks persist one credit and reject a forged signature', async () => {
    const rehearsal = createRehearsal()
    const seed = JSON.parse(readFileSync(rehearsal.file, 'utf8'))
    seed.payment.orders[0].channel = 'wechat_native'
    writeFileSync(rehearsal.file, JSON.stringify(seed))
    const runtime = await start(rehearsal)
    const nonce = 'fixtureNonce'
    const transaction = { mchid: 'fixture-wx-merchant', appid: 'fixture-wx-app', out_trade_no: 'payment-1', transaction_id: 'wx-trade-1', trade_state: 'SUCCESS', amount: { total: INITIAL_AMOUNT } }
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(API_V3_KEY), Buffer.from(nonce))
    cipher.setAAD(Buffer.from('transaction'))
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(transaction)), cipher.final(), cipher.getAuthTag()]).toString('base64')
    const body = { resource: { algorithm: 'AEAD_AES_256_GCM', nonce, associated_data: 'transaction', ciphertext } }
    const raw = JSON.stringify(body)
    const stamp = String(Math.floor(Date.now() / 1000))
    const headers = { 'wechatpay-timestamp': stamp, 'wechatpay-nonce': 'fixture-request', 'wechatpay-serial': 'PUB_KEY_FIXTURE', 'wechatpay-signature': crypto.createSign('RSA-SHA256').update(`${stamp}\nfixture-request\n${raw}\n`).sign(rehearsal.keys.privateKey, 'base64') }
    try {
      assert.equal((await post(runtime, '/api/payment/wechat/notify', body, { ...headers, 'wechatpay-signature': 'forged' })).status, 401)
      assert.equal(rehearsal.disk().ledger.length, 0)
      writeFileSync(join(rehearsal.directory, 'fail-write'), '')
      assert.equal((await post(runtime, '/api/payment/wechat/notify', body, headers)).status, 503)
      assert.equal(rehearsal.disk().orders[0].status, 'pending_payment')
      rmSync(join(rehearsal.directory, 'fail-write'))
      const replies = await Promise.all(Array.from({ length: 6 }, () => post(runtime, '/api/payment/wechat/notify', body, headers)))
      assert.equal(replies.every(reply => reply.status === 200), true)
      assert.equal(rehearsal.disk().orders[0].status, 'paid')
      assert.equal(rehearsal.disk().ledger.length, 1)
      assert.equal(rehearsal.disk().callbacks.length, 1)
    } finally { await runtime.stop(); rmSync(rehearsal.directory, { recursive: true, force: true }) }
  })

  test('pending commits are hidden from signed snapshots, financial reads and dependent mutations', async () => {
    const rehearsal = createRehearsal()
    const runtime = await start(rehearsal, 'hold-before-save')
    const entered = waitMessage(runtime.child, 'pending-commit')
    const pending = confirm(runtime).catch(() => null)
    try {
      await entered
      assert.equal((await snapshot(runtime)).status, 503)
      const balance = await fetch(runtime.url + '/api/merchant/balance', { headers: { 'x-test-owner': 'owner-a' } })
      assert.equal(balance.status, 503)
      assert.equal((await balance.json()).code, 'payment_commit_pending')
      assert.equal((await post(runtime, '/api/merchant/refunds', { orderId: 'payment-1' }, { 'x-test-owner': 'owner-a' })).status, 503)
      assert.equal((await fetch(runtime.url + '/api/merchant/access?merchantId=merchant-a', { headers: { 'x-test-owner': 'owner-a' } })).status, 200)
      assert.equal(rehearsal.disk().ledger.length, 0)
      writeFileSync(join(rehearsal.directory, 'release-before-save'), '')
      assert.equal((await pending).status, 201)
      assert.equal((await snapshot(runtime)).status, 200)
    } finally { await runtime.stop(); await pending; rmSync(rehearsal.directory, { recursive: true, force: true }) }
  })

  test('workers never send an outbox item while its financial commit is waiting', async () => {
    const rehearsal = createRehearsal()
    const runtime = await start(rehearsal, 'hold-before-save')
    let attempts = 0
    runtime.child.on('message', message => { if (message.type === 'egress-attempt') attempts++ })
    const entered = waitMessage(runtime.child, 'pending-commit')
    const pending = confirm(runtime).catch(() => null)
    try {
      await entered
      assert.equal((await post(runtime, '/__test/start-workers', {})).status, 200)
      await wait(200)
      assert.equal(attempts, 0)
      assert.equal((await snapshot(runtime)).status, 503)
    } finally { await runtime.stop(); await pending; rmSync(rehearsal.directory, { recursive: true, force: true }) }
  })

  test('failed commits keep both read and worker barriers until a durable retry succeeds', async () => {
    const rehearsal = createRehearsal()
    const runtime = await start(rehearsal)
    let attempts = 0
    runtime.child.on('message', message => { if (message.type === 'egress-attempt') attempts++ })
    try {
      writeFileSync(join(rehearsal.directory, 'fail-write'), '')
      assert.equal((await confirm(runtime)).status, 503)
      assert.equal((await snapshot(runtime)).status, 503)
      await post(runtime, '/__test/start-workers', {})
      await wait(200)
      assert.equal(attempts, 0)
      rmSync(join(rehearsal.directory, 'fail-write'))
      assert.equal((await confirm(runtime)).status, 200)
      assert.equal((await snapshot(runtime)).status, 200)
      const delivery = waitMessage(runtime.child, 'egress-attempt')
      await post(runtime, '/__test/start-workers', {})
      await delivery
      assert.ok(attempts > 0)
      assert.equal(rehearsal.disk().ledger.length, 1)
    } finally { await runtime.stop(); rmSync(rehearsal.directory, { recursive: true, force: true }) }
  })

  test('a late older success cannot release a newer failed revision or return its uncommitted balance', async () => {
    const rehearsal = createRehearsal()
    addSecondOrder(rehearsal)
    const runtime = await start(rehearsal, 'hold-first-after-save')
    const durable = waitMessage(runtime.child, 'first-durable')
    const first = confirm(runtime).catch(() => null)
    try {
      await durable
      const second = { ...paidBody, orderId: 'payment-2', eventId: 'event-2', tradeNo: 'trade-2' }
      assert.equal((await confirm(runtime, second)).status, 503)
      writeFileSync(join(rehearsal.directory, 'release-first'), '')
      const response = await first
      assert.equal(response.status, 201)
      assert.equal((await response.json()).balance.available, '0.95')
      assert.equal(rehearsal.disk().ledger.length, 1)
      assert.equal((await snapshot(runtime)).status, 503)
      assert.equal((await confirm(runtime, second)).status, 200)
      assert.equal((await snapshot(runtime)).status, 200)
      assert.equal(rehearsal.disk().ledger.length, 2)
    } finally { await runtime.stop(); await first; rmSync(rehearsal.directory, { recursive: true, force: true }) }
  })

  test('worker DNS continuations do not dispatch when a newer commit fails', async () => {
    const rehearsal = createRehearsal()
    addSecondOrder(rehearsal)
    const runtime = await start(rehearsal, 'hold-callback-dns')
    let attempts = 0
    runtime.child.on('message', message => { if (message.type === 'egress-attempt') attempts++ })
    try {
      assert.equal((await confirm(runtime)).status, 201)
      const resolving = waitMessage(runtime.child, 'worker-dns-pending')
      await post(runtime, '/__test/start-workers', {})
      await resolving
      writeFileSync(join(rehearsal.directory, 'fail-write'), '')
      assert.equal((await confirm(runtime, { ...paidBody, orderId: 'payment-2', eventId: 'event-2', tradeNo: 'trade-2' })).status, 503)
      writeFileSync(join(rehearsal.directory, 'release-worker-dns'), '')
      await wait(150)
      assert.equal(attempts, 0)
      const queues = await (await fetch(runtime.url + '/__test/queues')).json()
      assert.equal(queues.callbacks.every(row => row.status === 'queued' && row.attempts === 0), true)
    } finally { await runtime.stop(); rmSync(rehearsal.directory, { recursive: true, force: true }) }
  })

  test('worker response continuations do not send a fallback or consume an attempt while a commit is pending', async () => {
    const rehearsal = createRehearsal()
    addSecondOrder(rehearsal)
    const runtime = await start(rehearsal, 'hold-callback-response')
    let attempts = 0
    runtime.child.on('message', message => { if (message.type === 'egress-attempt') attempts++ })
    try {
      assert.equal((await confirm(runtime)).status, 201)
      const responding = waitMessage(runtime.child, 'callback-response-pending')
      await post(runtime, '/__test/start-workers', {})
      await responding
      assert.equal(attempts, 1)
      writeFileSync(join(rehearsal.directory, 'fail-write'), '')
      assert.equal((await confirm(runtime, { ...paidBody, orderId: 'payment-2', eventId: 'event-2', tradeNo: 'trade-2' })).status, 503)
      writeFileSync(join(rehearsal.directory, 'release-callback-response'), '')
      await wait(150)
      assert.equal(attempts, 1)
      const queues = await (await fetch(runtime.url + '/__test/queues')).json()
      assert.equal(queues.callbacks.every(row => row.status === 'queued' && row.attempts === 0), true)
    } finally { await runtime.stop(); rmSync(rehearsal.directory, { recursive: true, force: true }) }
  })

  test('a delayed channel projection cannot change an already confirmed order back to pending', async () => {
    const rehearsal = createRehearsal()
    const seed = rehearsal.disk()
    seed.syncJobs = [{ id: 'projection-1', orderId: 'payment-1', kind: 'channel_projection', status: 'queued', attempts: 0, nextAttemptAt: new Date().toISOString(), createdAt: new Date().toISOString() }]
    writeFileSync(rehearsal.file, JSON.stringify({ payment: seed }))
    const runtime = await start(rehearsal, 'hold-order-response')
    try {
      const responding = waitMessage(runtime.child, 'order-response-pending')
      await post(runtime, '/__test/start-workers', {})
      await responding
      assert.equal((await confirm(runtime)).status, 201)
      writeFileSync(join(rehearsal.directory, 'release-order-response'), '')
      await wait(500)
      assert.equal(rehearsal.disk().orders[0].status, 'paid')
      assert.equal(rehearsal.disk().ledger.length, 1)
    } finally { await runtime.stop(); rmSync(rehearsal.directory, { recursive: true, force: true }) }
  })

  test('an older order-creation response cannot expose a later failed payment on that order', async () => {
    const rehearsal = createRehearsal()
    const runtime = await start(rehearsal, 'hold-first-after-save')
    const durable = waitMessage(runtime.child, 'first-durable')
    const first = createOrder(runtime).catch(() => null)
    try {
      await durable
      const order = rehearsal.disk().orders.find(row => row.merchantOrderId === createBody.merchantOrderId)
      const failed = { ...paidBody, orderId: order.id, eventId: 'created-event', tradeNo: 'created-trade' }
      assert.equal((await confirm(runtime, failed)).status, 503)
      writeFileSync(join(rehearsal.directory, 'release-first'), '')
      const response = await first
      assert.equal(response.status, 201)
      const created = (await response.json()).order
      assert.equal(created.status, 'pending_sync')
      assert.equal(created.callbackStatus, null)
      assert.equal((await snapshot(runtime)).status, 503)
      assert.equal((await confirm(runtime, failed)).status, 200)
      assert.equal((await snapshot(runtime)).status, 200)
    } finally { await runtime.stop(); await first; rmSync(rehearsal.directory, { recursive: true, force: true }) }
  })
}
