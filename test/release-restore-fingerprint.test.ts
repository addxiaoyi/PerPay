import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { captureReleaseContents, compareReleaseContents } from "../scripts/rehearse-release-restore.ts";
import { EPAY_MERCHANT_KEY_SCHEMA_SQL } from "../src/epay-compat/merchant-key-schema.ts";

function snapshot(sql: DatabaseSync) {
  sql.exec("BEGIN");
  try { return captureReleaseContents(sql); }
  finally { sql.exec("ROLLBACK"); }
}

it("compares record contents independently of insertion order without rounding financial integers", () => {
  const first = new DatabaseSync(":memory:"), second = new DatabaseSync(":memory:");
  try {
    for (const sql of [first, second]) sql.exec("CREATE TABLE ledger (id TEXT, cents INTEGER, proof BLOB) STRICT");
    first.prepare("INSERT INTO ledger VALUES(?,?,?)").run("a", 9007199254740993n, Buffer.from([1, 2]));
    first.prepare("INSERT INTO ledger VALUES(?,?,?)").run("b", -3, Buffer.from([3]));
    second.prepare("INSERT INTO ledger VALUES(?,?,?)").run("b", -3, Buffer.from([3]));
    second.prepare("INSERT INTO ledger VALUES(?,?,?)").run("a", 9007199254740993n, Buffer.from([1, 2]));
    const baseline = snapshot(first);
    assert.deepEqual(compareReleaseContents(baseline, snapshot(second)), []);
    second.prepare("UPDATE ledger SET cents=? WHERE id='a'").run(9007199254740992n);
    assert.deepEqual(compareReleaseContents(baseline, snapshot(second)), ["ledger"]);
  } finally { first.close(); second.close(); }
});

it("detects changed secrets, removed tables and duplicate rows; new empty migration tables are permitted", () => {
  const sql = new DatabaseSync(":memory:");
  try {
    sql.exec("CREATE TABLE secrets (cipher BLOB); INSERT INTO secrets VALUES(X'01'); CREATE TABLE history (id TEXT); INSERT INTO history VALUES('original')");
    const baseline = snapshot(sql);
    sql.exec("CREATE TABLE access_grants (id TEXT)");
    assert.deepEqual(compareReleaseContents(baseline, snapshot(sql)), []);
    sql.exec("INSERT INTO access_grants VALUES('unexpected')");
    assert.deepEqual(compareReleaseContents(baseline, snapshot(sql)), ["access_grants"]);
    sql.exec("DELETE FROM access_grants; UPDATE secrets SET cipher=X'02'; INSERT INTO history VALUES('original')");
    assert.deepEqual(compareReleaseContents(baseline, snapshot(sql)), ["history", "secrets"]);
    sql.exec("DROP TABLE history");
    assert.deepEqual(compareReleaseContents(baseline, snapshot(sql)), ["history", "secrets"]);
  } finally { sql.close(); }
});

it("allows only process lease, schema history and the last-started-version metadata to differ", () => {
  const sql = new DatabaseSync(":memory:");
  try {
    sql.exec("CREATE TABLE system_metadata(key TEXT,value TEXT); INSERT INTO system_metadata VALUES('last_started_version','old'),('instance_id','stable'); CREATE TABLE app_lease(token TEXT); CREATE TABLE schema_migrations(version INTEGER)");
    assert.throws(() => captureReleaseContents(sql), /transaction/);
    const baseline = snapshot(sql);
    sql.exec("INSERT INTO app_lease VALUES('lease'); INSERT INTO schema_migrations VALUES(60); UPDATE system_metadata SET value='rc.4' WHERE key='last_started_version'");
    assert.deepEqual(compareReleaseContents(baseline, snapshot(sql)), []);
    sql.exec("UPDATE system_metadata SET value='changed' WHERE key='instance_id'");
    assert.deepEqual(compareReleaseContents(baseline, snapshot(sql)), ["system_metadata"]);
  } finally { sql.close(); }
});

it("requires the exact source key and order mapping when validating schema 63 additions", () => {
  const sql = new DatabaseSync(":memory:");
  try {
    sql.exec(`CREATE TABLE epay_merchant_accounts(merchant_id INTEGER PRIMARY KEY); INSERT INTO epay_merchant_accounts VALUES(1);
      CREATE TABLE epay_orders(trade_no TEXT PRIMARY KEY,merchant_id INTEGER); INSERT INTO epay_orders VALUES('native',1),('historic',1);
      CREATE TABLE epay_alipay_intents(trade_no TEXT); INSERT INTO epay_alipay_intents VALUES('native');
      CREATE TABLE epay_wechat_intents(trade_no TEXT);
      CREATE TABLE epay_merchant_secrets(merchant_id INTEGER,secret_version INTEGER,cipher_version INTEGER,nonce BLOB,ciphertext BLOB,authentication_tag BLOB,secret_fingerprint TEXT,updated_at INTEGER);
      INSERT INTO epay_merchant_secrets VALUES(1,2,1,zeroblob(12),X'01',zeroblob(16),'${"a".repeat(64)}',1)`);
    sql.exec("BEGIN");
    const expected = captureReleaseContents(sql, { keyMigrationProjection: true });
    sql.exec("COMMIT");
    sql.exec(EPAY_MERCHANT_KEY_SCHEMA_SQL);
    assert.deepEqual(compareReleaseContents(expected, snapshot(sql)), []);
    assert.equal(sql.prepare("SELECT trade_no FROM epay_order_key_versions").get()?.trade_no, "native");
    sql.exec("DROP TRIGGER epay_merchant_key_history_no_update; UPDATE epay_merchant_key_versions SET ciphertext=X'02'");
    assert.deepEqual(compareReleaseContents(expected, snapshot(sql)), ["epay_merchant_key_versions"]);
    sql.exec("DROP TRIGGER epay_order_keys_no_delete; DELETE FROM epay_order_key_versions");
    assert.deepEqual(compareReleaseContents(expected, snapshot(sql)), ["epay_merchant_key_versions", "epay_order_key_versions"]);
  } finally { sql.close(); }
});

it("verifies schema 66 retry budgets start at zero and detects a changed budget", () => {
  const sql = new DatabaseSync(":memory:");
  try {
    sql.exec("CREATE TABLE epay_callback_jobs(trade_no TEXT,attempts INTEGER); INSERT INTO epay_callback_jobs VALUES('paid-order',12); BEGIN");
    const expected = captureReleaseContents(sql, { keyMigrationProjection: true });
    sql.exec("COMMIT; ALTER TABLE epay_callback_jobs ADD COLUMN retry_base_attempts INTEGER NOT NULL DEFAULT 0; ALTER TABLE epay_callback_jobs ADD COLUMN retry_base_gets INTEGER NOT NULL DEFAULT 0");
    assert.deepEqual(compareReleaseContents(expected, snapshot(sql)), []);
    sql.exec("UPDATE epay_callback_jobs SET retry_base_attempts=12");
    assert.deepEqual(compareReleaseContents(expected, snapshot(sql)), ["epay_callback_jobs"]);
  } finally { sql.close(); }
});
