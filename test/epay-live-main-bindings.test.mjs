import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';

const script = fileURLToPath(new URL('../scripts/audit-live-main-bindings.cjs', import.meta.url));

it('rejects invalid and duplicate digests without exposing environment values', () => {
  const marker = 'sensitive-database-url-marker';
  for (const args of [[], ['not-a-digest'], ['a'.repeat(64), 'a'.repeat(64)]]) {
    const run = spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: '', DATABASE_URL: marker },
      timeout: 10000,
    });
    assert.notEqual(run.status, 0);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /binding audit failed/);
    assert.doesNotMatch(run.stderr, new RegExp(marker));
  }
});

it('does not expose configuration when process inventory is unavailable', () => {
  const marker = 'sensitive-process-output-marker';
  const run = spawnSync(process.execPath, [script, 'a'.repeat(64)], {
    encoding: 'utf8',
    env: { ...process.env, PATH: '', DATABASE_URL: marker },
    timeout: 10000,
  });
  assert.notEqual(run.status, 0);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /binding audit failed/);
  assert.doesNotMatch(run.stderr, new RegExp(marker));
});
