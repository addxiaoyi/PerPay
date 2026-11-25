import assert from 'node:assert/strict'
import fs from 'node:fs'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'

test('preserves the old snapshot if flushing the replacement file fails', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'starmc-persist-sync-'))
  const src = join(root, 'src')
  const data = join(root, 'data')
  mkdirSync(src)
  mkdirSync(data)
  copyFileSync(new URL('../overlay/src/persist.js', import.meta.url), join(src, 'persist.js'))
  mkdirSync(join(src, 'services'))
  copyFileSync(new URL('../support/src/services/storeBackups.js', import.meta.url), join(src, 'services/storeBackups.js'))
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  writeFileSync(join(src, 'config.js'), `export const config = { dataDir: ${JSON.stringify(data)}, databaseUrl: null }`)
  const file = join(data, 'store.json')
  const original = JSON.stringify({ users: [{ id: 'original' }] })
  writeFileSync(file, original)
  try {
    const persist = await import(pathToFileURL(join(src, 'persist.js')).href)
    persist.loadStore().users.push({ id: 'pending' })
    t.mock.method(fs, 'fsyncSync', () => { throw new Error('fixture fsync failed') })
    await assert.rejects(persist.flushSaveSyncAndPg(), /fixture fsync failed/)
    assert.equal(readFileSync(file, 'utf8'), original)
    assert.equal(persist.getPersistSnapshot().dirty, true)
    t.mock.restoreAll()
    await persist.flushSaveSyncAndPg()
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).users.length, 2)
  } finally {
    t.mock.restoreAll()
    rmSync(root, { recursive: true, force: true })
  }
})

test('fails startup synchronously when the initial store cannot be written', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'starmc-persist-create-'))
  const src = join(root, 'src')
  const data = join(root, 'data')
  mkdirSync(src)
  mkdirSync(data)
  copyFileSync(new URL('../overlay/src/persist.js', import.meta.url), join(src, 'persist.js'))
  mkdirSync(join(src, 'services'))
  copyFileSync(new URL('../support/src/services/storeBackups.js', import.meta.url), join(src, 'services/storeBackups.js'))
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  writeFileSync(join(src, 'config.js'), `export const config = { dataDir: ${JSON.stringify(data)}, databaseUrl: null, storeBackupEnabled: false }`)
  const file = join(data, 'store.json')
  try {
    const persist = await import(pathToFileURL(join(src, 'persist.js')).href)
    const write = fs.writeFileSync
    t.mock.method(fs, 'writeFileSync', (...args) => {
      if (typeof args[0] === 'number') throw new Error('fixture write failure')
      return write(...args)
    })
    assert.throws(() => persist.loadStore(), /initial store creation failed/)
    assert.equal(fs.existsSync(file), false)
    t.mock.restoreAll()
    assert.deepEqual(persist.getStore().users, [])
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).users, [])
  } finally {
    t.mock.restoreAll()
    rmSync(root, { recursive: true, force: true })
  }
})

test('does not overwrite a store created concurrently during initialization', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'starmc-persist-create-race-'))
  const src = join(root, 'src')
  const data = join(root, 'data')
  mkdirSync(src)
  mkdirSync(data)
  copyFileSync(new URL('../overlay/src/persist.js', import.meta.url), join(src, 'persist.js'))
  mkdirSync(join(src, 'services'))
  copyFileSync(new URL('../support/src/services/storeBackups.js', import.meta.url), join(src, 'services/storeBackups.js'))
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  writeFileSync(join(src, 'config.js'), `export const config = { dataDir: ${JSON.stringify(data)}, databaseUrl: null, storeBackupEnabled: false }`)
  const file = join(data, 'store.json')
  try {
    const persist = await import(pathToFileURL(join(src, 'persist.js')).href)
    const write = fs.writeFileSync
    t.mock.method(fs, 'writeFileSync', (...args) => {
      const value = write(...args)
      if (typeof args[0] === 'number') write(file, JSON.stringify({ users: [{ id: 'external' }] }))
      return value
    })
    assert.throws(() => persist.loadStore(), /initial store creation failed/)
    t.mock.restoreAll()
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).users[0].id, 'external')
    assert.equal(persist.getStore().users[0].id, 'external')
    assert.equal(fs.readdirSync(data).some((name) => name.startsWith('store.json.tmp-')), false)
  } finally {
    t.mock.restoreAll()
    rmSync(root, { recursive: true, force: true })
  }
})

