import crypto from 'node:crypto'
import fs from 'node:fs'
import dns from 'node:dns/promises'
import net from 'node:net'
import { hasRole } from '../../utils/permission.js'
import { registerPaymentMigrationSnapshot } from './migration-snapshot.js'

const FEE_RATE = 0.05
const MAX_DELIVERY_ATTEMPTS = 10
const WORKER_INTERVAL_MS = 5000
const RETRY_BASE_MS = 30000
const CALLBACK_TIMEOUT_MS = 15000
const MAIN_ORDER_SYNC_TIMEOUT_MS = 10000
const CALLBACK_CONCURRENCY = 3
const CALLBACK_RECOVERY_MS = 30 * 60 * 1000
const MAX_CALLBACK_RECOVERIES = 6
// 4xx 里只有超时/限流类值得重试，其余是商户端配置问题
const RETRYABLE_HTTP = new Set([408, 425, 429])
// 订单归档宽限期远大于支付宝交易有效期，避免误伤刚支付成功但回调还没到的订单
const ORDER_EXPIRE_GRACE_MS = 24 * 60 * 60 * 1000
const ORDER_SWEEP_INTERVAL_MS = 10 * 60 * 1000
const AMOUNT = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/
const MAX_ORDER_CENTS = 1_000_000
const at = () => new Date().toISOString()
const cents = (value) => {
  const match = AMOUNT.exec(String(value ?? '').trim())
  if (!match) return null
  const amount = Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'))
  return Number.isSafeInteger(amount) ? amount : null
}
const money = (value) => (Number(value || 0) / 100).toFixed(2)
const key = (prefix) => `${prefix}_${crypto.randomBytes(18).toString('base64url')}`
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex')
const wechatOrderNo = () => `SM${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(5).toString('hex').toUpperCase()}`.slice(0, 32)
function paymentForm(html) {
  const source = String(html || '')
  const form = source.match(/<form\b[^>]*>/i)?.[0] || ''
  const attr = (tag, name) => tag.match(new RegExp('\\b' + name + '\\s*=\\s*(?:["\\\']([^"\\\']*)["\\\']|([^\\s>]+))', 'i'))?.[1] || tag.match(new RegExp('\\b' + name + '\\s*=\\s*(?:["\\\']([^"\\\']*)["\\\']|([^\\s>]+))', 'i'))?.[2] || ''
  const action = attr(form, 'action')
  const fields = {}
  for (const input of source.matchAll(/<input\b[^>]*>/gi)) {
    const tag = input[0]
    const name = attr(tag, 'name')
    const value = attr(tag, 'value')
    if (name) fields[name] = value
  }
  return /^https:\/\/openapi\.alipay\.com\//.test(action) && Object.keys(fields).length ? { paymentUrl: action, paymentFields: fields } : null
}

function readSecret(name) {
  const value = String(process.env[name] || '')
  if (!value) throw new Error(`${name} 未配置`)
  return decryptSecret(value)
}

function wechatConfig(s) {
  const config = s.channels.wechat || {}
  if (!config.appId || !config.merchantId || !config.privateKeyPath || !config.publicKeyPath) throw new Error('微信 Native 配置不完整')
  const privateKey = fs.readFileSync(config.privateKeyPath, 'utf8')
  const certificatePath = config.certificatePath || '/etc/helstera/payment/wechat-apiclient_cert.pem'
  const certificate = new crypto.X509Certificate(fs.readFileSync(certificatePath, 'utf8'))
  const publicKey = fs.readFileSync(config.publicKeyPath, 'utf8')
  const apiV3Key = readSecret(config.apiV3KeyEnv || 'WECHAT_PAY_API_V3_KEY')
  if (apiV3Key.length !== 32) throw new Error('微信 API v3 密钥必须为 32 字节')
  return { ...config, privateKey, publicKey, apiV3Key, merchantSerial: certificate.serialNumber }
}

function wechatAuthorization(config, method, path, body = '') {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = crypto.randomBytes(16).toString('hex')
  const message = `${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`
  const signature = crypto.createSign('RSA-SHA256').update(message).sign(config.privateKey, 'base64')
  return { timestamp, nonce, signature, authorization: `WECHATPAY2-SHA256-RSA2048 mchid="${config.merchantId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${config.merchantSerial}",signature="${signature}"` }
}

async function wechatRequest(config, method, path, payload, idempotencyKey) {
  const body = payload === undefined ? '' : JSON.stringify(payload)
  const auth = wechatAuthorization(config, method, path, body)
  const response = await fetch(`https://api.mch.weixin.qq.com${path}`, { method, headers: { accept: 'application/json', 'content-type': 'application/json', authorization: auth.authorization, 'wechatpay-serial': config.publicKeyId || '', 'x-idempotency-key': idempotencyKey || crypto.randomUUID() }, body: body || undefined, signal: AbortSignal.timeout(12000) })
  const text = await response.text()
  let result = {}; try { result = text ? JSON.parse(text) : {} } catch { result = { message: text } }
  if (!response.ok) throw new Error(`微信 API ${response.status}: ${String(result.message || result.code || '请求失败')}`)
  return result
}

function decryptWechatResource(resource, apiV3Key) {
  if (!resource?.ciphertext || resource.algorithm !== 'AEAD_AES_256_GCM') throw new Error('微信回调密文格式无效')
  const key = Buffer.from(apiV3Key, 'utf8'); const nonce = Buffer.from(String(resource.nonce), 'utf8'); const aad = Buffer.from(String(resource.associated_data || ''), 'utf8'); const encrypted = Buffer.from(String(resource.ciphertext), 'base64'); const tag = encrypted.subarray(encrypted.length - 16); const data = encrypted.subarray(0, encrypted.length - 16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce); decipher.setAAD(aad); decipher.setAuthTag(tag)
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'))
}

const ENCRYPTED_SECRET_PREFIX = 'enc:v1:'

function secretMasterKey() {
  const path = String(process.env.PAYMENT_SECRET_KEY_FILE || process.env.LIGHTPAY_BRIDGE_SECRET_FILE || '').trim()
  if (!path) throw new Error('payment secret key file is not configured')
  const master = fs.readFileSync(path)
  if (!master.length) throw new Error('payment secret key file is empty')
  return crypto.createHash('sha256').update(master).digest()
}

function encryptSecret(value) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', secretMasterKey(), iv)
  const data = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()])
  return `${ENCRYPTED_SECRET_PREFIX}${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${data.toString('base64url')}`
}

function decryptSecret(value) {
  const text = String(value || '')
  if (!text.startsWith(ENCRYPTED_SECRET_PREFIX)) return text
  const [prefix, version, ivText, tagText, dataText] = text.split(':')
  if (`${prefix}:${version}:` !== ENCRYPTED_SECRET_PREFIX || !ivText || !tagText || !dataText) throw new Error('encrypted payment secret format is invalid')
  const decipher = crypto.createDecipheriv('aes-256-gcm', secretMasterKey(), Buffer.from(ivText, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(dataText, 'base64url')), decipher.final()]).toString('utf8')
}

function merchantSecret(row) {
  return decryptSecret(row?.apiSecret)
}

function setMerchantSecret(row, plain) {
  row.apiSecret = encryptSecret(plain)
  return plain
}

function migrateMerchantSecrets(s) {
  for (const row of s.merchants) {
    if (!row?.apiSecret || String(row.apiSecret).startsWith(ENCRYPTED_SECRET_PREFIX)) continue
    try { row.apiSecret = encryptSecret(row.apiSecret) } catch { /* secret key is checked when the secret is used */ }
  }
}

function buildBalanceSummaries(ledgerRows) {
  const summaries = Object.create(null)
  for (const row of ledgerRows) {
    if (!row?.merchantId) continue
    const summary = summaries[row.merchantId] || (summaries[row.merchantId] = { availableCents: 0, frozenCents: 0 })
    summary.availableCents += Number(row.availableDelta || 0)
    summary.frozenCents += Number(row.frozenDelta || 0)
  }
  return summaries
}

function state(store) {
  if (!store.payment || typeof store.payment !== 'object') store.payment = {}
  for (const name of ['merchants', 'ledger', 'settlements', 'refunds', 'orders', 'callbacks', 'syncJobs', 'paymentEvents', 'orderMirrors', 'accessTokens', 'invoiceApplications']) if (!Array.isArray(store.payment[name])) store.payment[name] = []
  if (!store.payment.channels || typeof store.payment.channels !== 'object') store.payment.channels = {}
  if (store.payment.balanceSummaryVersion !== 1 || !store.payment.balanceSummaries || typeof store.payment.balanceSummaries !== 'object') {
    store.payment.balanceSummaries = buildBalanceSummaries(store.payment.ledger)
    store.payment.balanceSummaryVersion = 1
  }
  migrateMerchantSecrets(store.payment)
  return store.payment
}
function merchant(s, id) { return s.merchants.find((row) => row.id === String(id)) }
function ownMerchant(s, userId) { const id = String(userId); return s.merchants.find((row) => row.userId === id || (Array.isArray(row.members) && row.members.some((member) => member.userId === id && member.enabled !== false))) }
function merchantForRequest(s, req) {
  const requested = String(req.query?.merchantId || req.headers['x-merchant-id'] || '').trim()
  if (requested && isAdminUser(req.user)) return merchant(s, requested)
  return ownMerchant(s, req.user?.id)
}
function isAdminUser(user) { return hasRole(user, 'admin') }
function publicMerchant(row) { return { id: row.id, userId: row.userId, username: row.username, displayName: row.displayName, apiId: row.apiId, enabled: row.enabled, callbackUrl: row.callbackUrl, callbackConfigured: safeCallback(row.callbackUrl), feeRate: row.feeRate, members: Array.isArray(row.members) ? row.members.map((member) => ({ userId: member.userId, username: member.username, enabled: member.enabled !== false, addedAt: member.addedAt })) : [], createdAt: row.createdAt, updatedAt: row.updatedAt } }
function balance(s, merchantId) {
  const summary = s.balanceSummaries[merchantId] || { availableCents: 0, frozenCents: 0 }
  return { availableCents: summary.availableCents, frozenCents: summary.frozenCents, available: money(summary.availableCents), frozen: money(summary.frozenCents) }
}
function ledger(s, entry) {
  if (!s.balanceSummaries || typeof s.balanceSummaries !== 'object') s.balanceSummaries = buildBalanceSummaries(s.ledger)
  const row = { id: crypto.randomUUID(), at: at(), ...entry }
  s.ledger.unshift(row)
  if (row.merchantId) {
    const summary = s.balanceSummaries[row.merchantId] || (s.balanceSummaries[row.merchantId] = { availableCents: 0, frozenCents: 0 })
    summary.availableCents += Number(row.availableDelta || 0)
    summary.frozenCents += Number(row.frozenDelta || 0)
  }
  return row
}

function paymentEventKey({ provider, eventId, orderId, tradeNo, amountCents }) {
  const stable = [provider, eventId, orderId, tradeNo, amountCents].map((value) => String(value || '')).join(':')
  return digest(stable)
}

function mainOrderSyncUrl() {
  return String(process.env.STARMC_MAIN_ORDER_SYNC_URL || process.env.MAIN_SITE_ORDER_SYNC_URL || '').trim()
}

function mainOrderSyncSecret() {
  const path = String(process.env.STARMC_MAIN_ORDER_SYNC_SECRET_FILE || '').trim()
  if (!path) throw Object.assign(new Error('main order sync secret is not configured'), { retryable: false })
  try {
    const secret = fs.readFileSync(path, 'utf8').trim()
    if (!secret) throw new Error('main order sync secret is empty')
    return secret
  } catch (error) {
    throw Object.assign(new Error(`main order sync secret unavailable: ${error.message}`), { retryable: false })
  }
}

function mirrorPayload(order, event) {
  return {
    event,
    orderId: order.id,
    merchantOrderId: order.merchantOrderId,
    merchantId: order.merchantId,
    channel: order.channel,
    subject: order.subject || 'StarMC order',
    amountCents: order.amountCents,
    amount: money(order.amountCents),
    platformFeeCents: order.platformFeeCents,
    merchantNetCents: order.merchantNetCents,
    status: order.status,
    tradeNo: order.tradeNo || null,
    paidAt: order.paidAt || null,
    createdAt: order.createdAt,
    expiresAt: order.expiresAt,
  }
}

function queueOrderMirror(s, order, event) {
  const key = digest(`v1:${event}:${order.id}`)
  if (s.orderMirrors.some((item) => item.idempotencyKey === key)) return
  s.orderMirrors.unshift({ id: crypto.randomUUID(), idempotencyKey: key, event, orderId: order.id, merchantId: order.merchantId, payload: mirrorPayload(order, event), status: 'queued', attempts: 0, nextAttemptAt: at(), createdAt: at() })
}

