import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { inspectPythonTests, PYTHON_TESTS, runOperations } from '../scripts/test-operations.mjs';

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'perpay-operations-'));
  try {
    for (const name of PYTHON_TESTS) {
      mkdirSync(dirname(join(root, name)), { recursive: true });
      writeFileSync(join(root, name), '# isolated test fixture\n');
    }
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('Python registry rejects empty, missing, duplicate, and unsafe entries', () => fixture(root => {
  assert.throws(() => inspectPythonTests(root, []), /registry is empty/u);
  assert.throws(() => inspectPythonTests(root, [...PYTHON_TESTS, PYTHON_TESTS[0]]), /duplicates/u);
  assert.throws(() => inspectPythonTests(root, ['test/../outside.test.py']), /unsafe path/u);
  rmSync(join(root, PYTHON_TESTS[0]));
  assert.throws(() => inspectPythonTests(root), /missing:/u);
}));

test('new Python tests, including nested tests, cannot silently escape the registry', () => fixture(root => {
  mkdirSync(join(root, 'test/new'), { recursive: true });
  writeFileSync(join(root, 'test/new/backup.test.py'), '# new check\n');
  assert.throws(() => inspectPythonTests(root), /unregistered: test\/new\/backup\.test\.py/u);
}));

test('runner executes every registered file directly without shell interpretation', () => fixture(root => {
  const calls = [];
  const status = runOperations({ root, python: 'python-for-test', log() {}, run(command, args, options) {
    calls.push({ command, args, options });
    return { status: 0 };
  } });
  assert.equal(status, 0);
  assert.equal(calls.length, PYTHON_TESTS.length);
  assert.deepEqual(calls.map(call => call.args.at(-1)), [...PYTHON_TESTS].sort());
  assert.ok(calls.every(call => call.command === 'python-for-test' && call.options.shell === false && call.args.includes('-B')));
  assert.ok(calls.every(call => call.options.timeout === 60_000));
}));

test('a failed, timed-out, or unavailable Python process makes the whole gate fail', () => fixture(root => {
  for (const failure of [{ status: 1 }, { status: null, signal: 'SIGTERM' }, { status: null, error: { code: 'ENOENT' } }]) {
    let calls = 0;
    assert.equal(runOperations({ root, log() {}, run() { calls += 1; return calls === 1 ? failure : { status: 0 }; } }), 1);
    assert.equal(calls, PYTHON_TESTS.length);
  }
}));

test('CI and release invoke the operations gate and attach its separate host bundle', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.equal(pkg.scripts['test:operations'], 'node scripts/test-operations.mjs');
  assert.equal(pkg.scripts['operations:package'], 'node scripts/package-operations.mjs');
  assert.match(ci, /run: npm run test:operations/u);
  assert.match(release, /npm run test:operations/u);
  assert.match(release, /npm run operations:package/u);
  assert.match(release, /cp dist\/operations\.zip release-assets\/operations\.zip/u);
  assert.match(release, /gh release create[^\n]+release-assets\/operations\.zip/u);
  assert.match(release, /operations_sha256=/u);
  assert.doesNotMatch(dockerfile, /COPY\s+(?:--[^\s]+\s+)*scripts|apk[^\n]*python/iu);
});