test('preserves pending state and reports an external store conflict', async () => {
  const root = mkdtempSync(join(tmpdir(), 'starmc-persist-conflict-'))
  const src = join(root, 'src')
  const data = join(root, 'data')
  mkdirSync(src)
  mkdirSync(data)
  copyFileSync(new URL('../overlay/src/persist.js', import.meta.url), join(src, 'persist.js'))
  mkdirSync(join(src, 'services'))
  copyFileSync(new URL('../support/src/services/storeBackups.js', import.meta.url), join(src, 'services/storeBackups.js'))
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  writeFileSync(join(src, 'config.js'), `export const config = { dataDir: ${JSON.stringify(data)}, databaseUrl: null, storeBackupEnabled: false }`)
  const file = join(data, 'store.json')
  writeFileSync(file, JSON.stringify({ users: [{ id: 'disk' }] }))
  const initial = new Date('2024-01-01T00:00:00Z')
  utimesSync(file, initial, initial)
  try {
    const persist = await import(pathToFileURL(join(src, 'persist.js')).href)
    const store = persist.loadStore()
    store.users.push({ id: 'memory-only' })
    writeFileSync(file, JSON.stringify({ users: [{ id: 'external' }] }))
    const newer = new Date('2024-01-02T00:00:00Z')
    utimesSync(file, newer, newer)
    persist.scheduleSave()
    await new Promise((resolve) => setTimeout(resolve, 450))
    assert.equal(persist.getPersistSnapshot().dirty, true)
    assert.equal(persist.getPersistSnapshot().saveConflict, true)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).users[0].id, 'external')
    await assert.rejects(persist.flushSaveSyncAndPg(), /pending state was not saved/)
    assert.equal(persist.getPersistSnapshot().dirty, true)
    assert.deepEqual(store.users.map((user) => user.id), ['disk', 'memory-only'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

for (const change of ['older timestamp', 'unchanged timestamp', 'deleted file']) {
  test(`rejects an external store change with ${change}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'starmc-persist-conflict-'))
    const src = join(root, 'src')
    const data = join(root, 'data')
    mkdirSync(src)
    mkdirSync(data)
    copyFileSync(new URL('../overlay/src/persist.js', import.meta.url), join(src, 'persist.js'))
  mkdirSync(join(src, 'services'))
  copyFileSync(new URL('../support/src/services/storeBackups.js', import.meta.url), join(src, 'services/storeBackups.js'))
    writeFileSync(join(root, 'package.json'), '{"type":"module"}')
    writeFileSync(join(src, 'config.js'), `export const config = { dataDir: ${JSON.stringify(data)}, databaseUrl: null, storeBackupEnabled: false }`)
    const file = join(data, 'store.json')
    writeFileSync(file, JSON.stringify({ users: [{ id: 'disk' }] }))
    const initial = new Date('2024-01-02T00:00:00Z')
    utimesSync(file, initial, initial)
    try {
      const persist = await import(pathToFileURL(join(src, 'persist.js')).href)
      const store = persist.loadStore()
      store.users.push({ id: 'memory-only' })
      if (change === 'deleted file') rmSync(file)
      else {
        writeFileSync(file, JSON.stringify({ users: [{ id: 'external' }] }))
        const timestamp = change === 'older timestamp' ? new Date('2024-01-01T00:00:00Z') : initial
        utimesSync(file, timestamp, timestamp)
      }
      await assert.rejects(persist.flushSaveSyncAndPg(), /pending state was not saved/)
      assert.equal(persist.getPersistSnapshot().dirty, true)
      assert.equal(persist.getPersistSnapshot().saveConflict, true)
      assert.deepEqual(store.users.map((user) => user.id), ['disk', 'memory-only'])
      if (change !== 'deleted file') assert.equal(JSON.parse(readFileSync(file, 'utf8')).users[0].id, 'external')
      else assert.throws(() => readFileSync(file), { code: 'ENOENT' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test('saves consecutive changes when the store has not changed externally', async () => {
  const root = mkdtempSync(join(tmpdir(), 'starmc-persist-normal-'))
  const src = join(root, 'src')
  const data = join(root, 'data')
  mkdirSync(src)
  mkdirSync(data)
  copyFileSync(new URL('../overlay/src/persist.js', import.meta.url), join(src, 'persist.js'))
  mkdirSync(join(src, 'services'))
  copyFileSync(new URL('../support/src/services/storeBackups.js', import.meta.url), join(src, 'services/storeBackups.js'))
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  writeFileSync(join(src, 'config.js'), `export const config = { dataDir: ${JSON.stringify(data)}, databaseUrl: null, storeBackupEnabled: false }`)
  const file = join(data, 'store.json')
  writeFileSync(file, JSON.stringify({ users: [] }))
  try {
    const persist = await import(pathToFileURL(join(src, 'persist.js')).href)
    const store = persist.loadStore()
    store.users.push({ id: 'first' })
    await persist.flushSaveSyncAndPg()
    store.users.push({ id: 'second' })
    await persist.flushSaveSyncAndPg()
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).users.map((user) => user.id), ['first', 'second'])
    assert.equal(persist.getPersistSnapshot().saveConflict, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('creates new store snapshots without group or world permissions on POSIX', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'starmc-persist-private-'))
  const src = join(root, 'src')
  const data = join(root, 'data')
  mkdirSync(src)
  mkdirSync(data)
  copyFileSync(new URL('../overlay/src/persist.js', import.meta.url), join(src, 'persist.js'))
  mkdirSync(join(src, 'services'))
  copyFileSync(new URL('../support/src/services/storeBackups.js', import.meta.url), join(src, 'services/storeBackups.js'))
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  writeFileSync(join(src, 'config.js'), `export const config = { dataDir: ${JSON.stringify(data)}, databaseUrl: null, storeBackupEnabled: false }`)
  try {
    const persist = await import(pathToFileURL(join(src, 'persist.js')).href)
    const store = persist.loadStore()
    assert.equal(fs.statSync(join(data, 'store.json')).mode & 0o077, 0)
    store.users.push({ id: 'fixture' })
    await persist.flushSaveSyncAndPg()
    assert.equal(fs.statSync(join(data, 'store.json')).mode & 0o077, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('refuses an unsafe POSIX store directory without overwriting or clearing pending state', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'starmc-persist-unsafe-dir-'))
  const src = join(root, 'src')
  const data = join(root, 'data')
  mkdirSync(src)
  mkdirSync(data)
  copyFileSync(new URL('../overlay/src/persist.js', import.meta.url), join(src, 'persist.js'))
  mkdirSync(join(src, 'services'))
  copyFileSync(new URL('../support/src/services/storeBackups.js', import.meta.url), join(src, 'services/storeBackups.js'))
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  writeFileSync(join(src, 'config.js'), `export const config = { dataDir: ${JSON.stringify(data)}, databaseUrl: null, storeBackupEnabled: false }`)
  const file = join(data, 'store.json')
  writeFileSync(file, JSON.stringify({ users: [{ id: 'disk' }] }))
  try {
    const persist = await import(pathToFileURL(join(src, 'persist.js')).href)
    const store = persist.loadStore()
    store.users.push({ id: 'memory-only' })
    fs.chmodSync(data, 0o777)
    await assert.rejects(persist.flushSaveSyncAndPg(), /store directory must be owned/)
    assert.equal(persist.getPersistSnapshot().dirty, true)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).users, [{ id: 'disk' }])
    assert.deepEqual(store.users.map(user => user.id), ['disk', 'memory-only'])
    fs.chmodSync(data, 0o700)
    await persist.flushSaveSyncAndPg()
    assert.equal(persist.getPersistSnapshot().dirty, false)
  } finally {
    fs.chmodSync(data, 0o700)
    rmSync(root, { recursive: true, force: true })
  }
})

test('creates the temporary store exclusively and preserves a conflicting file', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'starmc-persist-exclusive-'))
  const src = join(root, 'src')
  const data = join(root, 'data')
  mkdirSync(src)
  mkdirSync(data)
  copyFileSync(new URL('../overlay/src/persist.js', import.meta.url), join(src, 'persist.js'))
  mkdirSync(join(src, 'services'))
  copyFileSync(new URL('../support/src/services/storeBackups.js', import.meta.url), join(src, 'services/storeBackups.js'))
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  writeFileSync(join(src, 'config.js'), `export const config = { dataDir: ${JSON.stringify(data)}, databaseUrl: null, storeBackupEnabled: false }`)
  let conflicting
  try {
    const persist = await import(pathToFileURL(join(src, 'persist.js')).href)
    const open = fs.openSync
    t.mock.method(fs, 'openSync', (file, flags, mode) => {
      if (String(file).startsWith(join(data, 'store.json.tmp-'))) {
        assert.equal(flags, 'wx')
        assert.equal(mode, 0o600)
        conflicting = String(file)
        writeFileSync(conflicting, 'existing file')
      }
      return open(file, flags, mode)
    })
    assert.throws(() => persist.loadStore(), /initial store creation failed/)
    assert.equal(readFileSync(conflicting, 'utf8'), 'existing file')
    assert.equal(fs.existsSync(join(data, 'store.json')), false)
  } finally {
    t.mock.restoreAll()
    rmSync(root, { recursive: true, force: true })
  }
})

test('does not overwrite an external update made while the temporary file is written', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'starmc-persist-write-race-'))
  const src = join(root, 'src')
  const data = join(root, 'data')
  mkdirSync(src)
  mkdirSync(data)
  copyFileSync(new URL('../overlay/src/persist.js', import.meta.url), join(src, 'persist.js'))
  mkdirSync(join(src, 'services'))
  copyFileSync(new URL('../support/src/services/storeBackups.js', import.meta.url), join(src, 'services/storeBackups.js'))
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  writeFileSync(join(src, 'config.js'), `export const config = { dataDir: ${JSON.stringify(data)}, databaseUrl: null, storeBackupEnabled: false }`)
  const file = join(data, 'store.json')
  writeFileSync(file, JSON.stringify({ users: [{ id: 'original' }] }))
  try {
    const persist = await import(pathToFileURL(join(src, 'persist.js')).href)
    const store = persist.loadStore()
    store.users.push({ id: 'memory-only' })
    const write = fs.writeFileSync
    t.mock.method(fs, 'writeFileSync', (...args) => {
      write(...args)
      if (typeof args[0] === 'number') write(file, JSON.stringify({ users: [{ id: 'external' }] }))
    })
    await assert.rejects(persist.flushSaveSyncAndPg(), /pending state was not saved/)
    assert.equal(persist.getPersistSnapshot().dirty, true)
    assert.equal(persist.getPersistSnapshot().saveConflict, true)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).users[0].id, 'external')
    assert.deepEqual(store.users.map((user) => user.id), ['original', 'memory-only'])
    assert.equal(fs.readdirSync(data).some((name) => name.startsWith('store.json.tmp-')), false)
  } finally {
    t.mock.restoreAll()
    rmSync(root, { recursive: true, force: true })
  }
})

test('does not rotate backups while the in-memory store is unsaved or the file conflicts', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'starmc-persist-backup-'))
  const src = join(root, 'src')
  const data = join(root, 'data')
  const backups = join(data, 'backups')
  mkdirSync(src)
  mkdirSync(backups, { recursive: true })
  copyFileSync(new URL('../overlay/src/persist.js', import.meta.url), join(src, 'persist.js'))
  mkdirSync(join(src, 'services'))
  copyFileSync(new URL('../support/src/services/storeBackups.js', import.meta.url), join(src, 'services/storeBackups.js'))
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  writeFileSync(join(src, 'config.js'), `export const config = { dataDir: ${JSON.stringify(data)}, databaseUrl: null, storeBackupEnabled: true, storeBackupIntervalMinutes: 5, storeBackupKeep: 1 }`)
  const file = join(data, 'store.json')
  const oldBackupName = 'store-2000-01-01T00-00-00-000Z.json'
  const oldBackup = join(backups, oldBackupName)
  writeFileSync(file, JSON.stringify({ users: [] }))
  writeFileSync(oldBackup, 'previous backup')
  let runBackup
  t.mock.method(globalThis, 'setInterval', (callback) => { runBackup = callback; return { unref() {} } })
  t.mock.method(globalThis, 'clearInterval', () => {})
  try {
    const persist = await import(pathToFileURL(join(src, 'persist.js')).href)
    const store = persist.loadStore()
    const stop = persist.startStoreBackupScheduler()
    store.users.push({ id: 'unsaved' })
    persist.scheduleSave()
    await runBackup()
    assert.equal(readFileSync(oldBackup, 'utf8'), 'previous backup')
    assert.deepEqual(fs.readdirSync(backups), [oldBackupName])
    await persist.flushSaveSyncAndPg()
    await runBackup()
    const [currentBackup] = fs.readdirSync(backups)
    assert.ok(currentBackup && currentBackup !== oldBackupName)
    assert.equal(JSON.parse(gunzipSync(readFileSync(join(backups, currentBackup))).toString()).users[0].id, 'unsaved')
    writeFileSync(file, JSON.stringify({ users: [{ id: 'external' }] }))
    await runBackup()
    assert.deepEqual(fs.readdirSync(backups), [currentBackup])
    assert.equal(JSON.parse(gunzipSync(readFileSync(join(backups, currentBackup))).toString()).users[0].id, 'unsaved')
    stop()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('discards a backup if the source changes while copying', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'starmc-backup-race-'))
  const src = join(root, 'src')
  const data = join(root, 'data')
  const backups = join(data, 'backups')
  mkdirSync(src)
  mkdirSync(backups, { recursive: true })
  copyFileSync(new URL('../overlay/src/persist.js', import.meta.url), join(src, 'persist.js'))
  mkdirSync(join(src, 'services'))
  copyFileSync(new URL('../support/src/services/storeBackups.js', import.meta.url), join(src, 'services/storeBackups.js'))
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  writeFileSync(join(src, 'config.js'), `export const config = { dataDir: ${JSON.stringify(data)}, databaseUrl: null, storeBackupEnabled: true, storeBackupIntervalMinutes: 5, storeBackupKeep: 1 }`)
  const file = join(data, 'store.json')
  const previous = join(backups, 'store-2000-01-01T00-00-00-000Z.json')
  writeFileSync(file, JSON.stringify({ users: [] }))
  writeFileSync(previous, 'retained backup')
  let runBackup
  t.mock.method(globalThis, 'setInterval', (callback) => { runBackup = callback; return { unref() {} } })
  t.mock.method(globalThis, 'clearInterval', () => {})
  try {
    const persist = await import(pathToFileURL(join(src, 'persist.js')).href)
    persist.loadStore()
    const stop = persist.startStoreBackupScheduler()
    const copy = fs.copyFileSync
    t.mock.method(fs, 'copyFileSync', (...args) => {
      copy(...args)
      writeFileSync(file, JSON.stringify({ users: [{ id: 'external' }] }))
    })
    await runBackup()
    assert.deepEqual(fs.readdirSync(backups), ['store-2000-01-01T00-00-00-000Z.json'])
    assert.equal(readFileSync(previous, 'utf8'), 'retained backup')
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).users[0].id, 'external')
    stop()
  } finally {
    t.mock.restoreAll()
    rmSync(root, { recursive: true, force: true })
  }
})

for (const content of ['{invalid json', '[]', 'null']) {
  test(`rejects an invalid existing store: ${content}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'starmc-persist-invalid-'))
    const src = join(root, 'src')
    const data = join(root, 'data')
    mkdirSync(src)
    mkdirSync(data)
    copyFileSync(new URL('../overlay/src/persist.js', import.meta.url), join(src, 'persist.js'))
  mkdirSync(join(src, 'services'))
  copyFileSync(new URL('../support/src/services/storeBackups.js', import.meta.url), join(src, 'services/storeBackups.js'))
    writeFileSync(join(root, 'package.json'), '{"type":"module"}')
    writeFileSync(join(src, 'config.js'), `export const config = { dataDir: ${JSON.stringify(data)}, databaseUrl: null, storeBackupEnabled: false }`)
    const file = join(data, 'store.json')
    writeFileSync(file, content)
    try {
      const persist = await import(pathToFileURL(join(src, 'persist.js')).href)
      assert.throws(() => persist.loadStore(), /existing store was not replaced/)
      assert.throws(() => persist.getStore(), /existing store was not replaced/)
      assert.equal(readFileSync(file, 'utf8'), content)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test('rejects a store that changes during loading', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'starmc-persist-race-'))
  const src = join(root, 'src')
  const data = join(root, 'data')
  mkdirSync(src)
  mkdirSync(data)
  copyFileSync(new URL('../overlay/src/persist.js', import.meta.url), join(src, 'persist.js'))
  mkdirSync(join(src, 'services'))
  copyFileSync(new URL('../support/src/services/storeBackups.js', import.meta.url), join(src, 'services/storeBackups.js'))
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  writeFileSync(join(src, 'config.js'), `export const config = { dataDir: ${JSON.stringify(data)}, databaseUrl: null, storeBackupEnabled: false }`)
  const file = join(data, 'store.json')
  writeFileSync(file, JSON.stringify({ users: [{ id: 'old' }] }))
  try {
    const persist = await import(pathToFileURL(join(src, 'persist.js')).href)
    const read = fs.readFileSync
    t.mock.method(fs, 'readFileSync', function (target, ...args) {
      const original = read.call(this, target, ...args)
      if (target === file) writeFileSync(file, JSON.stringify({ users: [{ id: 'new-external' }] }))
      return original
    })
    assert.throws(() => persist.loadStore(), /existing store was not replaced/)
    t.mock.restoreAll()
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).users[0].id, 'new-external')
  } finally {
    t.mock.restoreAll()
    rmSync(root, { recursive: true, force: true })
  }
})