function accessTokenSecret() {
  const path = String(process.env.PAYMENT_ACCESS_TOKEN_SECRET_FILE || process.env.LIGHTPAY_BRIDGE_SECRET_FILE || '').trim()
  if (!path) throw new Error('payment access token secret is not configured')
  const secret = fs.readFileSync(path, 'utf8').trim()
  if (secret.length < 32) throw new Error('payment access token secret must be at least 32 characters')
  return secret
}

function encodeTokenPart(value) {
  return Buffer.from(value).toString('base64url')
}

function issueAccessToken(s, order, scope, ttlMs = 30 * 24 * 60 * 60 * 1000) {
  const expiresAt = new Date(Date.now() + ttlMs).toISOString()
  const payload = JSON.stringify({ v: 1, scope, orderId: order.id, exp: Date.parse(expiresAt), nonce: crypto.randomBytes(18).toString('base64url') })
  const encoded = encodeTokenPart(payload)
  const signature = crypto.createHmac('sha256', accessTokenSecret()).update(encoded).digest('base64url')
  const token = `${encoded}.${signature}`
  s.accessTokens.unshift({ id: crypto.randomUUID(), tokenHash: digest(token), scope, orderId: order.id, expiresAt, createdAt: at() })
  return token
}

function issueOrderAccessTokens(s, order) {
  const previous = [...s.accessTokens]
  try {
    return {
      order: issueAccessToken(s, order, 'order:read'),
      receipt: issueAccessToken(s, order, 'receipt:read'),
      invoice: issueAccessToken(s, order, 'invoice:create'),
    }
  } catch (error) {
    s.accessTokens.splice(0, s.accessTokens.length, ...previous)
    throw error
  }
}

function verifyAccessToken(s, token, scope, orderId) {
  const value = String(token || '')
  const [encoded, suppliedSignature, extra] = value.split('.')
  if (!encoded || !suppliedSignature || extra || encoded.length > 4096) return false
  let payload
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) } catch { return false }
  if (payload?.v !== 1 || payload.scope !== scope || payload.orderId !== orderId || !Number.isSafeInteger(payload.exp) || payload.exp <= Date.now()) return false
  let expectedSignature
  try { expectedSignature = crypto.createHmac('sha256', accessTokenSecret()).update(encoded).digest('base64url') } catch { return false }
  const supplied = Buffer.from(suppliedSignature)
  const expected = Buffer.from(expectedSignature)
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return false
  const record = s.accessTokens.find((item) => item.tokenHash === digest(value) && item.scope === scope && item.orderId === orderId && !item.revokedAt)
  return record && Date.parse(record.expiresAt || 0) > Date.now() ? record : false
}

function publicOrderAccess(order) {
  return { id: order.id, merchantOrderId: order.merchantOrderId, subject: order.subject || 'StarMC order', channel: order.channel, amount: money(order.amountCents), status: order.status, tradeNo: order.tradeNo || null, paidAt: order.paidAt || null, createdAt: order.createdAt, expiresAt: order.expiresAt }
}

function paymentStateSnapshot(s) {
  return { ledger: [...s.ledger], invoiceApplications: [...s.invoiceApplications], balanceSummaries: structuredClone(s.balanceSummaries) }
}

function restorePaymentState(s, snapshot) {
  s.ledger.splice(0, s.ledger.length, ...snapshot.ledger)
  s.invoiceApplications.splice(0, s.invoiceApplications.length, ...snapshot.invoiceApplications)
  s.balanceSummaries = snapshot.balanceSummaries
}

async function runPaymentTransaction(s, withTransaction, mutate) {
  const snapshot = paymentStateSnapshot(s)
  try {
    if (typeof withTransaction === 'function') return await withTransaction(mutate)
    return await mutate()
  } catch (error) {
    restorePaymentState(s, snapshot)
    throw error
  }
}

async function syncMainOrder(s, item) {
  const url = mainOrderSyncUrl()
  if (!url) throw Object.assign(new Error('main order sync URL is not configured'), { retryable: false })
  try { await assertPublicCallback(url) } catch (error) { throw Object.assign(error, { retryable: false }) }
  const secret = mainOrderSyncSecret()
  const raw = JSON.stringify(item.payload)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}
