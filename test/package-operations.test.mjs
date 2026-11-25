import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { assertPublicSource, buildOperationsArchive, OPERATIONS_FILES } from '../scripts/package-operations.mjs';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'perpay-operations-zip-'));
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.0.0-rc.24' }));
    for (const name of OPERATIONS_FILES) {
      await mkdir(dirname(join(root, name)), { recursive: true });
      await writeFile(join(root, name), `public source ${name}\n`);
    }
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function unzip(archive) {
  const entries = new Map();
  let offset = 0;
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = archive.readUInt32LE(offset + 18);
    const nameSize = archive.readUInt16LE(offset + 26);
    const extraSize = archive.readUInt16LE(offset + 28);
    const name = archive.subarray(offset + 30, offset + 30 + nameSize).toString('utf8');
    const start = offset + 30 + nameSize + extraSize;
    entries.set(name, inflateRawSync(archive.subarray(start, start + compressedSize)));
    offset = start + compressedSize;
  }
  return entries;
}

test('operations ZIP is deterministic and excludes private files outside its fixed allowlist', () => fixture(async root => {
  for (const name of ['.env', 'credentials.json', 'master.key', 'artifacts/private.json', 'data/payment.sqlite3',
    'scripts/perpay-offsite-backup.py', 'scripts/install-offsite-backup.py']) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), 'PRIVATE_SENTINEL_NEVER_SHIP');
  }
  const first = await buildOperationsArchive(root), second = await buildOperationsArchive(root);
  assert.deepEqual(first.archive, second.archive);
  const entries = unzip(first.archive);
  assert.deepEqual([...entries.keys()].sort(), [...OPERATIONS_FILES, 'manifest.json'].map(name => `perpay-operations/${name}`).sort());
  assert.ok([...entries.values()].every(bytes => !bytes.includes('PRIVATE_SENTINEL_NEVER_SHIP')));
  const manifest = JSON.parse(entries.get('perpay-operations/manifest.json').toString());
  assert.equal(manifest.version, '1.0.0-rc.24');
  for (const file of manifest.files) {
    const bytes = entries.get(`perpay-operations/${file.path}`);
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
  }
}));

test('operations allowlist contains current monitoring tools and excludes paused backup drafts', () => {
  for (const name of ['scripts/install-payment-automation.py', 'scripts/observe-source-sync.py',
    'scripts/check-invoice-automation.ts', 'src/invoices/automation-readiness.ts',
    'docs/payment-alert-automation.md', 'docs/source-sync-automation.md']) {
    assert.ok(OPERATIONS_FILES.includes(name), 'missing operational source: ' + name);
  }
  assert.ok(OPERATIONS_FILES.every(name => !name.startsWith('artifacts/') && !/offsite|private|\.env/u.test(name)));
});

test('operations package refuses a symlinked parent even when it points inside the checkout', async t => fixture(async root => {
  const original = join(root, 'docs'), moved = join(root, 'private-docs');
  await rename(original, moved);
  try {
    await symlink(moved, original, 'junction');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip('symlink creation requires host permission'); return; }
    throw error;
  }
  await assert.rejects(buildOperationsArchive(root), /symbolic links/u);
}));

test('package refuses missing allowlisted files and embedded credential literals', () => fixture(async root => {
  await rm(join(root, OPERATIONS_FILES[0]));
  await assert.rejects(buildOperationsArchive(root), /ENOENT/u);
  assert.throws(() => assertPublicSource('scripts/example.py', Buffer.from('api_secret = "production-credential"')), /credential material/u);
  assert.throws(() => assertPublicSource('scripts/example.py', Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----')), /credential material/u);
  assert.doesNotThrow(() => assertPublicSource('scripts/example.py', Buffer.from('api_secret = "<YOUR_SECRET>"')));
}));
