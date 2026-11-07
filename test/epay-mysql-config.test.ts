import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import { AppDatabase } from "../src/database/database.ts";
import { readAuthenticatedEPaySnapshot } from "../src/epay-compat/authenticated-snapshot.ts";
import { mysqlSnapshotConfig, snapshotMysqlConnection } from "../src/epay-compat/mysql-snapshot.ts";
import { SOURCE_TABLES, type SnapshotSource } from "../src/epay-compat/snapshot.ts";

it("limits snapshot connections and preserves database values exactly", () => {
  const config = mysqlSnapshotConfig("mysql://reader:fixture@127.0.0.1:3307/epay_fixture");
  assert.equal(config.port, 3307);
  assert.equal(config.dateStrings, true);
  assert.equal(config.bigNumberStrings, true);
  assert.equal(config.decimalNumbers, false);
  assert.equal(config.multipleStatements, false);
  assert.throws(() => mysqlSnapshotConfig("mysql://reader:fixture@production.example/epay"));
  assert.throws(() => mysqlSnapshotConfig("mysql://reader:fixture@localhost/epay?dateStrings=false"));
  assert.throws(() => mysqlSnapshotConfig("not-a-url"));
});

it("captures authenticated column metadata through the MySQL snapshot wrapper", async () => {
  const directory = mkdtempSync(join(tmpdir(), "epay-mysql-wrapper-"));
  const key = randomBytes(32);
  const database = await AppDatabase.open(join(directory, "snapshot.sqlite"), { masterKey: key });
  const queries: string[] = [];
  const source: SnapshotSource = { async query(sql) {
    queries.push(sql);
    if (sql.includes("information_schema.TABLES")) {
      return [Object.keys(SOURCE_TABLES).map(TABLE_NAME => ({ TABLE_NAME, ENGINE: "InnoDB" })), []];
    }
    const table = /^SELECT \* FROM `([^`]+)`/.exec(sql)?.[1] as keyof typeof SOURCE_TABLES | undefined;
    return table ? [[], [{ name: SOURCE_TABLES[table] }]] : [[], []];
  } };
  try {
    const options = { database, masterKey: key, instanceId: database.instanceId(), sourceName: "fixture" };
    const result = await snapshotMysqlConnection(source, options);
    const snapshot = readAuthenticatedEPaySnapshot({ ...options, requireColumnMetadata: true }, result.snapshotId);
    assert.deepEqual(snapshot.columns?.Invoice, ["id"]);
    assert.deepEqual(result.counts, result.verified);
    assert.equal(queries[0], "SET SESSION time_zone = '+00:00'");
  } finally {
    database.close();
    key.fill(0);
    rmSync(directory, { recursive: true, force: true });
  }
});
