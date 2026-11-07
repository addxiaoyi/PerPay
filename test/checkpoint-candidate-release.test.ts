import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { it } from "node:test";
import { DATABASE_COMPATIBILITY } from "../src/version.ts";
import { AppDatabase } from "../src/database/database.ts";
import { RuntimeSettingsStore } from "../src/settings/store.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { writeEncryptedChannelConfig } from "../src/epay-compat/channel-config.ts";

it("restores both same-schema releases with the original key and preserves source records", async () => {
  const directory = mkdtempSync(join(tmpdir(), "perpay-release-checkpoint-"));
  const source = join(directory, "source"), checkpoint = join(directory, "checkpoint");
  const masterKey = randomBytes(32);
  mkdirSync(join(source, "data"), { recursive: true });
  mkdirSync(join(checkpoint, "secrets"), { recursive: true });
  writeFileSync(join(checkpoint, "secrets", "master-key"), masterKey.toString("hex"), { mode: 0o600 });
  const database = await AppDatabase.open(join(source, "data", "perpay.sqlite3"), { masterKey });
  try {
    new RuntimeSettingsStore(database, masterKey).initialize();
    database.write(sql => {
      sql.exec("INSERT INTO epay_merchant_accounts VALUES(1,'fixture',12345,1,500,0,0)");
      sql.exec("INSERT INTO epay_channels(channel_id,provider,code,name,product,enabled,rate_bps,created_at,updated_at) VALUES(1,'ALIPAY','alipay','fixture','pc',1,0,0,0)");
      writeEncryptedChannelConfig(sql, new RuntimeSecretCipher(masterKey, database.instanceId()), 1, JSON.stringify({ secret: "fixture-channel-secret" }));
    });
  } finally { database.close(); }
  try {
    const release = resolve(".");
    const execution = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "scripts/checkpoint-candidate-release.ts", release, release, source, checkpoint]);
    assert.doesNotMatch(execution.stdout + execution.stderr, /fixture-channel-secret/);
    const report = JSON.parse(readFileSync(join(checkpoint, "restore.json"), "utf8"));
    assert.equal(report.oldReleaseRestored, true);
    assert.equal(report.candidateRestored, true);
    assert.equal(report.sourceUnchanged, true);
    assert.equal(report.backup.schemaVersion, DATABASE_COMPATIBILITY.maximum);
    assert.ok(report.comparedTables > 100);
  } finally { masterKey.fill(0); rmSync(directory, { recursive: true, force: true }); }
});
