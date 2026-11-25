import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const TEST_TIMEOUT_MS = 60_000;

export const PYTHON_TESTS = Object.freeze([
  'test/cutover-proxy.test.py',
  'test/deploy-maintenance-candidate.test.py',
  'test/fa-piao-deployment.test.py',
  'test/payment-alerts.test.py',
  'test/payment-automation-install.test.py',
  'test/source-sync-observer.test.py',
]);

function discoverTests(directory, relative = 'test') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Python test paths cannot be symbolic links: ${name}`);
    if (entry.isDirectory()) return discoverTests(resolve(directory, entry.name), name);
    return entry.isFile() && entry.name.endsWith('.test.py') ? [name] : [];
  });
}

export function inspectPythonTests(root, registered = PYTHON_TESTS) {
  if (!Array.isArray(registered) || registered.length === 0) throw new Error('Python test registry is empty');
  if (new Set(registered).size !== registered.length) throw new Error('Python test registry contains duplicates');
  for (const name of registered) {
    if (typeof name !== 'string' || !/^test\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.test\.py$/u.test(name)) {
      throw new Error('Python test registry contains an unsafe path');
    }
  }
  const found = discoverTests(resolve(root, 'test')).sort();
  const expected = [...registered].sort();
  const missing = expected.filter(name => !found.includes(name));
  const unregistered = found.filter(name => !expected.includes(name));
  if (missing.length || unregistered.length) {
    throw new Error(`Python test registry mismatch; missing: ${missing.join(', ') || 'none'}; unregistered: ${unregistered.join(', ') || 'none'}`);
  }
  const testRoot = realpathSync(resolve(root, 'test'));
  for (const name of expected) {
    const file = resolve(root, name);
    if (!lstatSync(file).isFile() || !realpathSync(file).startsWith(testRoot + sep)) {
      throw new Error(`Python test must be a regular file inside test/: ${name}`);
    }
  }
  return expected;
}

export function runOperations({ root = project, python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), run = spawnSync, log = console.log } = {}) {
  const tests = inspectPythonTests(root);
  let failures = 0;
  for (const [index, name] of tests.entries()) {
    log(`operations: [${index + 1}/${tests.length}] ${name}`);
    const completed = run(python, ['-B', '-X', 'utf8', name], {
      cwd: root, stdio: 'inherit', shell: false, timeout: TEST_TIMEOUT_MS,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    if (completed.error || completed.signal || completed.status !== 0) {
      failures += 1;
      log(`operations: FAIL ${name} (${completed.error?.code || completed.signal || `exit ${completed.status}`})`);
    }
  }
  log(`operations: ${tests.length - failures}/${tests.length} test files passed`);
  return failures === 0 ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exitCode = runOperations();
  } catch (error) {
    console.error(`operations: ${error instanceof Error ? error.message : 'test runner failed'}`);
    process.exitCode = 1;
  }
}
