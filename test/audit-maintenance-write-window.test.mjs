import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/audit-maintenance-write-window.mjs", import.meta.url));

function run(cutoff) {
  return spawnSync(process.execPath, [script, cutoff], {
    encoding: "utf8",
    env: { ...process.env, PATH: "" },
    timeout: 30000,
  });
}

test("rejects an invalid cutoff before inspecting processes", () => {
  const result = run("not-a-date");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected maintenance cutoff/);
  assert.equal(result.stdout, "");
});

test("reports unavailable PM2 without printing environment values", () => {
  const marker = "secret-value-that-must-not-be-logged";
  const result = spawnSync(process.execPath, [script, "2026-11-03 13:15:23"], {
    encoding: "utf8",
    env: { ...process.env, PATH: "", DATABASE_URL: marker },
    timeout: 30000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unable to read EPay process inventory/);
  assert.doesNotMatch(result.stderr + result.stdout, new RegExp(marker));
  assert.equal(result.stdout, "");
});

test("does not expose malformed PM2 output", { skip: process.platform === "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "epay-audit-test-"));
  const marker = "sensitive-process-output";
  try {
    const executable = join(directory, "pm2");
    writeFileSync(executable, `#!/bin/sh\nprintf '%s' '{"secret":"${marker}"'\n`);
    chmodSync(executable, 0o700);
    const result = spawnSync(process.execPath, [script, "2026-11-03 13:15:23"], {
      encoding: "utf8",
      env: { ...process.env, PATH: directory },
      timeout: 30000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unable to read EPay process inventory/);
    assert.doesNotMatch(result.stderr + result.stdout, new RegExp(marker));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
