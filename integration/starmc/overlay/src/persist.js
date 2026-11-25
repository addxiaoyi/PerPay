// Ordinary saves use asynchronous I/O; financial acknowledgements explicitly flush.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { config } from './config.js'

export const UPLOAD_DIR = path.join(config.dataDir, 'uploads')

let store = null
let scheduled = null  // null | { id: ReturnType<typeof setTimeout>, dirtyAt: number }
let activeSave = null
let dirtyGeneration = 0
let dirty = false
let storeFingerprint = null
let saveConflict = false

function fileFingerprint(file) {
  try {
    const stat = fs.statSync(file)
    return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function storeChanged(file) {
  const current = fileFingerprint(file)
  if (current === null || storeFingerprint === null) return current !== storeFingerprint
  return current.some((value, index) => value !== storeFingerprint[index])
}

function assertStoreDirectory(file) {
  if (process.platform === 'win32') return
  const dir = fs.lstatSync(path.dirname(file))
  if (!dir.isDirectory() || dir.uid !== process.geteuid() || (dir.mode & 0o022) !== 0) {
    throw new Error('store directory must be owned by the service user and not writable by others')
  }
}

function defaultStore() {
  return {
    version: 1,
    users: [],
    submissions: [],
    catalog: [],
    favorites: {},
    comments: {},
    reports: [],
    playerState: {},
    securityCenter: {
      sessions: {},
      alerts: [],
      loginEvents: [],
      auditLogs: [],
      webhookQueue: [],
      trustedDevices: {},
      geoCache: {},
      rules: {
        failWeight: 70,
        unknownIpWeight: 30,
        highRiskThreshold: 70,
        mediumRiskThreshold: 35,
        requireMfaOnHighRisk: true,
        enableWebhookReplay: true,
      },
    },
    reviewAuditLogs: [],
    telemetryEvents: [],
    mcResetEvents: [],
    verifyCodeChallenges: {},
    mcGamePasswordChallenges: {},
    userNotifications: {},
    dashboardConfigs: {},
    wikiPages: [],
    circuitState: { failures: 0, isOpen: false, halfOpenAfter: 0 },
    library: { version: 1, syncedAt: null, etag: null },
    skinLibrarySseClients: 0,
    payment: {
      merchants: [],
      ledger: [],
      settlements: [],
      refunds: [],
      orders: [],
      callbacks: [],
      syncJobs: [],
      channels: {},
    },
  }
}

export function ensureDirs() {
  fs.mkdirSync(config.dataDir, { recursive: true })
  fs.mkdirSync(UPLOAD_DIR, { recursive: true })
  fs.mkdirSync(path.join(config.dataDir, 'backups'), { recursive: true })
}

export function loadStore() {
  ensureDirs()
  const file = path.join(config.dataDir, 'store.json')
  if (!fs.existsSync(file)) {
    store = defaultStore()
    try {
      writeStoreFile(file)
    } catch (error) {
      store = null
      throw new Error('[persist] initial store creation failed', { cause: error })
    }
    if (config.databaseUrl) {
      import('./db/flush.js')
        .then((m) => m.flushAllPgDirty(store))
        .catch((error) => console.warn('[persist] PG flush failed:', error?.message || error))
    }
    return store
  }
  try {
    const before = fileFingerprint(file)
    if (before === null) throw new Error('store disappeared before loading')
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    const after = fileFingerprint(file)
    if (after === null || after.some((value, index) => value !== before[index])) {
      throw new Error('store changed while loading')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('store is not an object')
    storeFingerprint = after
    store = { ...defaultStore(), ...parsed }
    return store
  } catch (e) {
    throw new Error('[persist] load failed; existing store was not replaced', { cause: e })
  }
}

export function getStore() {
  if (!store) loadStore()
  return store
}

function writeStoreFile(file) {
  const tempFile = `${file}.tmp-${process.pid}-${randomUUID()}`
  let created = false
  try {
    assertStoreDirectory(file)
    const fd = fs.openSync(tempFile, 'wx', 0o600)
    created = true
    try {
      fs.writeFileSync(fd, JSON.stringify(store), 'utf8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    if (storeChanged(file)) {
      dirty = true
      saveConflict = true
      throw new Error('store.json modified externally; pending state was not saved')
    }
    fs.renameSync(tempFile, file)
    storeFingerprint = fileFingerprint(file)
    if (process.platform !== 'win32') {
      const dirFd = fs.openSync(path.dirname(file), 'r')
      try { fs.fsyncSync(dirFd) } finally { fs.closeSync(dirFd) }
    }
  } catch (error) {
    try {
      if (created) fs.rmSync(tempFile, { force: true })
    } catch (cleanupError) {
      console.error('[persist] temporary store cleanup failed:', cleanupError?.message || cleanupError)
    }
    throw error
  }
}

async function writeStoreFileAsync(file) {
  const tempFile = `${file}.tmp-${process.pid}-${randomUUID()}`
  let created = false
  try {
    assertStoreDirectory(file)
    if (storeChanged(file)) {
      dirty = true
      saveConflict = true
      throw new Error('store.json modified externally; pending state was not saved')
    }
    const snapshot = JSON.stringify(store)
    const handle = await fs.promises.open(tempFile, 'wx', 0o600)
    created = true
    try {
      await handle.writeFile(snapshot, 'utf8')
      await handle.sync()
    } finally { await handle.close() }
    if (storeChanged(file)) {
      dirty = true
      saveConflict = true
      throw new Error('store.json modified externally; pending state was not saved')
    }
    // Keep conflict checking and publication adjacent in this event-loop turn.
    fs.renameSync(tempFile, file)
    storeFingerprint = fileFingerprint(file)
    if (process.platform !== 'win32') {
      const directory = await fs.promises.open(path.dirname(file), 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
  } catch (error) {
    try {
      if (created) await fs.promises.rm(tempFile, { force: true })
    } catch (cleanupError) {
      console.error('[persist] temporary store cleanup failed:', cleanupError?.message || cleanupError)
    }
    throw error
  }
}

async function saveScheduledStore(file, generation) {
  try {
    await writeStoreFileAsync(file)
    dirty = dirtyGeneration !== generation
    saveConflict = false
    if (config.databaseUrl) {
      import('./db/flush.js')
        .then((m) => m.flushAllPgDirty(store))
        .catch((error) => console.warn('[persist] PG flush failed:', error?.message || error))
    }
  } finally {
    activeSave = null
    if (dirtyGeneration !== generation && !saveConflict) queueScheduledSave()
  }
}

function queueScheduledSave() {
  if (scheduled || activeSave) return
  const dirtyAt = Date.now()
  scheduled = {
    id: setTimeout(() => {
      scheduled = null
      if (!dirty || activeSave) return
      const file = path.join(config.dataDir, 'store.json')
      activeSave = saveScheduledStore(file, dirtyGeneration)
      activeSave.catch((error) => console.error('[persist] save failed:', error?.message || error))
    }, 300),
    dirtyAt,
  }
}

export function scheduleSave() {
  dirty = true
  dirtyGeneration += 1
  queueScheduledSave()
}

export async function flushSaveSyncAndPg() {
  dirty = true
  dirtyGeneration += 1
  if (activeSave) await activeSave
  // An older asynchronous save may have queued a newer dirty generation.
  if (scheduled) {
    clearTimeout(scheduled.id)
    scheduled = null
  }
  const file = path.join(config.dataDir, 'store.json')
  dirty = true
  if (storeChanged(file)) {
    dirty = true
    saveConflict = true
    throw new Error('store.json modified externally; pending state was not saved')
  }
  writeStoreFile(file)
  dirty = false
  saveConflict = false
  if (config.databaseUrl) {
    try {
      const { flushAllPgDirty } = await import('./db/flush.js')
      await flushAllPgDirty(store)
    } catch (e) {
      console.warn('[persist] PG flush failed:', e?.message || e)
    }
  }
}

export function getPersistSnapshot() {
  const s = getStore()
  return {
    mode: config.databaseUrl ? 'json+pg' : 'json',
    dirty,
    saving: Boolean(activeSave),
    saveConflict,
    users: Array.isArray(s.users) ? s.users.length : 0,
    submissions: Array.isArray(s.submissions) ? s.submissions.length : 0,
    catalog: Array.isArray(s.catalog) ? s.catalog.length : 0,
  }
}

export function startStoreBackupScheduler() {
  if (!config.storeBackupEnabled) return () => {}
  const intervalMs = Math.max(5, config.storeBackupIntervalMinutes) * 60_000
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      const src = path.join(config.dataDir, 'store.json')
      if (!fs.existsSync(src)) return
      if (!store || dirty || saveConflict || storeChanged(src)) {
        console.warn('[persist] backup skipped: persisted store is not known to be current')
        return
      }
      const { createStoreBackup } = await import('./services/storeBackups.js')
      const backup = await createStoreBackup({ source: src, directory: path.join(config.dataDir, 'backups'),
        isCurrent: () => Boolean(store && !dirty && !saveConflict && !storeChanged(src)),
        keep: config.storeBackupKeep,
        maxBytes: config.storeBackupMaxBytes || 512 * 1024 * 1024,
      })
      if (backup.overBudget) console.error('[persist] backup budget cannot retain three recovery points; increase disk capacity')
    } catch (e) {
      console.warn('[persist] backup failed:', e?.message || e)
    } finally { running = false }
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  return () => clearInterval(timer)
}

export const STORE_KV_KEYS = [
  'security_center_state',
  'review_audit_logs',
  'dashboard_configs',
  'circuit_state',
  'user_notifications',
]

const kvDirty = new Set()

export function markKvDirty(key) {
  kvDirty.add(String(key))
}
