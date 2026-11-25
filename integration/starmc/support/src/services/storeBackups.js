import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createGzip, createGunzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { Transform, Writable } from 'node:stream'

const SNAPSHOT = /^store-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json(?:\.gz)?$/
const DEFAULT_BUDGET = 512 * 1024 * 1024

function fingerprint(file) {
  const s = fs.lstatSync(file)
  if (!s.isFile() || s.isSymbolicLink()) throw new Error('store backup source must be a regular file')
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`
}

function snapshots(directory) {
  return fs.readdirSync(directory).filter(name => SNAPSHOT.test(name)).flatMap(name => {
    const file = path.join(directory, name)
    const stat = fs.lstatSync(file)
    return stat.isFile() && !stat.isSymbolicLink() ? [{ file, name, bytes: stat.size, fingerprint: fingerprint(file) }] : []
  }).sort((a, b) => b.name.localeCompare(a.name))
}

export function rotateStoreBackups(directory, { keep = 48, maxBytes = DEFAULT_BUDGET, minimum = 3 } = {}) {
  if (!Number.isSafeInteger(keep) || keep < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1
    || !Number.isSafeInteger(minimum) || minimum < 1) throw new Error('invalid store backup retention settings')
  const rows = snapshots(directory)
  const retained = []
  const removed = []
  let bytes = 0
  for (const row of rows) {
    const required = retained.length < Math.min(minimum, keep)
    if (required || (retained.length < keep && bytes + row.bytes <= maxBytes)) {
      retained.push(row.name)
      bytes += row.bytes
      continue
    }
    if (fingerprint(row.file) !== row.fingerprint) throw new Error('backup changed during retention scan')
    fs.unlinkSync(row.file)
    removed.push(row.name)
  }
  return { retained, removed, bytes, overBudget: bytes > maxBytes }
}

export async function createStoreBackup({ source, directory, isCurrent, keep = 48, maxBytes = DEFAULT_BUDGET,
  minimum = 3, now = new Date() }) {
  if (!isCurrent()) return { skipped: true }
  const directoryStat = fs.lstatSync(directory)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('backup directory must be a real directory')
  const name = `store-${now.toISOString().replace(/[:.]/g, '-')}.json.gz`
  const destination = path.join(directory, name)
  const snapshot = path.join(directory, `.snapshot-${randomUUID()}.partial`)
  const packed = path.join(directory, `.gzip-${randomUUID()}.partial`)
  const created = []
  try {
    const before = fingerprint(source)
    fs.copyFileSync(source, snapshot, fs.constants.COPYFILE_EXCL)
    created.push(snapshot)
    fs.chmodSync(snapshot, 0o600)
    if (fingerprint(source) !== before || !isCurrent()) throw new Error('store changed while capturing backup')
    const originalHash = createHash('sha256')
    const tap = new Transform({ transform(chunk, _encoding, done) { originalHash.update(chunk); done(null, chunk) } })
    const descriptor = fs.openSync(packed, 'wx', 0o600)
    created.push(packed)
    try {
      await pipeline(fs.createReadStream(snapshot), tap, createGzip({ level: 6 }), fs.createWriteStream(packed, { fd: descriptor, autoClose: false }))
      fs.fsyncSync(descriptor)
    } finally { fs.closeSync(descriptor) }
    const restoredHash = createHash('sha256')
    await pipeline(fs.createReadStream(packed), createGunzip(), new Writable({
      write(chunk, _encoding, done) { restoredHash.update(chunk); done() },
    }))
    const sha256 = originalHash.digest('hex')
    if (restoredHash.digest('hex') !== sha256) throw new Error('compressed store backup verification failed')
    // An exclusive hard link publishes the fully flushed file without replacing another snapshot.
    fs.linkSync(packed, destination)
    return { skipped: false, file: destination, sha256, ...rotateStoreBackups(directory, { keep, maxBytes, minimum }) }
  } finally {
    for (const file of created) fs.unlinkSync(file)
  }
}