${item.idempotencyKey}
${raw}`).digest('hex')
  const response = await fetch(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', 'x-starmc-timestamp': timestamp, 'x-starmc-signature': `sha256=${signature}`, 'x-idempotency-key': item.idempotencyKey }, body: raw, redirect: 'error', signal: AbortSignal.timeout(MAIN_ORDER_SYNC_TIMEOUT_MS) })
  const text = await response.text().catch(() => '')
  let body = {}
  try { body = text ? JSON.parse(text) : {} } catch { body = {} }
  if (!response.ok || body.ok === false) {
    const error = Object.assign(new Error(`main order sync failed: HTTP ${response.status}`), { retryable: response.status >= 500 || RETRYABLE_HTTP.has(response.status) })
    throw error
  }
  item.lastHttpStatus = response.status
  item.lastResponseAt = at()
  item.mainOrderId = String(body.mainOrderId || body.order_id || body.orderId || item.mainOrderId || '') || null
}

export function applyPaymentSuccess(s, input) {
  const provider = String(input.provider || '').trim()
  const eventId = String(input.eventId || '').trim()
  const orderId = String(input.orderId || '').trim()
  const tradeNo = String(input.tradeNo || '').trim()
  const amountCents = Number(input.amountCents)
  const expectedChannel = String(input.channel || '').trim()
  const allowedProviders = new Set(['alipay', 'wechat', 'lightpay'])
  if (!allowedProviders.has(provider) || !eventId || !orderId || !Number.isSafeInteger(amountCents) || amountCents <= 0) return { ok: false, code: 'payment_event_invalid' }

  const order = s.orders.find((item) => item.id === orderId)
  if (!order) return { ok: false, code: 'order_not_found' }
  const row = merchant(s, order.merchantId)
  if (!row?.enabled) return { ok: false, code: 'merchant_disabled' }
  if (!channelId(order.channel) || (expectedChannel && expectedChannel !== order.channel)) return { ok: false, code: 'channel_mismatch' }
  if (!providerMatchesChannel(provider, order.channel)) return { ok: false, code: 'provider_channel_mismatch' }
  if (amountCents !== Number(order.amountCents)) return { ok: false, code: 'amount_mismatch' }

  const eventKey = paymentEventKey({ provider, eventId, orderId, tradeNo, amountCents })
  const sameEvent = s.paymentEvents.find((item) => item.provider === provider && item.eventId === eventId)
  if (sameEvent && (sameEvent.orderId !== order.id || Number(sameEvent.amountCents) !== amountCents || (tradeNo && sameEvent.tradeNo && sameEvent.tradeNo !== tradeNo))) return { ok: false, code: 'payment_event_replay_conflict' }
  const sameTrade = tradeNo && s.paymentEvents.find((item) => item.provider === provider && item.tradeNo === tradeNo)
  if (sameTrade && sameTrade.orderId !== order.id) return { ok: false, code: 'trade_number_reused' }
  const duplicate = s.paymentEvents.find((item) => item.eventKey === eventKey)
  const existingLedger = s.ledger.find((item) => item.type === 'payment_paid' && item.orderId === order.id)
  const ledgerMatchesEvent = existingLedger && existingLedger.provider === provider && existingLedger.eventId === eventId
  if (sameEvent || duplicate || ledgerMatchesEvent) return { ok: true, duplicate: true, order, event: sameEvent || duplicate || existingLedger }
  if (existingLedger || order.status === 'paid') return { ok: false, code: 'order_already_settled' }
  if (!['pending_sync', 'pending_payment', 'expired'].includes(order.status) || (order.status === 'expired' && (!order.expiresAt || Date.parse(order.expiresAt) + ORDER_EXPIRE_GRACE_MS < Date.now()))) return { ok: false, code: 'order_not_payable' }

  const fee = Number.isSafeInteger(Number(order.platformFeeCents)) ? Number(order.platformFeeCents) : Math.round(amountCents * Number(order.feeRate || FEE_RATE))
  const net = amountCents - fee
  const snapshot = { order: { ...order }, ledger: [...s.ledger], callbacks: [...s.callbacks], paymentEvents: [...s.paymentEvents], orderMirrors: [...s.orderMirrors], balanceSummaries: structuredClone(s.balanceSummaries) }
  try {
    const paidAt = at()
    order.status = 'paid'
    order.tradeNo = tradeNo || order.tradeNo || ''
    order.paidAt = paidAt
    order.paymentEventKey = eventKey
    ledger(s, { merchantId: row.id, orderId: order.id, type: 'payment_paid', provider, eventId, availableDelta: net, frozenDelta: 0, grossCents: amountCents, platformFeeCents: fee, merchantNetCents: net, tradeNo: order.tradeNo })
    s.paymentEvents.unshift({ id: crypto.randomUUID(), eventKey, provider, eventId, orderId: order.id, merchantId: row.id, channel: order.channel, amountCents, tradeNo: order.tradeNo, createdAt: paidAt })
    queueMerchantCallback(s, order, row)
    queueOrderMirror(s, order, 'order.paid')
    return { ok: true, duplicate: false, order, fee, net, eventId }
  } catch (error) {
    Object.assign(order, snapshot.order)
    s.ledger.splice(0, s.ledger.length, ...snapshot.ledger)
    s.callbacks.splice(0, s.callbacks.length, ...snapshot.callbacks)
    s.paymentEvents.splice(0, s.paymentEvents.length, ...snapshot.paymentEvents)
    s.orderMirrors.splice(0, s.orderMirrors.length, ...snapshot.orderMirrors)
    s.balanceSummaries = snapshot.balanceSummaries
    throw new Error(`payment success transaction rolled back: ${error.message}`)
  }
}
function isPrivateIp(value) {
  const ip = String(value || '').toLowerCase()
  if (ip.startsWith('::ffff:') && net.isIP(ip.slice(7)) === 4) return isPrivateIp(ip.slice(7))
  if (net.isIP(ip) === 4) {
    const parts = ip.split('.').map(Number)
    return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168)
  }
  if (net.isIP(ip) === 6) return ip === '::1' || ip === '::' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')
  return true
}

function safeCallback(value) {
  try {
    const url = new URL(String(value || ''))
    const host = url.hostname.toLowerCase()
    return url.protocol === 'https:' && !url.username && !url.password && host && host !== 'localhost' && (!net.isIP(host) || !isPrivateIp(host))
  } catch { return false }
}

async function assertPublicCallback(value) {
  if (!safeCallback(value)) throw new Error('callback URL must be a public HTTPS URL')
  const url = new URL(String(value))
  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true })
  if (!addresses.length || addresses.some((entry) => isPrivateIp(entry.address))) throw new Error('callback hostname resolves to a private or local address')
  return url
}

function channelId(value) { return ['alipay_web', 'alipay_scan', 'wechat_native', 'wechat_h5', 'wechat_jsapi'].includes(value) ? value : '' }
function channelName(id) { return id.startsWith('wechat_') ? 'wechat' : 'alipay' }
function providerMatchesChannel(provider, channel) {
  if (provider === 'wechat') return channel === 'wechat_native'
  if (provider === 'alipay') return channel.startsWith('alipay_')
  if (provider === 'lightpay') return channel.startsWith('alipay_')
  return false
}
function epayChannel(value) {
  return ({ alipay: 'alipay_web', alipay_web: 'alipay_web', alipay_scan: 'alipay_scan', scan: 'alipay_scan', wxpay: 'wechat_native', wechat: 'wechat_native', wechat_native: 'wechat_native', wechat_h5: 'wechat_h5', wechat_jsapi: 'wechat_jsapi' })[String(value || '').toLowerCase()] || ''
}
function epaySignature(params, secret) {
  const legacyMissingType = String(params._legacy_missing_type || '') === '1'
  const raw = Object.keys(params).filter((name) => !['sign', 'sign_type', '_legacy_missing_type'].includes(name) && !(legacyMissingType && name === 'type') && String(params[name] ?? '') !== '').sort().map((name) => `${name}=${params[name]}`).join('&')
  return crypto.createHash('md5').update(raw + secret).digest('hex')
}
function channelStatus(s, id) {
  const base = s.channels[channelName(id)] || {}
  const isWechat = channelName(id) === 'wechat'
  const paths = isWechat ? [base.privateKeyPath, base.publicKeyPath || base.platformCertificatePath] : [base.privateKeyPath, base.platformPublicKeyPath]
  const filesReady = paths.every((item) => typeof item === 'string' && item.length > 0 && fs.existsSync(item))
  const apiV3Ready = isWechat ? Boolean(base.apiV3KeyEnv && process.env[base.apiV3KeyEnv]) : true
  const nativeReady = Boolean(base.appId && base.merchantId && filesReady && apiV3Ready && (!isWechat || (base.verifyMode === 'wechat_public_key' ? base.publicKeyId : base.platformCertificatePath)))
  const h5Ready = nativeReady && Boolean(base.h5Domain)
  const jsapiReady = nativeReady && Boolean(base.jsapiAppId && base.jsapiNotifyDomain)
  const missing = []; if (!base.enabled) missing.push('渠道未启用'); if (!base.appId) missing.push('AppID'); if (!base.merchantId) missing.push('商户号'); if (!filesReady) missing.push(isWechat ? '商户私钥/微信公钥文件' : '私钥/平台公钥文件'); if (!apiV3Ready) missing.push('API v3 密钥环境变量'); if (!base.modes?.length) missing.push('支付模式'); if (isWechat && base.modes?.includes('wechat_h5') && !base.h5Domain) missing.push('H5 域名'); if (isWechat && base.modes?.includes('wechat_jsapi') && (!base.jsapiAppId || !base.jsapiNotifyDomain)) missing.push('JSAPI 配置')
  return { id: channelName(id), enabled: Boolean(base.enabled), ready: Boolean(base.enabled && nativeReady), missing, modes: base.modes || [], appId: base.appId || null, merchantId: base.merchantId || null, verifyMode: base.verifyMode || (isWechat ? 'platform_certificate' : null), publicKeyId: base.publicKeyId || null, h5Domain: base.h5Domain || null, jsapiAppId: base.jsapiAppId || null, jsapiNotifyDomain: base.jsapiNotifyDomain || null, nativeReady, h5Ready, jsapiReady, apiV3Configured: apiV3Ready, certificatePathsConfigured: filesReady }
}
// 只有仍在支付中的订单才下发渠道参数：已支付/已关闭的订单重复打开收银台会把订单再次提交到支付宝，
// 用户就会看到 PAYORDER_NOT_EXIST 之类的渠道报错。
function publicOrder(row, store) {
  const callback = store?.payment?.callbacks?.find((item) => item.orderId === row.id)
  const payable = row.status === 'pending_sync' || row.status === 'pending_payment'
  const hasHtml = payable && Boolean(row.paymentHtml)
  return { id: row.id, merchantOrderId: row.merchantOrderId, name: row.subject || row.name || row.merchantOrderId || '-', merchantId: row.merchantId, channel: row.channel, amountCents: row.amountCents, amount: money(row.amountCents), feeRate: row.feeRate, platformFeeCents: row.platformFeeCents, merchantNetCents: row.merchantNetCents, status: row.status, lastError: row.lastError || null, callbackStatus: callback?.status || null, callbackAttempts: callback?.attempts || 0, tradeNo: row.tradeNo || null, paymentUrl: payable && !hasHtml ? (row.paymentUrl || null) : null, paymentFields: payable ? (row.paymentFields || null) : null, paymentHtml: hasHtml ? row.paymentHtml : null, qrCode: payable ? (row.qrCode || null) : null, expiresAt: row.expiresAt, createdAt: row.createdAt, paidAt: row.paidAt || null, refundStatus: row.refundStatus || null }
}

function issueCheckoutToken(order) {
  const token = crypto.randomBytes(24).toString('base64url')
  order.checkoutTokenHash = digest(token)
  return token
}

function createOrder(s, row, input) {
  const amount = cents(input.amount)
  const channel = channelId(String(input.channel || ''))
  const merchantOrderId = String(input.merchantOrderId || '').trim()
  if (!amount || amount > MAX_ORDER_CENTS || !channel || !/^[A-Za-z0-9_-]{3,64}$/.test(merchantOrderId)) return { error: '订单号、金额或支付渠道无效' }
  const ready = channelStatus(s, channel)
  if (!ready.ready || !ready.modes.includes(channel)) return { error: `支付渠道尚未完成配置或未启用${ready.missing.length ? `：缺少${ready.missing.join('、')}` : `：未启用${channel}`}`, unavailable: true }
  let order = s.orders.find((item) => item.merchantId === row.id && item.merchantOrderId === merchantOrderId)
  if (order) {
    const notifyUrl = String(input.notifyUrl || '').trim()
    const returnUrl = String(input.returnUrl || '').trim()
    if (order.amountCents !== amount || order.channel !== channel || String(order.notifyUrl || '') !== notifyUrl || String(order.returnUrl || '') !== returnUrl) {
      return { error: '商户订单号已存在，但订单参数不一致', conflict: true }
    }
    const access = issueOrderAccessTokens(s, order)
    return { order, token: issueCheckoutToken(order), access, duplicate: true }
  }
  const feeRate = Number.isFinite(Number(row.feeRate)) ? Number(row.feeRate) : FEE_RATE
  const fee = Math.round(amount * feeRate)
  const notifyUrl = String(input.notifyUrl || '').trim()
  if (notifyUrl && !safeCallback(notifyUrl)) return { error: '通知地址必须是 HTTPS 公网地址' }
  order = { id: crypto.randomUUID(), merchantId: row.id, merchantOrderId, channel, subject: String(input.subject || '网站订单').trim().slice(0, 128), notifyUrl: notifyUrl || null, callbackUrl: notifyUrl || row.callbackUrl, returnUrl: String(input.returnUrl || '').trim() || null, amountCents: amount, feeRate, platformFeeCents: fee, merchantNetCents: amount - fee, createdBy: String(row.userId), status: 'pending_sync', createdAt: at(), expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() }
  const access = issueOrderAccessTokens(s, order)
  const token = issueCheckoutToken(order)
  s.orders.unshift(order)
  queueOrderMirror(s, order, 'order.created')
  s.syncJobs.unshift({ id: crypto.randomUUID(), orderId: order.id, kind: 'channel_projection', status: 'queued', attempts: 0, nextAttemptAt: at(), createdAt: at() })
  return { order, token, access, duplicate: false }
}

function retryAt(attempts) {
  const delay = Math.min(60 * 60 * 1000, RETRY_BASE_MS * (2 ** Math.max(0, attempts - 1)))
  return new Date(Date.now() + delay).toISOString()
}

function due(row) {
  return row.status === 'queued' && Date.parse(row.nextAttemptAt || 0) <= Date.now()
}

function queueMerchantCallback(s, order, row) {
  if (s.callbacks.some((item) => item.orderId === order.id && item.event === 'payment.paid')) return
  const callbackUrl = String(order.callbackUrl || order.notifyUrl || row.callbackUrl || '').trim()
  if (!safeCallback(callbackUrl)) throw new Error('merchant callback URL is not a safe HTTPS public URL')
  const payload = {
    event: 'payment.paid',
    orderId: order.id,
    merchantOrderId: order.merchantOrderId,
    amount: money(order.amountCents),
    platformFee: money(order.platformFeeCents),
    merchantNet: money(order.merchantNetCents),
    tradeNo: order.tradeNo || '',
    paidAt: order.paidAt,
    pid: row.apiId,
    trade_no: order.tradeNo || '',
    out_trade_no: order.merchantOrderId,
    type: order.channel.startsWith('wechat') ? 'wxpay' : 'alipay',
    name: order.subject || '网站订单',
    money: money(order.amountCents),
    trade_status: 'TRADE_SUCCESS',
  }
  s.callbacks.unshift({ id: crypto.randomUUID(), merchantId: row.id, orderId: order.id, event: payload.event, url: callbackUrl, payload, status: 'queued', attempts: 0, nextAttemptAt: at(), createdAt: at() })
}

async function projectOrder(s, job) {
  const order = s.orders.find((item) => item.id === job.orderId)
  if (!order || order.status === 'closed') throw new Error('订单不存在或已关闭')
  const row = merchant(s, order.merchantId)
  if (!row?.enabled) throw new Error('商户不存在或已停用')
  if (order.channel === 'wechat_native') {
    const config = wechatConfig(s)
    const outTradeNo = order.wechatOutTradeNo || wechatOrderNo()
    order.wechatOutTradeNo = outTradeNo
    const payload = { appid: config.appId, mchid: config.merchantId, description: order.subject || 'StarMC Pay 订单', out_trade_no: outTradeNo, notify_url: 'https://star-web.top/api/payment/wechat/notify', amount: { total: order.amountCents, currency: 'CNY' } }
    const result = await wechatRequest(config, 'POST', '/v3/pay/transactions/native', payload, job.id)
    if (!result.code_url) throw new Error('微信未返回 code_url')
    order.qrCode = String(result.code_url)
    order.paymentUrl = null
    order.status = 'pending_payment'
    order.syncedAt = at()
    return
  }
  if (!order.channel.startsWith('alipay_')) throw new Error(`渠道适配器尚未实现: ${order.channel}`)

  const payload = JSON.stringify({
    _bridge_token: bridgeSecret(),
    amount: money(order.amountCents),
    orderId: order.id,
    merchantId: row.id,
    callbackUrl: row.callbackUrl,
    callbackSecret: merchantSecret(row),
    returnUrl: order.returnUrl || '',
    sponsor_name: row.displayName,
    subject: `订单 ${order.merchantOrderId}`,
    method: order.channel === 'alipay_scan' ? 'scan' : 'web',
  })
  const url = String(process.env.LIGHTPAY_GATEWAY_ORDER_URL || 'https://star-web.top/pay/api/project.php')
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lightpay-bridge': bridgeSecret(), 'x-internal-bridge': bridgeSecret(), 'x-idempotency-key': job.id },
    body: payload,
    signal: AbortSignal.timeout(10000),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.ok !== true) throw new Error(String(body.error || `网关返回 HTTP ${response.status}`))
  order.gatewayOrderId = String(body.order_id || '')
  order.paymentUrl = body.payment_url ? String(body.payment_url) : null
  order.qrCode = body.qr_code ? String(body.qr_code) : null
  order.paymentHtml = body.payment_html ? String(body.payment_html) : null
  const form = paymentForm(order.paymentHtml)
  order.paymentUrl = form?.paymentUrl || order.paymentUrl
  order.paymentFields = form?.paymentFields || null
  if (!form && order.paymentHtml) order.paymentUrl = null
  order.status = 'pending_payment'
  order.syncedAt = at()
}

// 密钥文件读一次就缓存：原实现在每个 /api/internal/payment/* 请求里同步读盘，
// 既有磁盘 I/O 开销，也让密钥无法在不重启的情况下轮换到新内容。
// 用 60s 短 TTL 折中：常态零 I/O，轮换最多 1 分钟生效。文件变化（inode/mtime/size）
// 会立即失效缓存，所以原地覆盖写入也认得出来。
const BRIDGE_SECRET_TTL_MS = 60 * 1000
let bridgeSecretCache = { value: '', expiresAt: 0, fingerprint: '' }

function bridgeSecretPath() {
  return String(process.env.LIGHTPAY_BRIDGE_SECRET_FILE || '/etc/helstera/lightpay-bridge.secret')
}

function bridgeSecretFingerprint(path) {
  try {
    const st = fs.statSync(path)
    return `${st.ino}:${st.mtimeMs}:${st.size}`
  } catch {
    return ''
  }
}

/**
 * 读取桥接密钥。失败时抛错，由调用方决定如何响应（保持原来的 503 语义）。
 * @returns {string} 去空白后的密钥内容
 */
function bridgeSecret() {
  const path = bridgeSecretPath()
  const now = Date.now()
  const fingerprint = bridgeSecretFingerprint(path)
  if (bridgeSecretCache.value && bridgeSecretCache.expiresAt > now && bridgeSecretCache.fingerprint === fingerprint) {
    return bridgeSecretCache.value
  }
  const value = fs.readFileSync(path, 'utf8').trim()
  // 空密钥不缓存，避免把「文件暂时为空」这个坏状态固化一分钟。
  if (value) bridgeSecretCache = { value, expiresAt: now + BRIDGE_SECRET_TTL_MS, fingerprint }
  return value
}

// 易支付端只接受表单参数 + MD5 签名，并要求响应体为 success；收到 JSON 会以
// HTTP 200 + fail 拒绝，所以必须表单优先投递，并且按响应体而不是状态码判定成败。
function epayNotifyParams(item, row) {
  const params = {
    pid: row.apiId,
    trade_no: String(item.payload.tradeNo || item.payload.orderId || ''),
    out_trade_no: String(item.payload.merchantOrderId || ''),
    type: String(item.payload.type || 'alipay'),
    name: String(item.payload.name || 'StarMC Pay order'),
    money: String(item.payload.money || item.payload.amount || '0.00'),
    trade_status: 'TRADE_SUCCESS',
  }
  params.sign = epaySignature(params, merchantSecret(row))
  params.sign_type = 'MD5'
  return params
}

async function postCallback(url, { headers, body }) {
  try {
    const response = await fetch(url, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS) })
    const text = await response.text().catch(() => '')
    return { ok: response.ok, status: response.status, body: text.slice(0, 300), failed: false }
  } catch (error) {
    return { ok: false, status: 0, body: '', failed: true, reason: String(error?.message || error).slice(0, 200) }
  }
}

function epayAccepted(result) {
  return result.ok && /success/i.test(result.body) && !/fail/i.test(result.body)
}

async function deliverCallback(s, item) {
  const row = merchant(s, item.merchantId)
  if (!row?.enabled) throw new Error('merchant is disabled')
  await assertPublicCallback(item.url)

  const form = await postCallback(item.url, {
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-idempotency-key': item.id },
    body: new URLSearchParams(epayNotifyParams(item, row)).toString(),
  })
  if (epayAccepted(form)) {
    item.deliveryFormat = 'epay_form'
    item.lastHttpStatus = form.status
    item.lastResponseBody = form.body
    item.lastResponseAt = at()
    return
  }

  const raw = JSON.stringify(item.payload)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = 'sha256=' + crypto.createHmac('sha256', merchantSecret(row)).update(`${timestamp}\n${raw}`).digest('hex')
  const json = await postCallback(item.url, {
    headers: { 'content-type': 'application/json', 'x-lightpay-timestamp': timestamp, 'x-lightpay-signature': signature, 'x-lightpay-event': item.event, 'x-idempotency-key': item.id },
    body: raw,
  })
  item.deliveryFormat = 'lightpay_json'
  item.lastHttpStatus = json.status
  item.lastResponseBody = json.body
  item.lastResponseAt = at()
  if (json.ok) return

  const codes = [form.status, json.status]
  const retryable = form.failed || json.failed || codes.some((code) => code >= 500 || RETRYABLE_HTTP.has(code))
  const formDetail = form.failed ? `表单 ${form.reason}` : `表单 HTTP ${form.status}${form.body ? ` ${form.body.slice(0, 60)}` : ''}`
  const jsonDetail = json.failed ? `JSON ${json.reason}` : `JSON HTTP ${json.status}`
  const error = new Error(`商户回调失败: ${formDetail}；${jsonDetail}`)
  error.retryable = retryable
  throw error
}

export function startPaymentWorkers({ getStore, scheduleSave, logger = console }) {
  let running = false
  const recovered = state(getStore())
  for (const row of [...recovered.syncJobs, ...recovered.callbacks, ...recovered.orderMirrors]) {
    if (row.status !== 'processing') continue
    row.status = 'queued'
    row.nextAttemptAt = at()
    row.lastError = '服务重启后自动恢复未完成任务'
  }
  scheduleSave()
  const runTask = async (s, task) => {
    const row = task.row
    row.status = 'processing'
    row.attempts = Number(row.attempts || 0) + 1
    row.lastAttemptAt = at()
    try {
      if (task.kind === 'sync') await projectOrder(s, row)
      else if (task.kind === 'mirror') await syncMainOrder(s, row)
      else await deliverCallback(s, row)
      row.status = 'succeeded'
      row.completedAt = at()
      row.lastError = null
    } catch (error) {
      row.lastError = String(error?.message || error).slice(0, 500)
      const retryable = task.kind === 'sync' ? true : error?.retryable !== false
      const failedOrder = task.kind === 'sync' ? s.orders.find((item) => item.id === row.orderId) : null
      const permanentChannelError = task.kind === 'sync' && /^微信 API 4\d\d:/.test(row.lastError)
      if (failedOrder) { failedOrder.lastError = row.lastError; if (permanentChannelError || row.attempts >= MAX_DELIVERY_ATTEMPTS) failedOrder.status = 'failed' }
      row.retryable = retryable
      row.status = (!retryable || permanentChannelError || row.attempts >= MAX_DELIVERY_ATTEMPTS) ? 'dead_letter' : 'queued'
      row.nextAttemptAt = row.status === 'queued' ? retryAt(row.attempts) : null
      logger.warn(`[payment-worker] ${task.kind} ${row.id} failed: ${row.lastError}`)
    }
    scheduleSave()
  }

  let lastSweep = 0
  // 只有网络类失败的死信值得再捞一次；配置类错误反复投递只会持续骚扰商户
  const sweepDeadLetters = (s) => {
    if (Date.now() - lastSweep < CALLBACK_RECOVERY_MS) return
    lastSweep = Date.now()
    let recovered = 0
    for (const item of s.callbacks) {
      if (item.status !== 'dead_letter' || item.retryable !== true) continue
      if (Number(item.recoveries || 0) >= MAX_CALLBACK_RECOVERIES) continue
      if (Date.now() - Date.parse(item.completedAt || item.lastAttemptAt || item.createdAt || 0) < CALLBACK_RECOVERY_MS) continue
      item.recoveries = Number(item.recoveries || 0) + 1
      item.status = 'queued'
      item.attempts = 0
      item.nextAttemptAt = at()
      item.lastError = null
      recovered += 1
    }
    if (recovered) { scheduleSave(); logger.warn(`[payment-worker] 重新入队 ${recovered} 条网络失败回调`) }
  }

  let lastOrderSweep = 0
  const sweepStaleOrders = (s) => {
    if (Date.now() - lastOrderSweep < ORDER_SWEEP_INTERVAL_MS) return
    lastOrderSweep = Date.now()
    // 已经收到渠道付款的订单（有 paidAt 或已入账）永远不能归档
    const settled = new Set(s.ledger.filter((item) => item.type === 'payment_paid' && item.orderId).map((item) => item.orderId))
    let archived = 0
    for (const order of s.orders) {
      if (order.status !== 'pending_payment' && order.status !== 'pending_sync') continue
      if (order.paidAt || settled.has(order.id)) continue
      const expires = Date.parse(order.expiresAt || 0)
      if (!expires || Date.now() - expires < ORDER_EXPIRE_GRACE_MS) continue
      order.status = 'expired'
      order.closedAt = at()
      archived += 1
    }
    if (archived) { scheduleSave(); logger.warn(`[payment-worker] 归档 ${archived} 笔超时未支付订单`) }
  }

  const tick = async () => {
    if (running) return
    running = true
    try {
      const s = state(getStore())
      sweepDeadLetters(s)
      sweepStaleOrders(s)
      const tasks = [
        ...s.syncJobs.filter(due).slice(0, 5).map((job) => ({ kind: 'sync', row: job })),
        ...s.orderMirrors.filter(due).slice(0, 5).map((item) => ({ kind: 'mirror', row: item })),
        ...s.callbacks.filter(due).slice(0, 10).map((item) => ({ kind: 'callback', row: item })),
      ]
      for (let i = 0; i < tasks.length; i += CALLBACK_CONCURRENCY) {
        await Promise.all(tasks.slice(i, i + CALLBACK_CONCURRENCY).map((task) => runTask(s, task)))
      }
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void tick(), WORKER_INTERVAL_MS)
  if (typeof timer.unref === 'function') timer.unref()
  void tick()
  return () => clearInterval(timer)
}

export function summarizeSyncQueues(stateValue) {
  const queues = [
    ['channel_projection', stateValue?.syncJobs],
    ['main_order_mirror', stateValue?.orderMirrors],
    ['merchant_callback', stateValue?.callbacks],
    ['invoice', stateValue?.invoiceApplications],
  ].map(([name, rows]) => {
    const list = Array.isArray(rows) ? rows : []
    const pending = list.filter((row) => ['queued', 'processing', 'pending', 'issuing'].includes(String(row.status || '').toLowerCase()))
    const failed = list.filter((row) => ['failed', 'dead_letter', 'rejected', 'unknown'].includes(String(row.status || '').toLowerCase()))
    const latestFailure = failed.slice().sort((left, right) => Date.parse(right.updatedAt || right.createdAt || right.at || 0) - Date.parse(left.updatedAt || left.createdAt || left.at || 0))[0]
    return {
      name,
      total: list.length,
      pending: pending.length,
      failed: failed.length,
      oldestPendingAt: pending.map((row) => row.createdAt || row.at).filter(Boolean).sort()[0] || null,
      latestError: latestFailure?.lastError || latestFailure?.error || null,
    }
  })
  return { queues, totals: { pending: queues.reduce((sum, row) => sum + row.pending, 0), failed: queues.reduce((sum, row) => sum + row.failed, 0) } }
}

export function registerPaymentRoutes(app, deps) {
  const { requireUser, requireAdmin, config, getStore, jsonOk, jsonErr, scheduleSave, appendAuditLog, withTransaction, requireCsrf } = deps
  registerPaymentMigrationSnapshot(app, getStore)
  const save = () => scheduleSave()
  const audit = (action, detail, req) => appendAuditLog?.(action, detail, req)
  const paymentCsrf = (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.path.includes('/notify') || req.path.includes('/internal/')) return next()
    if (!req.user) return next()
    if (typeof requireCsrf === 'function') return requireCsrf(req, res, next)
    const origin = String(req.headers.origin || '').trim()
    const referer = String(req.headers.referer || '').trim()
    const expectedHost = String(req.headers.host || '').toLowerCase()
    const sameOrigin = (value) => { try { return value && new URL(value).host.toLowerCase() === expectedHost } catch { return false } }
    if (sameOrigin(origin) || (!origin && sameOrigin(referer))) return next()
    return jsonErr(res, 403, 'CSRF token or same-origin request required', 'csrf_required')
  }
  app.use(['/api/payment', '/api/merchant', '/api/admin/payment', '/api/admin/merchants'], paymentCsrf)

  app.post('/api/payment/wechat/notify', async (req, res) => {
    try {
      const s = state(getStore()); const config = wechatConfig(s); const timestamp = String(req.headers['wechatpay-timestamp'] || ''); const nonce = String(req.headers['wechatpay-nonce'] || ''); const signature = String(req.headers['wechatpay-signature'] || ''); const serial = String(req.headers['wechatpay-serial'] || '')
      const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {})
      if (!timestamp || !nonce || !signature || serial !== String(config.publicKeyId)) return res.status(401).json({ code: 'SIGN_ERROR', message: '签名头无效' })
      if (Math.abs(Date.now() - Number(timestamp) * 1000) > 300000) return res.status(401).json({ code: 'SIGN_ERROR', message: '通知时间已过期' })
      const verified = crypto.createVerify('RSA-SHA256').update(`${timestamp}\n${nonce}\n${raw}\n`).verify(config.publicKey, signature, 'base64')
      if (!verified) return res.status(401).json({ code: 'SIGN_ERROR', message: '通知签名无效' })
      const transaction = decryptWechatResource(req.body?.resource, config.apiV3Key)
      if (transaction.mchid !== config.merchantId || transaction.appid !== config.appId || transaction.trade_state !== 'SUCCESS') return res.status(400).json({ code: 'PARAM_ERROR', message: '交易信息无效' })
      const order = s.orders.find((item) => (item.id === String(transaction.out_trade_no) || item.wechatOutTradeNo === String(transaction.out_trade_no)) && item.channel === 'wechat_native')
      const paidCents = Number(transaction.amount?.total)
      if (!order || paidCents !== order.amountCents) return res.status(400).json({ code: 'PARAM_ERROR', message: '订单或金额不匹配' })
      const posted = applyPaymentSuccess(s, { provider: 'wechat', channel: 'wechat_native', eventId: String(transaction.transaction_id || transaction.out_trade_no), orderId: order.id, tradeNo: String(transaction.transaction_id || ''), amountCents: paidCents })
      if (!posted.ok) return res.status(posted.code === 'merchant_disabled' ? 409 : 400).json({ code: 'PARAM_ERROR', message: posted.code })
      if (!posted.duplicate) { save(); audit('payment_wechat_paid', { merchantId: order.merchantId, orderId: order.id, tradeNo: posted.order.tradeNo, eventId: posted.eventId }, req) }
      return res.json({ code: 'SUCCESS', message: 'SUCCESS' })
    } catch (error) {
      console.error('[payment-wechat-notify]', error?.message || error)
      return res.status(400).json({ code: 'FAIL', message: '通知处理失败' })
    }
  })

  app.post('/api/internal/payment/paid', (req, res) => {
    let expected = ''
    try { expected = bridgeSecret() } catch { return jsonErr(res, 503, '支付记账桥接未配置', 'bridge_unconfigured') }
    const supplied = String(req.headers['x-lightpay-bridge'] || '')
    const expectedBytes = Buffer.from(expected); const suppliedBytes = Buffer.from(supplied)
    if (!expected || !supplied || expectedBytes.length !== suppliedBytes.length || !crypto.timingSafeEqual(expectedBytes, suppliedBytes)) return jsonErr(res, 401, '支付桥接未授权', 'bridge_unauthorized')
    const merchantId = String(req.body?.merchantId || '').trim(); const orderId = String(req.body?.orderId || '').trim(); const gross = cents(req.body?.amount)
    if (!merchantId || !orderId || !gross) return jsonErr(res, 400, '支付记账参数无效', 'validation_error')
    const s = state(getStore()); const row = merchant(s, merchantId)
    if (!row || !row.enabled) return jsonErr(res, 409, '商户不存在或已停用', 'merchant_disabled')
    const order = s.orders.find((item) => item.merchantId === merchantId && (item.id === orderId || item.gatewayOrderId === orderId || item.merchantOrderId === orderId))
    if (!order) return jsonErr(res, 409, 'order_not_found', 'order_not_found')
    if (order.amountCents !== gross) return jsonErr(res, 409, 'order_mismatch', 'order_mismatch')
    const suppliedChannel = String(req.body?.channel || '').trim()
    const posted = applyPaymentSuccess(s, { provider: 'lightpay', channel: suppliedChannel || order.channel, eventId: String(req.body?.eventId || req.body?.tradeNo || order.gatewayOrderId || order.id), orderId: order.id, tradeNo: String(req.body?.tradeNo || ''), amountCents: gross })
    if (!posted.ok) return jsonErr(res, 409, posted.code, posted.code)
    if (!posted.duplicate) { save(); audit('payment_paid_posted', { merchantId, orderId: order.id, gross: money(gross), fee: money(posted.fee), eventId: posted.eventId }, req) }
    return jsonOk(res, { orderId: order.id, gross: money(gross), platformFee: money(posted.fee || order.platformFeeCents), merchantNet: money(posted.net || order.merchantNetCents), balance: balance(s, merchantId), duplicate: posted.duplicate }, posted.duplicate ? 200 : 201)
  })
  app.post('/api/internal/payment/merchant-auth', (req, res) => {
    let expected = ''
    try { expected = bridgeSecret() } catch { return jsonErr(res, 503, '支付商户桥接未配置', 'bridge_unconfigured') }
    const supplied = String(req.headers['x-lightpay-bridge'] || ''); const expectedBytes = Buffer.from(expected); const suppliedBytes = Buffer.from(supplied)
    if (!expected || !supplied || expectedBytes.length !== suppliedBytes.length || !crypto.timingSafeEqual(expectedBytes, suppliedBytes)) return jsonErr(res, 401, '支付桥接未授权', 'bridge_unauthorized')
    const apiId = String(req.body?.apiId || '').trim(); const timestamp = String(req.body?.timestamp || '').trim(); const signature = String(req.body?.signature || '').trim(); const raw = String(req.body?.raw || '')
    const when = Number(timestamp); const s = state(getStore()); const row = s.merchants.find((item) => item.apiId === apiId)
    if (!row || !row.enabled) return jsonErr(res, 401, '商户凭据无效或商户已停用', 'merchant_unauthorized')
    if (!Number.isSafeInteger(when) || Math.abs(Date.now() - when * 1000) > 300000) return jsonErr(res, 401, '商户请求时间无效或已过期', 'merchant_timestamp_invalid')
    const expectedSignature = 'sha256=' + crypto.createHmac('sha256', merchantSecret(row)).update(`${timestamp}\n${raw}`).digest('hex')
    const signatureBytes = Buffer.from(signature); const expectedSignatureBytes = Buffer.from(expectedSignature)
    if (signatureBytes.length !== expectedSignatureBytes.length || !crypto.timingSafeEqual(signatureBytes, expectedSignatureBytes)) return jsonErr(res, 401, '商户请求签名无效', 'merchant_signature_invalid')
    return jsonOk(res, { merchantId: row.id, callbackUrl: row.callbackUrl, callbackSecret: merchantSecret(row) })
  })

  app.post('/api/internal/payment/epay-order', (req, res) => {
    let expected = ''
    try { expected = bridgeSecret() } catch { return jsonErr(res, 503, '支付桥接未配置', 'bridge_unconfigured') }
    const supplied = String(req.headers['x-lightpay-bridge'] || '')
    const expectedBytes = Buffer.from(expected); const suppliedBytes = Buffer.from(supplied)
    if (!expected || !supplied || expectedBytes.length !== suppliedBytes.length || !crypto.timingSafeEqual(expectedBytes, suppliedBytes)) return jsonErr(res, 401, '支付桥接未授权', 'bridge_unauthorized')
    const params = req.body && typeof req.body === 'object' ? req.body : {}
    const s = state(getStore()); const legacyTest = String(params.pid || '') === '1000' && /^TEST[A-Za-z0-9_-]{3,64}$/.test(String(params.out_trade_no || ''))
    const row = s.merchants.find((item) => item.apiId === String(params.pid || '')) || (legacyTest ? s.merchants.find((item) => item.ownerType === 'admin_default' && item.enabled) : null)
    if (!row?.enabled) return jsonErr(res, 401, '商户不存在或已停用', 'merchant_unauthorized')
    const suppliedSign = String(params.sign || '').toLowerCase(); const expectedSign = epaySignature(params, merchantSecret(row))
    const signBytes = Buffer.from(suppliedSign); const expectedSignBytes = Buffer.from(expectedSign)
    if (!legacyTest && (String(params.sign_type || 'MD5').toUpperCase() !== 'MD5' || signBytes.length !== expectedSignBytes.length || !crypto.timingSafeEqual(signBytes, expectedSignBytes))) return jsonErr(res, 401, '易支付请求签名无效', 'merchant_signature_invalid')
    const created = createOrder(s, row, { merchantOrderId: params.out_trade_no, amount: params.money, channel: epayChannel(params.type), subject: params.name, notifyUrl: params.notify_url, returnUrl: params.return_url })
    if (created.error) return jsonErr(res, created.conflict ? 409 : created.unavailable ? 503 : 400, created.error, created.conflict ? 'order_conflict' : created.unavailable ? 'channel_not_ready' : 'validation_error')
    save(); audit('payment_epay_order_created', { orderId: created.order.id, merchantId: row.id, duplicate: created.duplicate }, req)
    return jsonOk(res, { order: publicOrder(created.order, getStore()), checkoutToken: created.token, access: created.access, duplicate: created.duplicate }, created.duplicate ? 200 : 201)
  })

  app.get('/api/payment/checkout/:id', (req, res) => {
    const s = state(getStore()); const order = s.orders.find((item) => item.id === String(req.params.id)); const token = String(req.query?.token || '')
    const supplied = Buffer.from(digest(token)); const expected = Buffer.from(String(order?.checkoutTokenHash || ''))
    if (!order || !token || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return jsonErr(res, 404, '收银台订单不存在或访问凭证无效', 'checkout_not_found')
    if (['pending_sync', 'pending_payment'].includes(order.status) && order.expiresAt && Date.parse(order.expiresAt) <= Date.now()) {
      order.status = 'expired'
      order.closedAt = at()
      scheduleSave()
    }
    const publicRow = publicOrder(order, getStore())
    if (!publicRow.paymentHtml && !publicRow.qrCode && !publicRow.paymentUrl && order.status === 'pending_payment') return jsonErr(res, 503, '支付渠道参数尚未生成，请稍后重试', 'payment_parameters_pending')
    return jsonOk(res, { order: { ...publicRow, subject: order.subject || '网站订单' } })
  })

  app.get('/api/payment/order/:id', (req, res) => {
    const s = state(getStore())
    const order = s.orders.find((item) => item.id === String(req.params.id))
    const record = order && verifyAccessToken(s, req.query?.token, 'order:read', order.id)
    if (!order || !record) return jsonErr(res, 404, '订单不存在或访问凭证无效', 'order_access_denied')
    return jsonOk(res, { order: publicOrderAccess(order) })
  })

  app.get('/api/payment/receipt/:id', (req, res) => {
    const s = state(getStore())
    const order = s.orders.find((item) => item.id === String(req.params.id))
    const record = order && verifyAccessToken(s, req.query?.token, 'receipt:read', order.id)
    if (!order || !record) return jsonErr(res, 404, '收据不存在或访问凭证无效', 'receipt_access_denied')
    if (order.status !== 'paid') return jsonErr(res, 409, '订单尚未支付成功', 'receipt_not_ready')
    return jsonOk(res, { receipt: { receiptNo: `R-${order.id}`, order: publicOrderAccess(order), issuedAt: order.paidAt } })
  })

  app.post('/api/payment/invoice/:id', async (req, res) => {
    const s = state(getStore())
    const order = s.orders.find((item) => item.id === String(req.params.id))
    const record = order && verifyAccessToken(s, req.body?.token || req.query?.token, 'invoice:create', order.id)
    if (!order || !record) return jsonErr(res, 404, '订单不存在或访问凭证无效', 'invoice_access_denied')
    if (order.status !== 'paid') return jsonErr(res, 409, '订单尚未支付成功', 'invoice_not_ready')
    const title = String(req.body?.title || '').trim().slice(0, 160)
    const taxId = String(req.body?.taxId || '').trim().slice(0, 64)
    const email = String(req.body?.email || '').trim().slice(0, 254)
    if (!title || !taxId || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonErr(res, 400, '请填写有效的发票抬头、税号和邮箱', 'invoice_validation_error')
    const configuredFee = cents(process.env.PAYMENT_INVOICE_FEE || '0')
    const feeCents = configuredFee === null ? null : configuredFee
    if (feeCents === null) return jsonErr(res, 503, '开票费用配置无效', 'invoice_fee_unconfigured')

    try {
      const application = await runPaymentTransaction(s, withTransaction, async () => {
        const freshOrder = s.orders.find((item) => item.id === order.id)
        if (!freshOrder || freshOrder.status !== 'paid') throw Object.assign(new Error('invoice_not_ready'), { code: 'invoice_not_ready' })
        if (s.invoiceApplications.some((item) => item.orderId === freshOrder.id && item.status !== 'rejected')) throw Object.assign(new Error('invoice_already_requested'), { code: 'invoice_already_requested' })
        const current = balance(s, freshOrder.merchantId)
        if (feeCents > current.availableCents) throw Object.assign(new Error('invoice_fee_insufficient_balance'), { code: 'invoice_fee_insufficient_balance' })
        const applicationRow = { id: crypto.randomUUID(), orderId: freshOrder.id, merchantId: freshOrder.merchantId, title, taxId, email, feeCents, status: 'pending', createdAt: at() }
        if (feeCents > 0) ledger(s, { merchantId: freshOrder.merchantId, orderId: freshOrder.id, type: 'invoice_fee', availableDelta: -feeCents, frozenDelta: 0, grossCents: feeCents, reason: 'invoice_application', invoiceApplicationId: applicationRow.id })
        s.invoiceApplications.unshift(applicationRow)
        return applicationRow
      })
      scheduleSave()
      return jsonOk(res, { application, balance: balance(s, order.merchantId) }, 201)
    } catch (error) {
      const code = String(error?.code || error?.message || 'invoice_transaction_failed')
      const status = code === 'invoice_fee_insufficient_balance' || code === 'invoice_already_requested' ? 409 : 503
      return jsonErr(res, status, code, code)
    }
  })

  app.get('/api/admin/payment/config', requireUser, requireAdmin, (_req, res) => {
    const payload = { provider: 'alipay', appId: config.alipayAppId || null, returnUrl: config.paymentReturnUrl || null, notifyUrl: config.paymentNotifyUrl || null, privateKeyConfigured: Boolean(config.alipayPrivateKey), publicKeyConfigured: Boolean(config.alipayPublicKey) }
    const store = getStore(); const feeRate = Number(store.payment?.feeRate ?? FEE_RATE)
    return res.json({ ...payload, feeRate, effective: 'new_orders_only', ready: Boolean(payload.appId && payload.returnUrl && payload.notifyUrl && payload.privateKeyConfigured && payload.publicKeyConfigured) })
  })
  app.get('/api/admin/audit/payment', requireUser, requireAdmin, (req, res) => {
    const store = getStore(); const merchantId = String(req.query?.merchantId || '')
    const logs = (store.securityCenter?.auditLogs || []).filter((entry) => {
      if (!merchantId) return String(entry.action || '').startsWith('payment_')
      return String(entry.action || '').startsWith('payment_') && (!entry.detail?.merchantId || String(entry.detail.merchantId) === merchantId)
    }).slice(0, 500)
    return jsonOk(res, { logs })
  })
  app.patch('/api/admin/payment/config/fee', requireUser, requireAdmin, (req, res) => {
    const rate = Number(req.body?.feeRate)
    if (!Number.isFinite(rate) || rate < 0 || rate > 0.5) return jsonErr(res, 400, '平台费率必须在 0% 至 50% 之间', 'invalid_fee_rate')
    const store = getStore(); store.payment = store.payment || {}; store.payment.feeRate = rate; scheduleSave(); appendAuditLog?.('payment_fee_rate_updated', { feeRate: rate }, req)
    return jsonOk(res, { feeRate: rate, effective: 'new_orders_only' })
  })
  app.get('/api/admin/merchants/:id/summary', requireUser, requireAdmin, (req, res) => {
    const s = state(getStore()); const row = merchant(s, req.params.id)
    if (!row) return jsonErr(res, 404, '商户不存在', 'merchant_not_found')
    const orders = s.orders.filter((item) => item.merchantId === row.id)
    return jsonOk(res, { merchant: publicMerchant(row), balance: balance(s, row.id), members: publicMerchant(row).members, orders: { total: orders.length, paid: orders.filter((item) => item.status === 'paid').length, pending: orders.filter((item) => ['pending_sync', 'pending_payment'].includes(item.status)).length, failed: orders.filter((item) => item.status === 'failed').length, refunding: orders.filter((item) => item.status === 'refund_processing').length, refunded: orders.filter((item) => item.status === 'refunded').length, grossCents: orders.filter((item) => item.status === 'paid').reduce((sum, item) => sum + item.amountCents, 0), platformFeeCents: orders.filter((item) => item.status === 'paid').reduce((sum, item) => sum + item.platformFeeCents, 0) } })
  })
  app.get('/api/admin/merchants/:id/context', requireUser, requireAdmin, (req, res) => {
    const s = state(getStore()); const row = merchant(s, req.params.id)
    if (!row) return jsonErr(res, 404, '商户不存在', 'merchant_not_found')
    return jsonOk(res, { merchant: { ...publicMerchant(row), balance: balance(s, row.id) } })
  })
  app.get('/api/admin/merchants', requireUser, requireAdmin, (req, res) => {
    const s = state(getStore())
    const requestedId = String(req.query?.merchantId || '').trim()
    if (requestedId) {
      const row = merchant(s, requestedId)
      if (!row) return jsonErr(res, 404, '商户不存在', 'merchant_not_found')
      return jsonOk(res, { merchants: [{ ...publicMerchant(row), balance: balance(s, row.id) }] })
    }
    return jsonOk(res, { merchants: s.merchants.map((row) => ({ ...publicMerchant(row), balance: balance(s, row.id) })) })
  })
  app.post('/api/admin/merchants', requireUser, requireAdmin, (req, res) => {
    const userId = String(req.body?.userId || '').trim(); const callbackUrl = String(req.body?.callbackUrl || '').trim(); const store = getStore(); const s = state(store)
    const user = (store.users || []).find((row) => String(row.id) === userId)
    if (!user) return jsonErr(res, 404, '未找到要绑定的 StarMC 用户', 'user_not_found')
    if (ownMerchant(s, userId)) return jsonErr(res, 409, '该用户已绑定商户', 'merchant_already_bound')
    if (!safeCallback(callbackUrl)) return jsonErr(res, 400, '商户回调地址必须是安全的 HTTPS 公网地址', 'unsafe_callback_url')
    const plainSecret = key('lps')
    const row = { id: crypto.randomUUID(), userId, username: String(user.username || user.email || user.id), displayName: String(req.body?.displayName || user.username || user.email || '').trim().slice(0, 80), apiId: key('lp'), apiSecret: encryptSecret(plainSecret), members: [], callbackUrl, enabled: true, feeRate: Number(state(store).feeRate ?? FEE_RATE), createdAt: at(), updatedAt: at() }
    user.roles = Array.isArray(user.roles) ? [...new Set([...user.roles, 'merchant'])] : ['merchant']
    s.merchants.push(row); save(); audit('payment_merchant_created', { merchantId: row.id, userId, callbackUrl }, req)
    return jsonOk(res, { merchant: publicMerchant(row), apiSecret: plainSecret }, 201)
  })
  app.patch('/api/admin/merchants/:id/status', requireUser, requireAdmin, (req, res) => { const s = state(getStore()); const row = merchant(s, req.params.id); if (!row) return jsonErr(res, 404, '商户不存在', 'merchant_not_found'); if (typeof req.body?.enabled !== 'boolean') return jsonErr(res, 400, 'enabled 必须为布尔值', 'validation_error'); row.enabled = req.body.enabled; row.updatedAt = at(); save(); audit('payment_merchant_status_changed', { merchantId: row.id, enabled: row.enabled }, req); return jsonOk(res, { merchant: publicMerchant(row) }) })
  app.patch('/api/admin/merchants/:id/fee', requireUser, requireAdmin, (req, res) => { const s = state(getStore()); const row = merchant(s, req.params.id); const rate = Number(req.body?.feeRate); if (!row) return jsonErr(res, 404, '商户不存在', 'merchant_not_found'); if (!Number.isFinite(rate) || rate < 0 || rate > 0.5) return jsonErr(res, 400, '商户费率必须在 0% 至 50% 之间', 'invalid_fee_rate'); row.feeRate = rate; row.updatedAt = at(); save(); audit('payment_merchant_fee_updated', { merchantId: row.id, feeRate: rate }, req); return jsonOk(res, { merchant: publicMerchant(row), effective: 'new_orders_only' }) })
  app.get('/api/admin/merchants/:id/members', requireUser, requireAdmin, (req, res) => { const row = merchant(state(getStore()), req.params.id); return row ? jsonOk(res, { members: publicMerchant(row).members }) : jsonErr(res, 404, '商户不存在', 'merchant_not_found') })
  app.post('/api/admin/merchants/:id/members', requireUser, requireAdmin, (req, res) => { const store = getStore(); const s = state(store); const row = merchant(s, req.params.id); const userId = String(req.body?.userId || '').trim(); const user = (store.users || []).find((item) => String(item.id) === userId); if (!row) return jsonErr(res, 404, '商户不存在', 'merchant_not_found'); if (!userId || !user) return jsonErr(res, 400, '请选择现有 StarMC 账户', 'user_not_found'); if (userId === row.userId) return jsonErr(res, 409, '商户所有者无需重复授权', 'member_owner'); row.members = Array.isArray(row.members) ? row.members : []; const existing = row.members.find((member) => member.userId === userId); if (existing) existing.enabled = true; else row.members.push({ userId, username: String(user.username || user.email || userId), enabled: true, addedAt: at() }); row.updatedAt = at(); save(); audit('payment_merchant_member_granted', { merchantId: row.id, userId }, req); return jsonOk(res, { merchant: publicMerchant(row) }) })
  app.patch('/api/admin/merchants/:id/members/:userId', requireUser, requireAdmin, (req, res) => { const s = state(getStore()); const row = merchant(s, req.params.id); const member = row?.members?.find((item) => item.userId === String(req.params.userId)); if (!row || !member) return jsonErr(res, 404, '授权账户不存在', 'member_not_found'); if (typeof req.body?.enabled !== 'boolean') return jsonErr(res, 400, 'enabled 必须为布尔值', 'validation_error'); member.enabled = req.body.enabled; row.updatedAt = at(); save(); audit('payment_merchant_member_status_changed', { merchantId: row.id, userId: member.userId, enabled: member.enabled }, req); return jsonOk(res, { merchant: publicMerchant(row) }) })
  app.post('/api/admin/merchants/:id/rotate-secret', requireUser, requireAdmin, (req, res) => { const s = state(getStore()); const row = merchant(s, req.params.id); if (!row) return jsonErr(res, 404, '商户不存在', 'merchant_not_found'); const plainSecret = key('lps'); setMerchantSecret(row, plainSecret); row.updatedAt = at(); save(); audit('payment_merchant_secret_rotated', { merchantId: row.id }, req); return jsonOk(res, { apiId: row.apiId, apiSecret: plainSecret }) })
  app.get('/api/admin/merchants/:id/ledger', requireUser, requireAdmin, (req, res) => {
    const store = getStore()
    const s = state(store)
    const row = merchant(s, req.params.id)
    if (!row) return jsonErr(res, 404, '商户不存在', 'merchant_not_found')
    const usersById = new Map((store.users || []).map((user) => [String(user.id), String(user.username || user.email || user.id)]))
    const ledgerRows = s.ledger.filter((item) => item.merchantId === row.id).slice(0, 500).map((item) => ({
      ...item,
      ...(item.actorId ? { actorName: usersById.get(String(item.actorId)) || String(item.actorId) } : {}),
    }))
    return jsonOk(res, { merchant: publicMerchant(row), balance: balance(s, row.id), ledger: ledgerRows })
  })
  app.post('/api/admin/merchants/:id/adjustments', requireUser, requireAdmin, (req, res) => {
    const s = state(getStore()); const row = merchant(s, req.params.id); const amount = cents(req.body?.amount); const reason = String(req.body?.reason || '').trim().slice(0, 300); const direction = req.body?.direction === 'credit' ? 1 : req.body?.direction === 'debit' ? -1 : 0
    if (!row) return jsonErr(res, 404, '商户不存在', 'merchant_not_found')
    if (!amount || !reason || !direction) return jsonErr(res, 400, '请填写正金额、原因及 credit 或 debit 方向', 'validation_error')
    const compositeBalanceApproved = req.body?.allowNegative === true
    if (direction < 0 && !compositeBalanceApproved && balance(s, row.id).availableCents < amount) return jsonErr(res, 409, '可用余额不足，不能扣减', 'insufficient_balance')
    const entry = ledger(s, { merchantId: row.id, type: 'manual_adjustment', availableDelta: direction * amount, frozenDelta: 0, reason, actorId: String(req.user.id) }); save(); audit('payment_manual_adjustment', { merchantId: row.id, entryId: entry.id, amount: money(direction * amount), reason }, req); return jsonOk(res, { entry, balance: balance(s, row.id) }, 201)
  })
  app.get('/api/admin/settlements', requireUser, requireAdmin, (_req, res) => jsonOk(res, { settlements: state(getStore()).settlements }))
  app.post('/api/admin/settlements/:id/decision', requireUser, requireAdmin, (req, res) => {
    const s = state(getStore()); const row = s.settlements.find((item) => item.id === String(req.params.id)); const decision = String(req.body?.decision || ''); const reference = String(req.body?.reference || '').trim().slice(0, 200)
    if (!row) return jsonErr(res, 404, '结算申请不存在', 'settlement_not_found')
    if (row.status !== 'pending') return jsonErr(res, 409, '该结算申请已处理', 'settlement_already_processed')
    if (!['paid', 'rejected'].includes(decision)) return jsonErr(res, 400, 'decision 必须为 paid 或 rejected', 'validation_error')
    if (decision === 'paid' && !reference) return jsonErr(res, 400, '完成结算必须录入打款凭证', 'payout_reference_required')
    row.status = decision; row.reviewedAt = at(); row.reviewedBy = String(req.user.id); row.reference = reference || null
    ledger(s, { merchantId: row.merchantId, type: decision === 'paid' ? 'manual_payout' : 'settlement_unfreeze', availableDelta: decision === 'rejected' ? row.amountCents : 0, frozenDelta: -row.amountCents, settlementId: row.id, reason: row.note || '', actorId: String(req.user.id) }); save(); audit('payment_settlement_decision', { settlementId: row.id, decision, reference: Boolean(reference) }, req); return jsonOk(res, { settlement: row })
  })
  app.get('/api/admin/refunds', requireUser, requireAdmin, (_req, res) => jsonOk(res, { refunds: state(getStore()).refunds }))
  app.post('/api/admin/refunds', requireUser, requireAdmin, (req, res) => {
    const s = state(getStore()); const row = merchant(s, req.body?.merchantId); const amount = cents(req.body?.amount); const reference = String(req.body?.reference || '').trim().slice(0, 200)
    if (!row) return jsonErr(res, 404, '商户不存在', 'merchant_not_found')
    if (!amount || !reference) return jsonErr(res, 400, '退款金额和人工退款凭证不能为空', 'validation_error')
    const refund = { id: crypto.randomUUID(), merchantId: row.id, amountCents: amount, reference, orderId: String(req.body?.orderId || '').trim() || null, status: balance(s, row.id).availableCents >= amount ? 'recorded' : 'pending_balance', createdAt: at(), createdBy: String(req.user.id) }
    if (refund.status === 'recorded') ledger(s, { merchantId: row.id, type: 'manual_refund', availableDelta: -amount, frozenDelta: 0, refundId: refund.id, reason: reference, actorId: String(req.user.id) })
    s.refunds.unshift(refund); save(); audit('payment_manual_refund_recorded', { refundId: refund.id, merchantId: row.id, status: refund.status }, req); return jsonOk(res, { refund, balance: balance(s, row.id) }, 201)
  })
  app.get('/api/admin/payment/channels', requireUser, requireAdmin, (_req, res) => {
    const s = state(getStore())
    return jsonOk(res, { channels: ['alipay_web', 'wechat_native'].map((id) => channelStatus(s, id)) })
  })
  app.put('/api/admin/payment/channels/:channel', requireUser, requireAdmin, (req, res) => {
    const name = String(req.params.channel || ''); if (!['alipay', 'wechat'].includes(name)) return jsonErr(res, 404, '支付渠道不存在', 'channel_not_found')
    const s = state(getStore()); const old = s.channels[name] || {}; const modes = Array.isArray(req.body?.modes) ? req.body.modes.filter((item) => channelId(item) && channelName(item) === name) : old.modes || []
    const paths = ['privateKeyPath', name === 'alipay' ? 'platformPublicKeyPath' : 'platformCertificatePath', ...(name === 'wechat' ? ['publicKeyPath'] : [])]
    for (const field of paths) if (req.body?.[field] !== undefined && !String(req.body[field]).startsWith('/etc/helstera/')) return jsonErr(res, 400, '证书路径必须位于 /etc/helstera/', 'unsafe_secret_path')
    s.channels[name] = { ...old, enabled: Boolean(req.body?.enabled), appId: String(req.body?.appId || old.appId || '').trim(), merchantId: String(req.body?.merchantId || old.merchantId || '').trim(), privateKeyPath: String(req.body?.privateKeyPath || old.privateKeyPath || '').trim(), platformPublicKeyPath: String(req.body?.platformPublicKeyPath || old.platformPublicKeyPath || '').trim(), platformCertificatePath: String(req.body?.platformCertificatePath || old.platformCertificatePath || '').trim(), publicKeyPath: name === 'wechat' ? String(req.body?.publicKeyPath || old.publicKeyPath || '').trim() : '', publicKeyId: name === 'wechat' ? String(req.body?.publicKeyId || old.publicKeyId || '').trim() : '', verifyMode: name === 'wechat' ? String(req.body?.verifyMode || old.verifyMode || 'wechat_public_key') : '', h5Domain: name === 'wechat' ? String(req.body?.h5Domain || old.h5Domain || '').trim() : '', jsapiAppId: name === 'wechat' ? String(req.body?.jsapiAppId || old.jsapiAppId || '').trim() : '', jsapiNotifyDomain: name === 'wechat' ? String(req.body?.jsapiNotifyDomain || old.jsapiNotifyDomain || '').trim() : '', apiV3KeyEnv: name === 'wechat' ? String(req.body?.apiV3KeyEnv || old.apiV3KeyEnv || '').trim() : '', modes, updatedAt: at() }
    save(); audit('payment_channel_config_updated', { channel: name, enabled: s.channels[name].enabled, modes }, req)
    return jsonOk(res, { channel: channelStatus(s, name === 'alipay' ? 'alipay_web' : 'wechat_native') })
  })
  app.post('/api/admin/payment/channels/:channel/upload', requireUser, requireAdmin, (req, res) => {
    const name = String(req.params.channel || ''); if (!['alipay', 'wechat'].includes(name)) return jsonErr(res, 404, '支付渠道不存在', 'channel_not_found')
    const kind = String(req.body?.kind || ''); const filename = String(req.body?.filename || '').replace(/[^A-Za-z0-9._-]/g, '_'); const encoded = String(req.body?.contentBase64 || '')
    const allowed = name === 'alipay' ? ['privateKey', 'platformPublicKey'] : ['privateKey', 'platformCertificate', 'publicKey']
    if (!allowed.includes(kind) || !filename || encoded.length > 2_000_000) return jsonErr(res, 400, '文件类型或大小无效', 'invalid_upload')
    let content; try { content = Buffer.from(encoded, 'base64') } catch { return jsonErr(res, 400, '文件内容无效', 'invalid_upload') }
    if (!content.length || content.length > 1_000_000) return jsonErr(res, 400, '文件内容无效或过大', 'invalid_upload')
    const root = '/etc/helstera/payment'; fs.mkdirSync(root, { recursive: true, mode: 0o700 }); const target = `${root}/${name}-${kind}-${crypto.randomBytes(6).toString('hex')}-${filename}`
    fs.writeFileSync(target, content, { mode: 0o600 }); const s = state(getStore()); const row = s.channels[name] || {}; const field = kind === 'privateKey' ? 'privateKeyPath' : kind === 'platformPublicKey' ? 'platformPublicKeyPath' : kind === 'publicKey' ? 'publicKeyPath' : 'platformCertificatePath'; row[field] = target; s.channels[name] = row; save(); audit('payment_channel_file_uploaded', { channel: name, kind, filename }, req)
    return jsonOk(res, { channel: name, kind, filename, configured: true })
  })
  app.post('/api/admin/payment/channels/wechat/health', requireUser, requireAdmin, (_req, res) => { const s = state(getStore()); const status = channelStatus(s, 'wechat_native'); return jsonOk(res, { status, checks: { credentials: status.nativeReady, native: status.nativeReady && status.modes.includes('wechat_native'), h5: status.h5Ready && status.modes.includes('wechat_h5'), jsapi: status.jsapiReady && status.modes.includes('wechat_jsapi') } }) })
  app.get('/api/admin/payment/orders', requireUser, requireAdmin, (req, res) => { const s = state(getStore()); const status = String(req.query?.status || ''); return jsonOk(res, { orders: s.orders.filter((row) => !status || row.status === status).slice(0, 500).map(publicOrder) }) })
  app.get('/api/admin/payment/callbacks', requireUser, requireAdmin, (_req, res) => jsonOk(res, { callbacks: state(getStore()).callbacks.slice(0, 500) }))
  app.post('/api/admin/payment/callbacks/:id/retry', requireUser, requireAdmin, (req, res) => { const s = state(getStore()); const item = s.callbacks.find((row) => row.id === String(req.params.id)); if (!item) return jsonErr(res, 404, '回调记录不存在', 'callback_not_found'); item.status = 'queued'; item.nextAttemptAt = at(); item.attempts = 0; save(); audit('payment_callback_requeued', { callbackId: item.id }, req); return jsonOk(res, { callback: item }) })
  app.get('/api/admin/payment/sync-jobs', requireUser, requireAdmin, (_req, res) => jsonOk(res, { jobs: state(getStore()).syncJobs.slice(0, 500) }))
  app.get('/api/admin/payment/order-mirrors', requireUser, requireAdmin, (_req, res) => jsonOk(res, { mirrors: state(getStore()).orderMirrors.slice(0, 500) }))
  app.get('/api/admin/payment/sync-status', requireUser, requireAdmin, (_req, res) => {
    const s = state(getStore())
    const summary = summarizeSyncQueues(s)
    return jsonOk(res, { generatedAt: at(), ...summary })
  })
  app.post('/api/admin/payment/order-mirrors/:id/retry', requireUser, requireAdmin, (req, res) => { const s = state(getStore()); const item = s.orderMirrors.find((row) => row.id === String(req.params.id)); if (!item) return jsonErr(res, 404, '订单同步记录不存在', 'order_mirror_not_found'); item.status = 'queued'; item.attempts = 0; item.nextAttemptAt = at(); item.lastError = null; save(); return jsonOk(res, { mirror: item }) })
  app.post('/api/admin/payment/sync-jobs/:id/retry', requireUser, requireAdmin, (req, res) => { const s = state(getStore()); const job = s.syncJobs.find((row) => row.id === String(req.params.id)); if (!job) return jsonErr(res, 404, '同步任务不存在', 'sync_job_not_found'); job.status = 'queued'; job.attempts = 0; job.nextAttemptAt = at(); save(); return jsonOk(res, { job }) })
  app.post('/api/merchant/orders', (req, res, next) => {
    if (req.user || req.headers['x-lightpay-api-id']) return next()
    return requireUser(req, res, next)
  }, (req, res) => {
    const s = state(getStore()); let row = req.user ? merchantForRequest(s, req) : null
    if (!row) { const apiId = String(req.headers['x-lightpay-api-id'] || '').trim(); const timestamp = String(req.headers['x-lightpay-timestamp'] || '').trim(); const signature = String(req.headers['x-lightpay-signature'] || '').trim(); const candidate = s.merchants.find((item) => item.apiId === apiId); const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody.toString('utf8') : JSON.stringify(req.body); const expected = candidate && 'sha256=' + crypto.createHmac('sha256', merchantSecret(candidate)).update(`${timestamp}\n${raw}`).digest('hex'); const expectedBytes = Buffer.from(expected || ''); const signatureBytes = Buffer.from(signature); if (!candidate || !candidate.enabled || !Number.isSafeInteger(Number(timestamp)) || Math.abs(Date.now() - Number(timestamp) * 1000) > 300000 || signatureBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(signatureBytes, expectedBytes)) return jsonErr(res, 401, '商户凭据无效', 'merchant_unauthorized'); row = candidate }
    if (!row || !row.enabled) return jsonErr(res, 403, '当前账户未获有效商户授权', 'merchant_disabled')
    const created = createOrder(s, row, req.body || {})
    if (created.error) return jsonErr(res, created.conflict ? 409 : created.unavailable ? 503 : 400, created.error, created.conflict ? 'order_conflict' : created.unavailable ? 'channel_not_ready' : 'validation_error')
    save(); audit('payment_order_created', { orderId: created.order.id, merchantId: row.id, channel: created.order.channel, amount: money(created.order.amountCents), duplicate: created.duplicate }, req)
    return jsonOk(res, { order: publicOrder(created.order, getStore()), checkoutToken: created.token, access: created.access, duplicate: created.duplicate }, created.duplicate ? 200 : 201)
  })
  app.get('/api/merchant/orders', requireUser, (req, res) => {
    const s = state(getStore())
    const row = merchantForRequest(s, req)
    if (!row) return jsonErr(res, 404, '当前账户未获商户授权', 'merchant_not_found')
    const page = Math.max(1, Math.min(100000, Math.floor(Number(req.query?.page) || 1)))
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(req.query?.pageSize) || 20)))
    const search = String(req.query?.search || '').trim().toLowerCase()
    const category = String(req.query?.category || 'all').trim().toLowerCase()
    const merchantOrders = s.orders.filter((item) => {
      if (item.merchantId !== row.id) return false
      const matchesSearch = !search || [item.id, item.merchantOrderId, item.subject, item.name].some((value) => String(value || '').toLowerCase().includes(search))
      if (!matchesSearch) return false
      if (category === 'main' || category === 'epay') return (item.source || (String(item.channel || '').startsWith('epay') ? 'epay' : 'main')) === category
      if (category === 'paid') return item.status === 'paid'
      if (category === 'pending') return ['pending_payment', 'pending_sync'].includes(item.status)
      if (category === 'closed') return ['closed', 'failed', 'expired', 'refunded', 'refund_processing'].includes(item.status)
      return true
    })
    const sortedOrders = merchantOrders.slice().sort((left, right) => {
      const timeOrder = Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0)
      return timeOrder || String(right.id).localeCompare(String(left.id))
    })
    const total = sortedOrders.length
    const offset = (page - 1) * pageSize
    return jsonOk(res, {
      orders: sortedOrders.slice(offset, offset + pageSize).map(publicOrder),
      pageInfo: { page, pageSize, total, totalPages: Math.ceil(total / pageSize), hasNext: offset + pageSize < total, hasPrevious: page > 1 },
    })
  })
  app.post('/api/merchant/orders/:id/invoice', requireUser, async (req, res) => {
    const s = state(getStore())
    const row = merchantForRequest(s, req)
    const order = s.orders.find((item) => item.id === String(req.params.id) && item.merchantId === row?.id)
    if (!row || !order) return jsonErr(res, 404, '订单不存在', 'order_not_found')
    if (order.status !== 'paid') return jsonErr(res, 409, '订单尚未支付成功', 'invoice_not_ready')
    const title = String(req.body?.title || '').trim().slice(0, 160)
    const taxId = String(req.body?.taxId || '').trim().slice(0, 64)
    const email = String(req.body?.email || '').trim().slice(0, 254)
    if (!title || !taxId || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonErr(res, 400, '请填写有效的发票抬头、税号和邮箱', 'invoice_validation_error')
    const configuredFee = cents(process.env.PAYMENT_INVOICE_FEE || '0')
    if (configuredFee === null) return jsonErr(res, 503, '开票费用配置无效', 'invoice_fee_unconfigured')
    try {
      const application = await runPaymentTransaction(s, withTransaction, async () => {
        const freshOrder = s.orders.find((item) => item.id === order.id)
        if (!freshOrder || freshOrder.status !== 'paid') throw Object.assign(new Error('invoice_not_ready'), { code: 'invoice_not_ready' })
        if (s.invoiceApplications.some((item) => item.orderId === freshOrder.id && item.status !== 'rejected')) throw Object.assign(new Error('invoice_already_requested'), { code: 'invoice_already_requested' })
        const current = balance(s, freshOrder.merchantId)
        if (configuredFee > current.availableCents) throw Object.assign(new Error('invoice_fee_insufficient_balance'), { code: 'invoice_fee_insufficient_balance' })
        const applicationRow = { id: crypto.randomUUID(), orderId: freshOrder.id, merchantId: freshOrder.merchantId, title, taxId, email, feeCents: configuredFee, status: 'pending', createdAt: at() }
        if (configuredFee > 0) ledger(s, { merchantId: freshOrder.merchantId, orderId: freshOrder.id, type: 'invoice_fee', availableDelta: -configuredFee, frozenDelta: 0, grossCents: configuredFee, reason: 'invoice_application', invoiceApplicationId: applicationRow.id })
        s.invoiceApplications.unshift(applicationRow)
        return applicationRow
      })
      save()
      audit('payment_invoice_requested', { merchantId: row.id, orderId: order.id, invoiceApplicationId: application.id }, req)
      return jsonOk(res, { application, balance: balance(s, row.id) }, 201)
    } catch (error) {
      const code = String(error?.code || error?.message || 'invoice_transaction_failed')
      const status = code === 'invoice_fee_insufficient_balance' || code === 'invoice_already_requested' ? 409 : 503
      return jsonErr(res, status, code, code)
    }
  })

  app.get('/api/merchant/orders/:id', requireUser, (req, res) => { const store = getStore(); const s = state(store); const row = merchantForRequest(s, req); const order = s.orders.find((item) => item.id === String(req.params.id) && item.merchantId === row?.id); return order ? jsonOk(res, { order: publicOrder(order, store) }) : jsonErr(res, 404, '订单不存在', 'order_not_found') })
  app.post('/api/merchant/orders/:id/close', requireUser, (req, res) => { const s = state(getStore()); const row = merchantForRequest(s, req); const order = s.orders.find((item) => item.id === String(req.params.id) && item.merchantId === row?.id); if (!order) return jsonErr(res, 404, '订单不存在', 'order_not_found'); if (!['pending_sync', 'pending_payment'].includes(order.status)) return jsonErr(res, 409, '当前订单不能关闭', 'order_not_closable'); order.status = 'closed'; order.closedAt = at(); save(); return jsonOk(res, { order: publicOrder(order) }) })
  app.post('/api/merchant/refunds', requireUser, (req, res) => {
    const s = state(getStore()); const row = merchantForRequest(s, req); const order = s.orders.find((item) => item.id === String(req.body?.orderId || '') && item.merchantId === row?.id)
    if (!order) return jsonErr(res, 404, '订单不存在', 'order_not_found')
    if (order.status !== 'paid') return jsonErr(res, 409, '只有已支付订单可以申请退款', 'order_not_refundable')
    if (order.refundStatus === 'pending' || order.refundStatus === 'completed') return jsonErr(res, 409, '该订单已有退款处理记录', 'refund_exists')
    const amount = cents(req.body?.amount); if (!amount || amount > order.amountCents) return jsonErr(res, 400, '退款金额无效', 'validation_error')
    const refund = { id: crypto.randomUUID(), merchantId: row.id, orderId: order.id, amountCents: amount, channel: order.channel, status: 'pending', reason: String(req.body?.reason || '').trim().slice(0, 300), createdAt: at(), createdBy: String(req.user.id) }
    order.refundStatus = 'pending'; s.refunds.unshift(refund); save(); audit('payment_refund_requested', { refundId: refund.id, orderId: order.id }, req); return jsonOk(res, { refund }, 201)
  })
  app.post('/api/admin/payment/refunds/:id/approve', requireUser, requireAdmin, (req, res) => {
    const s = state(getStore()); const refund = s.refunds.find((item) => item.id === String(req.params.id)); if (!refund) return jsonErr(res, 404, '退款申请不存在', 'refund_not_found')
    if (refund.status !== 'pending') return jsonErr(res, 409, '退款申请已处理', 'refund_already_processed')
    const order = s.orders.find((item) => item.id === refund.orderId); if (!order) return jsonErr(res, 409, '退款订单不存在', 'order_not_found')
    const current = balance(s, refund.merchantId); const debit = Math.min(refund.amountCents, order.merchantNetCents)
    if (current.availableCents < debit) { refund.status = 'pending_balance'; save(); return jsonErr(res, 409, '商户余额不足，已进入人工处理队列', 'insufficient_balance') }
    refund.status = 'processing'; refund.approvedAt = at(); refund.approvedBy = String(req.user.id); order.status = 'refund_processing'; save(); audit('payment_refund_approved', { refundId: refund.id, orderId: order.id }, req)
    return jsonOk(res, { refund, order: publicOrder(order), message: '渠道退款任务已进入待同步队列' })
  })
  app.get('/api/merchant/access', requireUser, (req, res) => {
    res.set('Cache-Control', 'no-store')
    const requested = req.query?.merchantId
    if (typeof requested !== 'string' || !requested.trim() || requested.length > 128) return jsonErr(res, 400, '请指定商户', 'merchant_id_required')
    const merchants = getStore()?.payment?.merchants
    if (!Array.isArray(merchants)) return jsonErr(res, 503, '商户服务暂不可用', 'merchant_store_unavailable')
    const row = merchants.find((item) => item?.id === requested.trim())
    const userId = String(req.user?.id || '')
    const admin = isAdminUser(req.user)
    const owner = Boolean(userId && row?.userId === userId)
    const member = Boolean(userId && Array.isArray(row?.members) && row.members.some((item) => item?.userId === userId && item.enabled !== false))
    if (!userId || !row || row.enabled === false || (!admin && !owner && !member)) return jsonErr(res, 404, '当前账户未获商户授权', 'merchant_not_found')
    if (merchants.filter((item) => item?.id === row.id).length !== 1) return jsonErr(res, 503, '商户绑定信息不唯一', 'merchant_binding_unavailable')
    if (typeof row.apiId !== 'string' || !row.apiId || row.apiId !== row.apiId.trim() || row.apiId.length > 80) return jsonErr(res, 503, '商户绑定信息不完整', 'merchant_binding_unavailable')
    if (merchants.filter((item) => item?.apiId === row.apiId).length !== 1) return jsonErr(res, 503, '商户绑定信息不唯一', 'merchant_binding_unavailable')
    return jsonOk(res, { merchantId: row.id, apiId: row.apiId, userId, role: admin ? 'admin' : owner ? 'owner' : 'member' })
  })

  app.get('/api/merchant/profile', requireUser, (req, res) => {
    const s = state(getStore()); let row = merchantForRequest(s, req)
    if (!row && isAdminUser(req.user)) {
      row = { id: crypto.randomUUID(), userId: String(req.user.id), username: String(req.user.username || req.user.email || req.user.id), displayName: String(req.user.username || req.user.email || '管理员商户').slice(0, 80), apiId: key('lp'), apiSecret: encryptSecret(key('lps')), members: [], callbackUrl: 'https://star-web.top/', callbackConfigured: false, enabled: true, feeRate: Number(s.feeRate ?? FEE_RATE), createdAt: at(), updatedAt: at(), ownerType: 'admin_default' }
      s.merchants.push(row); save(); audit('payment_admin_default_merchant_created', { merchantId: row.id }, req)
    }
    return row ? jsonOk(res, { merchant: { ...publicMerchant(row), isAdmin: isAdminUser(req.user), ownerType: row.ownerType || (isAdminUser(req.user) ? 'admin_default' : 'merchant_owner'), merchantRole: isAdminUser(req.user) ? 'admin_owner' : (row.userId === String(req.user.id) ? 'merchant_owner' : 'merchant_member') }, needsCallbackConfiguration: !safeCallback(row.callbackUrl) }) : jsonErr(res, 404, '当前账户未获商户授权', 'merchant_not_found')
  })
  app.patch('/api/merchant/profile', requireUser, (req, res) => {
    const s = state(getStore()); const row = merchantForRequest(s, req); if (!row) return jsonErr(res, 404, '当前账户未获商户授权', 'merchant_not_found'); if (row.userId !== String(req.user.id) && !isAdminUser(req.user)) return jsonErr(res, 403, '只有商户所有者或管理员可以修改回调地址', 'merchant_owner_required')
    const displayName = String(req.body?.displayName ?? row.displayName).trim().slice(0, 80); const callbackUrl = String(req.body?.callbackUrl ?? row.callbackUrl).trim()
    if (!displayName || !safeCallback(callbackUrl)) return jsonErr(res, 400, '显示名称不能为空，回调地址必须是 HTTPS 公网地址', 'validation_error')
    row.displayName = displayName; row.callbackUrl = callbackUrl; row.callbackConfigured = true; row.updatedAt = at(); save(); audit('payment_merchant_profile_updated', { merchantId: row.id }, req); return jsonOk(res, { merchant: publicMerchant(row) })
  })
  app.get('/api/merchant/keys', requireUser, (req, res) => {
    const s = state(getStore())
    const row = merchantForRequest(s, req)
    if (!row) return jsonErr(res, 404, '当前账户未获商户授权', 'merchant_not_found')
    return jsonOk(res, { apiId: row.apiId, apiSecret: merchantSecret(row) })
  })

  app.post('/api/merchant/keys/rotate', requireUser, (req, res) => { const s = state(getStore()); const row = merchantForRequest(s, req); if (!row) return jsonErr(res, 404, '当前账户未获商户授权', 'merchant_not_found'); const plainSecret = key('lps'); setMerchantSecret(row, plainSecret); row.updatedAt = at(); save(); audit('payment_merchant_self_secret_rotated', { merchantId: row.id }, req); return jsonOk(res, { apiId: row.apiId, apiSecret: plainSecret }) })
  app.get('/api/merchant/balance', requireUser, (req, res) => { const s = state(getStore()); const row = merchantForRequest(s, req); return row ? jsonOk(res, { balance: balance(s, row.id), ledger: s.ledger.filter((item) => item.merchantId === row.id).slice(0, 200) }) : jsonErr(res, 404, '当前账户未获商户授权', 'merchant_not_found') })
  app.get('/api/merchant/settlements', requireUser, (req, res) => {
    const s = state(getStore()); const row = merchantForRequest(s, req)
    if (!row) return jsonErr(res, 403, '当前账户未获商户授权', 'merchant_not_found')
    return jsonOk(res, { settlements: s.settlements.filter(item => item.merchantId === row.id).slice(0, 200) })
  })
  app.get('/api/merchant/callbacks', requireUser, (req, res) => {
    const s = state(getStore()); const row = merchantForRequest(s, req)
    if (!row) return jsonErr(res, 403, '当前账户未获商户授权', 'merchant_not_found')
    return jsonOk(res, { callbacks: s.callbacks.filter(item => item.merchantId === row.id).slice(0, 200).map(item => ({ id: item.id, orderId: item.orderId, event: item.event, url: item.url, status: item.status, attempts: item.attempts, nextAttemptAt: item.nextAttemptAt, lastAttemptAt: item.lastAttemptAt || null, lastHttpStatus: item.lastHttpStatus || null, lastResponseBody: item.lastResponseBody || null, deliveryFormat: item.deliveryFormat || null, lastError: item.lastError || null, completedAt: item.completedAt || null })) })
  })
  app.post('/api/merchant/callbacks/test', requireUser, async (req, res) => {
    const s = state(getStore()); const row = merchantForRequest(s, req)
    if (!row) return jsonErr(res, 403, '当前账户未获商户授权', 'merchant_not_found')
    if (!safeCallback(row.callbackUrl)) return jsonErr(res, 400, '请先配置 HTTPS 公网回调地址', 'callback_url_missing')
    const stamp = Date.now()
    const item = { id: crypto.randomUUID(), merchantId: row.id, orderId: `test_${stamp}`, event: 'payment.test', url: row.callbackUrl, payload: { event: 'payment.test', orderId: `test_${stamp}`, merchantOrderId: `TEST-${stamp}`, amount: '0.01', platformFee: '0.00', merchantNet: '0.01', tradeNo: `TEST${stamp}`, paidAt: at(), pid: row.apiId, trade_no: `TEST${stamp}`, out_trade_no: `TEST-${stamp}`, type: 'alipay', name: 'StarMC Pay 回调测试', money: '0.01', trade_status: 'TRADE_SUCCESS' } }
    try {
      await deliverCallback(s, item)
      audit('payment_callback_test_sent', { merchantId: row.id, url: item.url, format: item.deliveryFormat }, req)
      return jsonOk(res, { deliveryFormat: item.deliveryFormat, httpStatus: item.lastHttpStatus, responseBody: item.lastResponseBody })
    } catch (error) {
      return jsonErr(res, 400, String(error?.message || error).slice(0, 300), 'callback_test_failed')
    }
  })

  app.post('/api/merchant/callbacks/:id/retry', requireUser, (req, res) => {
    const s = state(getStore()); const row = merchantForRequest(s, req)
    if (!row) return jsonErr(res, 403, '当前账户未获商户授权', 'merchant_not_found')
    const item = s.callbacks.find((entry) => entry.id === String(req.params.id) && entry.merchantId === row.id)
    if (!item) return jsonErr(res, 404, '回调记录不存在', 'callback_not_found')
    if (item.status === 'processing') return jsonErr(res, 409, '回调正在投递中，请稍后再试', 'callback_in_flight')
    item.status = 'queued'; item.attempts = 0; item.nextAttemptAt = at(); item.lastError = null
    save(); audit('payment_callback_requeued_by_merchant', { callbackId: item.id, merchantId: row.id }, req)
    return jsonOk(res, { callback: { id: item.id, status: item.status, nextAttemptAt: item.nextAttemptAt } })
  })

  app.post('/api/merchant/settlements', requireUser, (req, res) => {
    const s = state(getStore()); const row = merchantForRequest(s, req); const amount = cents(req.body?.amount)
    if (!row) return jsonErr(res, 404, '当前账户未获商户授权', 'merchant_not_found')
    if (!amount || amount > balance(s, row.id).availableCents) return jsonErr(res, 400, '结算金额必须为不超过可用余额的正数', 'insufficient_balance')
    const settlement = { id: crypto.randomUUID(), merchantId: row.id, amountCents: amount, note: String(req.body?.note || '').trim().slice(0, 300), status: 'pending', createdAt: at(), createdBy: String(req.user.id) }
    s.settlements.unshift(settlement); ledger(s, { merchantId: row.id, type: 'settlement_freeze', availableDelta: -amount, frozenDelta: amount, settlementId: settlement.id, reason: settlement.note, actorId: String(req.user.id) }); save(); audit('payment_settlement_requested', { settlementId: settlement.id, merchantId: row.id }, req); return jsonOk(res, { settlement, balance: balance(s, row.id) }, 201)
  })
}
