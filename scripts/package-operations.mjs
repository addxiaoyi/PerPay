import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { crc32 } from './package-client-demo.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const MAX_SOURCE_BYTES = 1024 * 1024;
const PREFIX = 'perpay-operations/';

export const OPERATIONS_FILES = Object.freeze([
  'LICENSE',
  'NOTICE',
  'docs/operations-release.md',
  'docs/payment-reliability.md',
  'docs/payment-alert-automation.md',
  'docs/source-sync-automation.md',
  'scripts/check-invoice-automation.ts',
  'scripts/install-payment-automation.py',
  'scripts/observe-source-sync.py',
  'scripts/payment_alert_delivery.py',
  'scripts/perpay-payment-alerts.py',
  'src/invoices/automation-readiness.ts',
].sort());

export function assertPublicSource(name, bytes) {
  const source = bytes.toString('utf8');
  const privateKey = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u;
  const literalSecret = /["']?\b(?:api[_-]?secret|client[_-]?secret|webhook[_-]?secret|master[_-]?key|private[_-]?key|password|access[_-]?token)["']?\s*[:=]\s*["']([^"'\r\n]+)["']/giu;
  if (privateKey.test(source) || [...source.matchAll(literalSecret)].some(match => !/^(?:<[^>]+>|(?:YOUR|REPLACE|EXAMPLE|TEST|DUMMY|CHANGE)[A-Z0-9_ -]*)$/iu.test(match[1]))) {
    throw new Error(`Refusing to package credential material: ${name}`);
  }
}

function zip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const [relative, bytes] of entries) {
    const name = Buffer.from(PREFIX + relative, 'utf8');
    const compressed = deflateRawSync(bytes, { level: 9 });
    const checksum = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0x0021, 12);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(0x0314, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8); entry.writeUInt16LE(8, 10); entry.writeUInt16LE(0x0021, 14);
    entry.writeUInt32LE(checksum, 16); entry.writeUInt32LE(compressed.length, 20); entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(0x81a40000, 38); entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export async function buildOperationsArchive(root = project) {
  if (OPERATIONS_FILES.length === 0) throw new Error('Operations archive allowlist is empty');
  const source = await realpath(root);
  const { version } = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8'));
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) throw new Error('Operations archive requires a release version');
  const entries = [], files = [];
  for (const name of OPERATIONS_FILES) {
    const file = resolve(source, name);
    let ancestor = source;
    for (const segment of name.split('/')) {
      ancestor = resolve(ancestor, segment);
      if ((await lstat(ancestor)).isSymbolicLink()) throw new Error(`Operations paths cannot traverse symbolic links: ${name}`);
    }
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_SOURCE_BYTES || !(await realpath(file)).startsWith(source + sep)) {
      throw new Error(`Operations source must be a bounded regular file inside the checkout: ${name}`);
    }
    const bytes = await readFile(file);
    assertPublicSource(name, bytes);
    entries.push([name, bytes]);
    files.push({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const manifest = { schemaVersion: 1, version, files };
  entries.push(['manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n')]);
  return { archive: zip(entries.sort(([left], [right]) => left.localeCompare(right, 'en'))), manifest };
}

export async function packageOperations(output = resolve(project, 'dist/operations.zip'), root = project) {
  const { archive, manifest } = await buildOperationsArchive(root);
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, archive, { flag: 'wx', mode: 0o600 });
    await rename(temporary, output);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return { output, version: manifest.version, files: manifest.files.length, bytes: archive.length, sha256: createHash('sha256').update(archive).digest('hex') };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await packageOperations()));
  } catch (error) {
    console.error(`operations package: ${error instanceof Error ? error.message : 'archive creation failed'}`);
    process.exitCode = 1;
  }
}
