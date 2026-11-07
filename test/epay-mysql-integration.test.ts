import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createConnection } from "mysql2/promise";

import { AppDatabase } from "../src/database/database.ts";
import { mysqlSnapshotConfig, snapshotIsolatedMysql } from "../src/epay-compat/mysql-snapshot.ts";
import { readAuthenticatedEPaySnapshot } from "../src/epay-compat/authenticated-snapshot.ts";
import { SOURCE_TABLES } from "../src/epay-compat/snapshot.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { requireIsolatedMysql } from "./epay-isolation-guard.ts";

it("copies and decrypts an isolated MySQL fixture exactly with a select-only account", { skip: !process.env.EPAY_TEST_MYSQL_URL }, async () => {
  const url = process.env.EPAY_TEST_MYSQL_URL!;
  requireIsolatedMysql(url, "epay_fixture", process.env.EPAY_ISOLATED_TEST);
  const key = randomBytes(32);
  const dir = mkdtempSync(join(tmpdir(), "epay-mysql-"));
  const db = await AppDatabase.open(join(dir, "test.sqlite"), { masterKey: key });
  const source = await createConnection(mysqlSnapshotConfig(url));
  try {
    await source.query("SET SESSION time_zone = '+08:00'");
    await assert.rejects(source.query("INSERT INTO `Config` (`key`, `value`) VALUES ('forbidden', 'test')"), /denied/i);
    const result = await snapshotIsolatedMysql({ mysqlUrl: url, database: db, masterKey: key, instanceId: db.instanceId(), sourceName: "fixture" });
    const snapshot = readAuthenticatedEPaySnapshot({ database: db, masterKey: key, instanceId: db.instanceId(), sourceName: "fixture", requireColumnMetadata: true }, result.snapshotId);
    for (const [table, primaryKey] of Object.entries(SOURCE_TABLES)) {
      assert.ok(snapshot.columns?.[table as keyof typeof SOURCE_TABLES].includes(primaryKey), `missing authenticated columns for ${table}`);
    }
    const cipher = new RuntimeSecretCipher(key, db.instanceId());
    for (const [table, count] of Object.entries(result.counts)) {
      const [rows] = await source.query(`SELECT * FROM \`${table}\``);
      assert.equal(count, 1);
      const stored = db.read((sql) => sql.prepare("SELECT * FROM epay_snapshot_rows WHERE snapshot_id = ? AND source_table = ? AND row_index = 0").get(result.snapshotId, table)) as Record<string, unknown>;
      const plain = cipher.decrypt(`epay:snapshot:${result.snapshotId}:${table}:0`, 1, {
        cipherVersion: 1,
        nonce: Buffer.from(stored.nonce as Uint8Array),
        ciphertext: Buffer.from(stored.ciphertext as Uint8Array),
        authenticationTag: Buffer.from(stored.authentication_tag as Uint8Array),
      });
      assert.deepEqual(JSON.parse(plain.toString()), (rows as unknown[])[0]);
    }
  } finally {
    await source.end();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
