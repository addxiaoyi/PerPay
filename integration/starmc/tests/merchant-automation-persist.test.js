import assert from 'node:assert/strict'
import fs from 'node:fs'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const PROJECT = fileURLToPath(new URL('../', import.meta.url))
const OVERLAY = join(PROJECT, 'overlay/src')
const wait = delay => new Promise(resolveWait => setTimeout(resolveWait, delay))

async function until(check, label) {
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    if (check()) return
    await wait(10)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'starpay-async-persist-'))
  const source = join(directory, 'source')
  const data = join(directory, 'data')
  mkdirSync(join(source, 'services'), { recursive: true })
  mkdirSync(data)
  copyFileSync(join(OVERLAY, 'persist.js'), join(source, 'persist.js'))
  copyFileSync(join(PROJECT, 'support/src/services/storeBackups.js'), join(source, 'services/storeBackups.js'))
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}')
  writeFileSync(join(source, 'config.js'), `export const config = ${JSON.stringify({ dataDir: data, databaseUrl: null, storeBackupEnabled: false })}`)
  const file = join(data, 'store.json')
  writeFileSync(file, JSON.stringify({ users: [{ id: 'before' }], metadata: { unicode: '测试', empty: null, enabled: false } }))
  const persist = await import(pathToFileURL(join(source, 'persist.js')).href)
  const store = persist.loadStore()
  return { directory, source, data, file, persist, store, disk: () => JSON.parse(readFileSync(file, 'utf8')) }
}

function holdFirstOpen(t) {
  const open = fs.promises.open
  let releaseOpen
  let reachedOpen
  let held = false
  const blocked = new Promise(resolveOpen => { releaseOpen = resolveOpen })
  const entered = new Promise(resolveOpen => { reachedOpen = resolveOpen })
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args)
    if (String(args[0]).includes('.tmp-') && !held) {
      held = true
      reachedOpen()
      await blocked
    }
    return handle
  })
  return { release: releaseOpen, entered }
}

test('ordinary scheduled saves use asynchronous file I/O and compact equivalent JSON', async (t) => {
  const f = await fixture()
  let syncWrites = 0
  const write = fs.writeFileSync
  t.mock.method(fs, 'writeFileSync', (...args) => { syncWrites++; return write(...args) })
  try {
    f.store.users.push({ id: 'scheduled' })
    f.persist.scheduleSave()
    await until(() => f.disk().users.length === 2 && !f.persist.getPersistSnapshot().dirty, 'the asynchronous scheduled save')
    assert.equal(syncWrites, 0)
    assert.deepEqual(f.disk().metadata, f.store.metadata)
    assert.equal(readFileSync(f.file, 'utf8'), JSON.stringify(f.store))
    assert.equal(fs.readdirSync(f.data).some(name => name.includes('.tmp-')), false)
  } finally { t.mock.restoreAll(); rmSync(f.directory, { recursive: true, force: true }) }
})

test('mutations arriving during an asynchronous save remain dirty and are persisted by the next save', async (t) => {
  const f = await fixture()
  const gate = holdFirstOpen(t)
  try {
    f.store.users.push({ id: 'first' })
    f.persist.scheduleSave()
    await Promise.race([gate.entered, wait(2000).then(() => { throw new Error('scheduled writer did not use asynchronous open') })])
    f.store.users.push({ id: 'during-write' })
    f.persist.scheduleSave()
    assert.equal(f.disk().users.length, 1)
    gate.release()
    await until(() => f.disk().users.length === 3 && !f.persist.getPersistSnapshot().dirty, 'all dirty generations')
    assert.deepEqual(f.disk().users.map(user => user.id), ['before', 'first', 'during-write'])
  } finally { gate.release(); t.mock.restoreAll(); await f.persist.flushSaveSyncAndPg(); rmSync(f.directory, { recursive: true, force: true }) }
})

test('financial flush waits for an in-flight normal save and cannot be overwritten by its stale snapshot', async (t) => {
  const f = await fixture()
  const gate = holdFirstOpen(t)
  try {
    f.store.users.push({ id: 'regular' })
    f.persist.scheduleSave()
    await Promise.race([gate.entered, wait(2000).then(() => { throw new Error('scheduled writer did not start') })])
    f.store.payment.orders.push({ id: 'financial', status: 'paid', amountCents: 100 })
    let finished = false
    const flush = f.persist.flushSaveSyncAndPg().then(() => { finished = true })
    await wait(30)
    assert.equal(finished, false)
    gate.release()
    await flush
    assert.equal(f.disk().payment.orders[0].status, 'paid')
    const committed = readFileSync(f.file, 'utf8')
    await wait(450)
    assert.equal(readFileSync(f.file, 'utf8'), committed)
    assert.equal(f.persist.getPersistSnapshot().dirty, false)
  } finally { gate.release(); t.mock.restoreAll(); await f.persist.flushSaveSyncAndPg(); rmSync(f.directory, { recursive: true, force: true }) }
})

