import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { releaseTarget, requireReleaseImage } from '../scripts/release-target.mjs';
import { renderReleaseCompose } from '../scripts/render-release-compose.mjs';
import { inspectComposeContract } from '../scripts/compose-contract.mjs';
import { releasePolicy } from '../scripts/release-policy.mjs';

const source = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
const workflow = parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
const ci = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));

test('release target normalizes the owning repository without selecting an upstream default', () => {
  assert.deepEqual(releaseTarget('addxiaoyi/PerPay'), {
    repository: 'addxiaoyi/perpay', image: 'ghcr.io/addxiaoyi/perpay', registry: 'https://ghcr.io/v2/addxiaoyi/perpay',
  });
  assert.deepEqual(releaseTarget('addxiaoyi/PerPay', 'AddXiaoYi/perpay'), releaseTarget('addxiaoyi/PerPay'));
  assert.throws(() => releaseTarget('addxiaoyi/PerPay', 'Mashiro0619/PerPay'), /must match the trusted/);
  for (const value of [undefined, null, '', ' addxiaoyi/PerPay', 'addxiaoyi/PerPay\nIMAGE_NAME=unsafe',
    'https://github.com/addxiaoyi/PerPay', 'addxiaoyi/PerPay.git', '../PerPay', 'addxiaoyi/../PerPay',
    'addxiaoyi/PerPay:latest', 'addxiaoyi/PerPay@sha256:abc', '-bad/PerPay']) {
    assert.throws(() => releaseTarget(value));
  }
});

test('release target CLI refuses a different owner or image before writing outputs', () => {
  const env = { ...process.env, GITHUB_REPOSITORY: 'addxiaoyi/PerPay' };
  delete env.PERPAY_RELEASE_REPOSITORY;
  const valid = spawnSync(process.execPath, ['scripts/release-target.mjs'], { encoding: 'utf8', env });
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.stdout, 'repository=addxiaoyi/perpay\nimage_name=ghcr.io/addxiaoyi/perpay\n');
  const wrongOwner = spawnSync(process.execPath, ['scripts/release-target.mjs'], {
    encoding: 'utf8', env: { ...env, PERPAY_RELEASE_REPOSITORY: 'Mashiro0619/PerPay' },
  });
  assert.notEqual(wrongOwner.status, 0);
  assert.equal(wrongOwner.stdout, '');
  const wrongImage = spawnSync(process.execPath, ['scripts/release-target.mjs', '--check-image', 'ghcr.io/mashiro0619/perpay'], { encoding: 'utf8', env });
  assert.notEqual(wrongImage.status, 0);
  assert.equal(wrongImage.stdout, '');
});

test('release Compose changes only its three image references for the verified repository', () => {
  for (const version of ['1.2.3', '1.2.4-rc.1']) {
    const rendered = renderReleaseCompose(source, version, 'ghcr.io/addxiaoyi/perpay');
    assert.equal(inspectComposeContract(rendered).image, 'ghcr.io/addxiaoyi/perpay:' + releasePolicy(version).composeImageTag);
    assert.equal(rendered.match(/ghcr\.io\/addxiaoyi\/perpay:/gu).length, 3);
    assert.doesNotMatch(rendered, /ghcr\.io\/mashiro0619\/perpay:/u);
  }
  assert.equal(renderReleaseCompose(source, '1.2.3'), source);
  assert.equal(requireReleaseImage('addxiaoyi/PerPay', 'ghcr.io/addxiaoyi/perpay:1.2.4-rc.1', '1.2.4-rc.1'),
    'ghcr.io/addxiaoyi/perpay:1.2.4-rc.1');
  for (const image of ['ghcr.io/mashiro0619/perpay:1.2.4-rc.1', 'ghcr.io/addxiaoyi/perpay:latest',
    'ghcr.io/addxiaoyi/perpay:1.2.4-rc.1@sha256:' + 'a'.repeat(64)]) {
    assert.throws(() => requireReleaseImage('addxiaoyi/PerPay', image, '1.2.4-rc.1'), /match this repository/);
  }
});

test('release Compose CLI requires the explicit override to match trusted Actions context and channel', () => {
  const directory = mkdtempSync(join(tmpdir(), 'perpay-release-target-'));
  try {
    const output = join(directory, 'compose.yml');
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const tag = releasePolicy(version).composeImageTag;
    const env = { ...process.env, GITHUB_REPOSITORY: 'addxiaoyi/PerPay', PERPAY_IMAGE: 'ghcr.io/addxiaoyi/perpay:' + tag };
    const valid = spawnSync(process.execPath, ['scripts/render-release-compose.mjs', output], { env, encoding: 'utf8' });
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(inspectComposeContract(readFileSync(output, 'utf8')).image, env.PERPAY_IMAGE);
    const before = readFileSync(output, 'utf8');
    const invalid = spawnSync(process.execPath, ['scripts/render-release-compose.mjs', output], {
      env: { ...env, PERPAY_IMAGE: 'ghcr.io/mashiro0619/perpay:' + tag }, encoding: 'utf8',
    });
    assert.notEqual(invalid.status, 0);
    assert.equal(readFileSync(output, 'utf8'), before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('release verifies the owning target before any authenticated image publication', () => {
  assert.equal(workflow.env?.IMAGE_NAME, undefined);
  assert.equal(workflow.jobs.verify.outputs.image_name, '${{ steps.release_target.outputs.image_name }}');
  assert.equal(workflow.jobs.publish.env.IMAGE_NAME, '${{ needs.verify.outputs.image_name }}');
  const verify = workflow.jobs.verify.steps.find(step => step.id === 'release_target');
  assert.equal(verify.run, 'node scripts/release-target.mjs >> "$GITHUB_OUTPUT"');
  const steps = workflow.jobs.publish.steps;
  const target = steps.findIndex(step => step.name === 'Validate repository-scoped publication target');
  const login = steps.findIndex(step => step.name === 'Log in to GHCR');
  assert.ok(target >= 0 && target < login);
  assert.equal(steps[target].run, 'node scripts/release-target.mjs --check-image "$IMAGE_NAME"');
  const render = steps.find(step => step.name === 'Render and validate the release Compose');
  assert.equal(render.env.PERPAY_IMAGE, '${{ env.IMAGE_NAME }}:${{ needs.verify.outputs.compose_image_tag }}');
});

test('CI and release execute the registered Python operational regressions with bounded steps', () => {
  for (const steps of [ci.jobs.check.steps, workflow.jobs.verify.steps]) {
    const python = steps.find(step => step.name === 'Run Python operations safety checks');
    assert.ok(python, 'Python operations gate is required');
    assert.equal(python.run, 'npm run test:operations');
    assert.equal(python['timeout-minutes'], 5);
    assert.doesNotMatch(python.run, /unittest\s+discover/u);
  }
});
