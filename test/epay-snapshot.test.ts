import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import { AppDatabase } from "../src/database/database.ts";
import { readAuthenticatedEPaySnapshot } from "../src/epay-compat/authenticated-snapshot.ts";
import { captureEPaySnapshot, SOURCE_TABLES, type SnapshotSource } from "../src/epay-compat/snapshot.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { verifyEPaySnapshot } from "../src/epay-compat/verify-snapshot.ts";

it("authenticates source columns for empty tables and rejects schema changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-snapshot-columns-"));
  const key = randomBytes(32);
  const db = await AppDatabase.open(join(dir, "test.sqlite"), { masterKey: key });
  let changed = false;
  const source: SnapshotSource = { async query(query) {
    const name = /^SELECT \* FROM `([^`]+)`/.exec(query)?.[1] as keyof typeof SOURCE_TABLES | undefined;
    if (!name) return [[], []];
    const fields: Array<{ name: string }> = [{ name: SOURCE_TABLES[name] }];
    if (changed && name === "Invoice") fields.push({ name: "new_column" });
    return [[], fields];
  } };
  try {
    const options = { source, database: db, masterKey: key, instanceId: db.instanceId(), sourceName: "fixture", requireColumnMetadata: true };
    const snapshot = await captureEPaySnapshot(options);
    assert.deepEqual(readAuthenticatedEPaySnapshot(options, snapshot.snapshotId).columns?.Invoice, ["id"]);
    assert.deepEqual(await verifyEPaySnapshot(options, snapshot.snapshotId), snapshot.counts);
    changed = true;
    await assert.rejects(verifyEPaySnapshot(options, snapshot.snapshotId), /snapshot column mismatch for Invoice/);
    changed = false;
    const old = await captureEPaySnapshot({ ...options, requireColumnMetadata: false });
    assert.throws(() => readAuthenticatedEPaySnapshot(options, old.snapshotId), /missing authenticated column metadata/);
    const noMetadata: SnapshotSource = { async query() { return [[], []]; } };
    await assert.rejects(captureEPaySnapshot({ ...options, source: noMetadata }), /source column metadata missing/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("reopens encrypted historical snapshots without storing fixture secrets in the database file", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "epay-snapshot-reopen-"));
  const path = join(dir, "snapshot.sqlite");
  const key = randomBytes(32);
  const fixtures = {
    Merchant: [{ id: 17, apiKey: "fixture-merchant-secret-reopen-82742" }],
    Channel: [{ id: 31, config: { privateKey: "fixture-channel-private-reopen-38193" } }],
    NotifyLog: [{ id: 51, params: { signature: "fixture-callback-signature-reopen-19482" } }],
  };
  const source: SnapshotSource = { async query(query) {
    const name = /^SELECT \* FROM `([^`]+)`/.exec(query)?.[1] as keyof typeof fixtures | undefined;
    return [name ? fixtures[name] ?? [] : [], []];
  } };
  let db: AppDatabase | undefined;
  try {
    db = await AppDatabase.open(path, { masterKey: key });
    const instanceId = db.instanceId();
    const captured = await captureEPaySnapshot({ source, database: db, masterKey: key, instanceId, sourceName: "reopen-fixture" });
    db.close();
    db = undefined;
    const bytes = readFileSync(path);
    for (const secret of ["fixture-merchant-secret-reopen-82742", "fixture-channel-private-reopen-38193", "fixture-callback-signature-reopen-19482"]) {
      assert.equal(bytes.includes(Buffer.from(secret)), false);
    }
    db = await AppDatabase.open(path, { masterKey: key });
    assert.equal(db.instanceId(), instanceId);
    assert.throws(() => readAuthenticatedEPaySnapshot({ database: db!, masterKey: randomBytes(32), instanceId, sourceName: "reopen-fixture" }, captured.snapshotId), /manifest authentication failed/);
    const decrypted: Buffer[] = [];
    const decrypt = RuntimeSecretCipher.prototype.decrypt;
    t.mock.method(RuntimeSecretCipher.prototype, "decrypt", function (this: RuntimeSecretCipher, ...args: Parameters<RuntimeSecretCipher["decrypt"]>) {
      const plaintext = decrypt.apply(this, args);
      decrypted.push(plaintext);
      return plaintext;
    });
    const snapshot = readAuthenticatedEPaySnapshot({ database: db, masterKey: key, instanceId, sourceName: "reopen-fixture" }, captured.snapshotId);
    assert.ok(decrypted.length > 1);
    assert.ok(decrypted.every((plaintext) => plaintext.every((byte) => byte === 0)));
    assert.deepEqual(snapshot.tables.Merchant, fixtures.Merchant);
    assert.deepEqual(snapshot.tables.Channel, fixtures.Channel);
    assert.deepEqual(snapshot.tables.NotifyLog, fixtures.NotifyLog);
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("rejects nonexistent and incomplete snapshots even when the source is empty", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-snapshot-missing-"));
  const key = randomBytes(32);
  const db = await AppDatabase.open(join(dir, "test.sqlite"), { masterKey: key });
  const source: SnapshotSource = { async query() { return [[], []]; } };
  try {
    const options = { source, database: db, masterKey: key, instanceId: db.instanceId(), sourceName: "fixture" };
    await assert.rejects(verifyEPaySnapshot(options, "not-a-snapshot"), /does not exist/);
    const snapshot = await captureEPaySnapshot(options);
    assert.deepEqual(await verifyEPaySnapshot(options, snapshot.snapshotId), snapshot.counts);
    await assert.rejects(verifyEPaySnapshot({ ...options, sourceName: "other-source" }, snapshot.snapshotId), /source name mismatch/);
    db.write((sql) => sql.prepare("UPDATE epay_snapshot_runs SET counts_json = ? WHERE snapshot_id = ?").run(JSON.stringify({ ...snapshot.counts, Merchant: 1 }), snapshot.snapshotId));
    await assert.rejects(verifyEPaySnapshot(options, snapshot.snapshotId), /manifest count mismatch/);
    db.write((sql) => {
      sql.prepare("UPDATE epay_snapshot_runs SET counts_json = ? WHERE snapshot_id = ?").run(JSON.stringify(snapshot.counts), snapshot.snapshotId);
      sql.prepare("INSERT INTO epay_snapshot_rows VALUES (?, ?, ?, ?, ?, ?, ?)").run(snapshot.snapshotId, "Unexpected", 0, 1, Buffer.alloc(12), Buffer.alloc(1), Buffer.alloc(16));
    });
    await assert.rejects(verifyEPaySnapshot(options, snapshot.snapshotId), /unknown table/);
    db.write((sql) => sql.prepare("UPDATE epay_snapshot_runs SET counts_json = ? WHERE snapshot_id = ?").run("{}", snapshot.snapshotId));
    await assert.rejects(verifyEPaySnapshot(options, snapshot.snapshotId), /counts are invalid/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("rejects coordinated row deletion and count tampering, and fails closed on old snapshots", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-snapshot-manifest-"));
  const key = randomBytes(32);
  const db = await AppDatabase.open(join(dir, "test.sqlite"), { masterKey: key });
  let sourceHasMerchant = true;
  const source: SnapshotSource = { async query(sql) {
    if (sourceHasMerchant && sql.startsWith("SELECT * FROM `Merchant`")) return [[{ id: 1001, money: "1.00" }], []];
    return [[], []];
  } };
  try {
    const options = { source, database: db, masterKey: key, instanceId: db.instanceId(), sourceName: "fixture" };
    const snapshot = await captureEPaySnapshot(options);
    db.write((sql) => {
      sql.prepare("DELETE FROM epay_snapshot_rows WHERE snapshot_id = ? AND source_table = ?").run(snapshot.snapshotId, "Merchant");
      sql.prepare("UPDATE epay_snapshot_runs SET counts_json = ? WHERE snapshot_id = ?").run(JSON.stringify({ ...snapshot.counts, Merchant: 0 }), snapshot.snapshotId);
    });
    sourceHasMerchant = false;
    await assert.rejects(verifyEPaySnapshot(options, snapshot.snapshotId), /manifest count mismatch/);
    db.write((sql) => sql.prepare("DELETE FROM epay_snapshot_rows WHERE snapshot_id = ? AND source_table = ?").run(snapshot.snapshotId, "__manifest__"));
    await assert.rejects(verifyEPaySnapshot(options, snapshot.snapshotId), /missing an authenticated manifest/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("rejects manifest ciphertext tampering", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-snapshot-manifest-"));
  const key = randomBytes(32);
  const db = await AppDatabase.open(join(dir, "test.sqlite"), { masterKey: key });
  const source: SnapshotSource = { async query() { return [[], []]; } };
  try {
    const options = { source, database: db, masterKey: key, instanceId: db.instanceId(), sourceName: "fixture" };
    const snapshot = await captureEPaySnapshot(options);
    db.write((sql) => sql.prepare("UPDATE epay_snapshot_rows SET authentication_tag = ? WHERE snapshot_id = ? AND source_table = ?").run(Buffer.alloc(16), snapshot.snapshotId, "__manifest__"));
    await assert.rejects(verifyEPaySnapshot(options, snapshot.snapshotId), /manifest authentication failed/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("reads authenticated rows without reconnecting to MySQL and rejects tampered rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-snapshot-read-"));
  const key = randomBytes(32);
  const db = await AppDatabase.open(join(dir, "test.sqlite"), { masterKey: key });
  const source: SnapshotSource = { async query(sql) {
    if (sql.startsWith("SELECT * FROM `Merchant`")) return [[{ id: 1001, money: "0.29", apiKey: "fixture-secret" }], []];
    return [[], []];
  } };
  try {
    const options = { source, database: db, masterKey: key, instanceId: db.instanceId(), sourceName: "fixture" };
    const snapshot = await captureEPaySnapshot(options);
    const read = readAuthenticatedEPaySnapshot(options, snapshot.snapshotId);
    assert.deepEqual(read.tables.Merchant, [{ id: 1001, money: "0.29", apiKey: "fixture-secret" }]);
    assert.deepEqual(read.counts, snapshot.counts);
    assert.throws(() => readAuthenticatedEPaySnapshot({ ...options, masterKey: randomBytes(32) }, snapshot.snapshotId), /manifest authentication failed/);
    db.write((sql) => sql.prepare("UPDATE epay_snapshot_rows SET authentication_tag = ? WHERE snapshot_id = ? AND source_table = ?").run(Buffer.alloc(16), snapshot.snapshotId, "Merchant"));
    assert.throws(() => readAuthenticatedEPaySnapshot(options, snapshot.snapshotId), /row authentication failed for Merchant/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("rejects duplicate primary keys in authenticated source rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-snapshot-read-"));
  const key = randomBytes(32);
  const db = await AppDatabase.open(join(dir, "test.sqlite"), { masterKey: key });
  const source: SnapshotSource = { async query(sql) {
    if (sql.startsWith("SELECT * FROM `Merchant`")) return [[{ id: 1001 }, { id: 1002 }], []];
    return [[], []];
  } };
  try {
    const options = { source, database: db, masterKey: key, instanceId: db.instanceId(), sourceName: "fixture" };
    const snapshot = await captureEPaySnapshot(options);
    const sealed = new RuntimeSecretCipher(key, db.instanceId()).encrypt(`epay:snapshot:${snapshot.snapshotId}:Merchant:1`, 1, JSON.stringify({ id: 1001 }));
    db.write((sql) => sql.prepare("UPDATE epay_snapshot_rows SET nonce=?, ciphertext=?, authentication_tag=? WHERE snapshot_id=? AND source_table='Merchant' AND row_index=1")
      .run(sealed.nonce, sealed.ciphertext, sealed.authenticationTag, snapshot.snapshotId));
    assert.throws(() => readAuthenticatedEPaySnapshot(options, snapshot.snapshotId), /primary key is duplicated for Merchant/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("rolls back capture before persisting duplicate or invalid source keys", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-snapshot-keys-"));
  const key = randomBytes(32);
  const db = await AppDatabase.open(join(dir, "test.sqlite"), { masterKey: key });
  try {
    for (const rows of [[{ id: 1001 }, { id: "1001" }], [{ id: "" }], [{ id: 1.5 }]]) {
      const calls: string[] = [];
      const source: SnapshotSource = { async query(sql) {
        calls.push(sql);
        return [sql.startsWith("SELECT * FROM `Merchant`") ? rows : [], []];
      } };
      await assert.rejects(captureEPaySnapshot({ source, database: db, masterKey: key, instanceId: db.instanceId(), sourceName: "fixture" }), /snapshot source primary key is (duplicated|invalid)/);
      assert.equal(calls.at(-1), "ROLLBACK");
    }
    const count = db.read((sql) => sql.prepare("SELECT count(*) AS count FROM epay_snapshot_runs").get()) as { count: bigint };
    assert.equal(count.count, 0n);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("captures one consistent snapshot, encrypts every row and preserves decimal strings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-snapshot-"));
  const key = randomBytes(32);
  const db = await AppDatabase.open(join(dir, "test.sqlite"), { masterKey: key });
  const calls: string[] = [];
  const source: SnapshotSource = { async query(sql) {
    calls.push(sql);
    if (sql.startsWith("SELECT * FROM `Merchant`")) return [[{ id: 1001, money: "9999999999.99", apiKey: "private-test-value" }], []];
    if (sql.startsWith("SELECT * FROM `Config`")) return [[{ key: "secret", value: "private-config" }], []];
    return [[], []];
  } };
  try {
    const result = await captureEPaySnapshot({ source, database: db, masterKey: key, instanceId: db.instanceId(), sourceName: "fixture" });
    assert.equal(calls[0], "SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    assert.equal(calls[1], "START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
    assert.equal(calls.at(-1), "COMMIT");
    assert.equal(result.counts.Merchant, 1);
    const row = db.read((sql) => sql.prepare("SELECT * FROM epay_snapshot_rows WHERE source_table = ?").get("Merchant")) as Record<string, unknown>;
    assert.equal(Buffer.from(row.ciphertext as Uint8Array).includes(Buffer.from("private-test-value")), false);
    const cipher = new RuntimeSecretCipher(key, db.instanceId());
    const decrypted = cipher.decrypt(`epay:snapshot:${result.snapshotId}:Merchant:0`, 1, {
      cipherVersion: 1,
      nonce: Buffer.from(row.nonce as Uint8Array),
      ciphertext: Buffer.from(row.ciphertext as Uint8Array),
      authenticationTag: Buffer.from(row.authentication_tag as Uint8Array),
    });
    assert.deepEqual(JSON.parse(decrypted.toString()), { id: 1001, money: "9999999999.99", apiKey: "private-test-value" });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("rolls back the source and writes no snapshot when a source table fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-snapshot-"));
  const key = randomBytes(32);
  const db = await AppDatabase.open(join(dir, "test.sqlite"), { masterKey: key });
  const calls: string[] = [];
  const source: SnapshotSource = { async query(sql) {
    calls.push(sql);
    if (sql.startsWith("SELECT * FROM `Order`")) throw new Error("fixture failure");
    return [[], []];
  } };
  try {
    await assert.rejects(captureEPaySnapshot({ source, database: db, masterKey: key, instanceId: db.instanceId(), sourceName: "fixture" }), /fixture failure/);
    assert.equal(calls.at(-1), "ROLLBACK");
    const row = db.read((sql) => sql.prepare("SELECT count(*) AS count FROM epay_snapshot_runs").get()) as { count: bigint };
    assert.equal(row.count, 0n);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("rolls back the destination when a row cannot be serialized", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-snapshot-"));
  const key = randomBytes(32);
  const db = await AppDatabase.open(join(dir, "test.sqlite"), { masterKey: key });
  const source: SnapshotSource = { async query(sql) {
    if (sql.startsWith("SELECT * FROM `Merchant`")) return [[{ id: 1001, value: 1n }], []];
    return [[], []];
  } };
  try {
    await assert.rejects(captureEPaySnapshot({ source, database: db, masterKey: key, instanceId: db.instanceId(), sourceName: "fixture" }), /BigInt/);
    const row = db.read((sql) => sql.prepare("SELECT count(*) AS count FROM epay_snapshot_runs").get()) as { count: bigint };
    assert.equal(row.count, 0n);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("detects changed source rows during snapshot verification", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-snapshot-"));
  const key = randomBytes(32);
  const db = await AppDatabase.open(join(dir, "test.sqlite"), { masterKey: key });
  let amount = "0.29";
  const source: SnapshotSource = { async query(sql) {
    if (sql.startsWith("SELECT * FROM `Merchant`")) return [[{ id: 1001, money: amount }], []];
    return [[], []];
  } };
  try {
    const options = { source, database: db, masterKey: key, instanceId: db.instanceId(), sourceName: "fixture" };
    const snapshot = await captureEPaySnapshot(options);
    assert.deepEqual(await verifyEPaySnapshot(options, snapshot.snapshotId), snapshot.counts);
    amount = "0.30";
    await assert.rejects(verifyEPaySnapshot(options, snapshot.snapshotId), /content mismatch for Merchant/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