test('an asynchronous fsync failure preserves the previous file, removes its temporary file and permits a durable retry', async (t) => {
  const f = await fixture()
  const open = fs.promises.open
  let attempted = false
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await open(...args)
    if (String(args[0]).includes('.tmp-')) t.mock.method(handle, 'sync', async () => { attempted = true; throw new Error('fixture asynchronous fsync failure') })
    return handle
  })
  try {
    const before = readFileSync(f.file, 'utf8')
    f.store.users.push({ id: 'pending' })
    f.persist.scheduleSave()
    await until(() => attempted && !f.persist.getPersistSnapshot().saving, 'the failed asynchronous write')
    assert.equal(readFileSync(f.file, 'utf8'), before)
    assert.equal(f.persist.getPersistSnapshot().dirty, true)
    assert.equal(fs.readdirSync(f.data).some(name => name.includes('.tmp-')), false)
    t.mock.restoreAll()
    await f.persist.flushSaveSyncAndPg()
    assert.equal(f.disk().users.length, 2)
    assert.equal(f.persist.getPersistSnapshot().dirty, false)
  } finally { t.mock.restoreAll(); rmSync(f.directory, { recursive: true, force: true }) }
})

test('a later scheduled mutation recovers a failed ordinary write without an automatic retry loop', async (t) => {
  const f = await fixture()
  let attempts = 0
  t.mock.method(fs.promises, 'open', async () => { attempts++; throw new Error('fixture open failure') })
  try {
    f.store.users.push({ id: 'pending' })
    f.persist.scheduleSave()
    await until(() => attempts === 1 && !f.persist.getPersistSnapshot().saving, 'the failed open')
    await wait(450)
    assert.equal(attempts, 1)
    assert.equal(f.persist.getPersistSnapshot().dirty, true)
    t.mock.restoreAll()
    f.store.users.push({ id: 'recovered' })
    f.persist.scheduleSave()
    await until(() => f.disk().users.length === 3 && !f.persist.getPersistSnapshot().dirty, 'a subsequent scheduled retry')
  } finally { t.mock.restoreAll(); rmSync(f.directory, { recursive: true, force: true }) }
})

test('external changes during an asynchronous save are retained and block a financial overwrite', async (t) => {
  const f = await fixture()
  const gate = holdFirstOpen(t)
  try {
    f.store.users.push({ id: 'memory-only' })
    f.persist.scheduleSave()
    await Promise.race([gate.entered, wait(2000).then(() => { throw new Error('scheduled writer did not start') })])
    const external = JSON.stringify({ users: [{ id: 'external' }] })
    writeFileSync(f.file, external)
    gate.release()
    await until(() => f.persist.getPersistSnapshot().saveConflict && !f.persist.getPersistSnapshot().saving, 'the external conflict')
    assert.equal(readFileSync(f.file, 'utf8'), external)
    assert.equal(f.persist.getPersistSnapshot().dirty, true)
    assert.equal(fs.readdirSync(f.data).some(name => name.includes('.tmp-')), false)
    await assert.rejects(f.persist.flushSaveSyncAndPg(), /modified externally/)
    assert.equal(readFileSync(f.file, 'utf8'), external)
  } finally { gate.release(); t.mock.restoreAll(); rmSync(f.directory, { recursive: true, force: true }) }
})

test('exclusive asynchronous temporary creation does not delete an existing conflicting file', async (t) => {
  const f = await fixture()
  const open = fs.promises.open
  let collision
  t.mock.method(fs.promises, 'open', async (...args) => {
    if (String(args[0]).includes('.tmp-')) { collision = String(args[0]); writeFileSync(collision, 'must retain') }
    return open(...args)
  })
  try {
    f.store.users.push({ id: 'pending' })
    f.persist.scheduleSave()
    await until(() => collision && !f.persist.getPersistSnapshot().saving, 'the exclusive create conflict')
    assert.equal(readFileSync(collision, 'utf8'), 'must retain')
    assert.equal(f.disk().users.length, 1)
    assert.equal(f.persist.getPersistSnapshot().dirty, true)
    t.mock.restoreAll()
    await f.persist.flushSaveSyncAndPg()
    assert.equal(f.disk().users.length, 2)
  } finally { t.mock.restoreAll(); rmSync(f.directory, { recursive: true, force: true }) }
})

test('a cleanly saved store reloads with equivalent business state and ignores orphaned unpublished files', async () => {
  const f = await fixture()
  try {
    f.store.payment.orders.push({ id: 'confirmed', status: 'paid', amountCents: 100 })
    f.persist.scheduleSave()
    await until(() => !f.persist.getPersistSnapshot().dirty, 'a complete ordinary save')
    writeFileSync(join(f.data, 'store.json.tmp-interrupted'), '{incomplete')
    copyFileSync(join(f.source, 'persist.js'), join(f.source, 'persist-restarted.js'))
    const restarted = await import(pathToFileURL(join(f.source, 'persist-restarted.js')).href)
    assert.deepEqual(restarted.loadStore(), f.store)
    assert.equal(restarted.getPersistSnapshot().dirty, false)
  } finally { rmSync(f.directory, { recursive: true, force: true }) }
})
