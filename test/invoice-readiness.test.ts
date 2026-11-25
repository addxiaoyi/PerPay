import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { auditInvoiceReadiness, readInvoiceReadiness } from "../scripts/audit-invoice-readiness.ts";

const NOW = 1_800_000_000_000;
const enabled = {
  PERPAY_EPAY_GATEWAY_MODE: "live", PERPAY_TAX_INVOICE_ENABLED: "true",
  PERPAY_EPAY_SHADOW_IDENTITY_ORIGIN: "http://127.0.0.1:8787",
  PERPAY_EPAY_MAIN_BRIDGE_SECRET_FILE: "/private/bridge-reference",
  PERPAY_TAX_INVOICE_WECHAT_CREDENTIAL_ID: "private-credential-reference",
  PERPAY_TAX_INVOICE_WECHAT_SIGNING_KEY_ID: "private-signing-reference",
};

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "invoice-readiness-"));
  const path = join(directory, "store.sqlite");
  const sql = new DatabaseSync(path);
  sql.exec(`CREATE TABLE schema_migrations(version INTEGER);
    INSERT INTO schema_migrations VALUES(69);
    CREATE TABLE epay_merchant_accounts(merchant_id INTEGER,enabled INTEGER);
    INSERT INTO epay_merchant_accounts VALUES(1,1);
    CREATE TABLE epay_merchant_bindings(epay_merchant_id INTEGER);
    INSERT INTO epay_merchant_bindings VALUES(1);
    CREATE TABLE epay_tax_invoice_requests(invoice_id TEXT,updated_at INTEGER,status TEXT);
    CREATE INDEX epay_tax_invoice_pending_query ON epay_tax_invoice_requests(updated_at,invoice_id)
      WHERE status IN ('UNKNOWN','PROCESSING','REVERSING');
    CREATE TABLE epay_tax_invoice_profiles(merchant_id INTEGER,sub_mch_id TEXT,seller_name TEXT,seller_tax_id TEXT,
      billing_person_id TEXT,item_name TEXT,tax_code TEXT,tax_rate_bps INTEGER,enabled INTEGER,authorized INTEGER,
      authorization_checked_at INTEGER,version INTEGER);
    INSERT INTO epay_tax_invoice_profiles VALUES(1,'1900000001','Private seller','91310000123456789A',
      'private-biller','Software service','3040201000000000000',600,1,1,${NOW - 1000},1);
    CREATE TABLE epay_wechat_credentials(credential_id TEXT,app_id TEXT,provider_merchant_id TEXT,
      valid_from INTEGER,valid_until INTEGER,created_at INTEGER);
    INSERT INTO epay_wechat_credentials VALUES('private-credential-reference','private-app','provider-1',0,${NOW + 60000},0);
    CREATE TABLE epay_wechat_credential_revocations(credential_id TEXT);
    CREATE TABLE epay_wechat_signing_keys(key_id TEXT,app_id TEXT,provider_merchant_id TEXT,
      valid_from INTEGER,valid_until INTEGER,created_at INTEGER);
    INSERT INTO epay_wechat_signing_keys VALUES('private-signing-reference','private-app','provider-1',0,${NOW + 60000},0);
    CREATE TABLE epay_wechat_signing_key_revocations(key_id TEXT);`);
  return { path, sql, close: () => { sql.close(); rmSync(directory, { recursive: true, force: true }); } };
}

it("reports local configuration without claiming remote authorization or exposing identifiers", () => {
  const test = fixture();
  try {
    const report = readInvoiceReadiness(test.path, { merchantId: 1, env: enabled, now: NOW });
    assert.equal(report.localConfigurationReady, true);
    assert.equal(report.readyToIssue, false);
    assert.equal(report.remoteVerification, "NOT_PERFORMED");
    assert.ok(report.remainingVerification.includes("TENCENT_DIGITAL_TAX_AUTHORIZATION"));
    assert.equal(report.checks.find(check => check.code === "PROFILE_CONFIGURED")?.ok, true);
    assert.doesNotMatch(JSON.stringify(report), /Private seller|private-|91310000123456789A|1900000001|provider-1/);
  } finally { test.close(); }
});

it("requires the signed identity bridge and enabled automatic synchronization", () => {
  const test = fixture();
  try {
    const inspect = (env: NodeJS.ProcessEnv) => auditInvoiceReadiness(test.sql, { merchantId: 1, env, now: NOW });
    assert.equal(inspect(enabled).checks.find(check => check.code === "AUTO_QUERY_ENABLED")?.ok, true);
    assert.equal(inspect({ ...enabled, PERPAY_TAX_INVOICE_AUTO_SYNC_ENABLED: "true" }).localConfigurationReady, true);
    for (const value of ["false", "invalid", "", "TRUE"])
      assert.equal(inspect({ ...enabled, PERPAY_TAX_INVOICE_AUTO_SYNC_ENABLED: value }).localConfigurationReady, false);
    for (const origin of ["", "https://127.0.0.1:8787", "http://localhost:8787", "http://remote.example.test", "http://127.0.0.1/path", "http://user@127.0.0.1", "http://127.0.0.1/?token=secret", "http://127.0.0.1/#hash"])
      assert.equal(inspect({ ...enabled, PERPAY_EPAY_SHADOW_IDENTITY_ORIGIN: origin }).checks.find(check => check.code === "IDENTITY_BRIDGE_CONFIGURED")?.ok, false, origin);
    assert.equal(inspect({ ...enabled, PERPAY_EPAY_SHADOW_IDENTITY_ORIGIN: "http://[::1]:8787/" }).localConfigurationReady, true);
    assert.equal(inspect({ ...enabled, PERPAY_EPAY_SHADOW_IDENTITY_ORIGIN: undefined }).localConfigurationReady, false);
    assert.equal(inspect({ ...enabled, PERPAY_EPAY_MAIN_BRIDGE_SECRET_FILE: undefined }).localConfigurationReady, false);
    assert.equal(inspect({ ...enabled, PERPAY_EPAY_MAIN_BRIDGE_SECRET_FILE: "   " }).localConfigurationReady, false);
    assert.equal(inspect({ ...enabled, PERPAY_EPAY_MAIN_BRIDGE_SECRET_FILE: "/path/not-read-by-audit" }).localConfigurationReady, true);
  } finally { test.close(); }
});

it("rejects missing invoice request tables and a missing or non-partial query index", () => {
  const test = fixture();
  try {
    const inspect = () => auditInvoiceReadiness(test.sql, { merchantId: 1, env: enabled, now: NOW });
    test.sql.exec("DROP INDEX epay_tax_invoice_pending_query");
    assert.equal(inspect().localConfigurationReady, false);
    assert.equal(inspect().checks.find(check => check.code === "AUTO_QUERY_INDEX_AVAILABLE")?.ok, false);
    test.sql.exec("CREATE INDEX epay_tax_invoice_pending_query ON epay_tax_invoice_requests(updated_at,invoice_id)");
    assert.equal(inspect().checks.find(check => check.code === "AUTO_QUERY_INDEX_AVAILABLE")?.ok, false);
    test.sql.exec("DROP INDEX epay_tax_invoice_pending_query; CREATE INDEX epay_tax_invoice_pending_query ON epay_tax_invoice_requests(updated_at,invoice_id) WHERE status IN ('unknown','processing','reversing')");
    assert.equal(inspect().checks.find(check => check.code === "AUTO_QUERY_INDEX_AVAILABLE")?.ok, false);
    test.sql.exec("DROP TABLE epay_tax_invoice_requests");
    assert.equal(inspect().checks.find(check => check.code === "INVOICE_SCHEMA_AVAILABLE")?.ok, false);
  } finally { test.close(); }
});

it("keeps disabled, revoked, mismatched and expired credentials out of the ready state", () => {
  const test = fixture();
  try {
    const inspect = (env: NodeJS.ProcessEnv = enabled) => auditInvoiceReadiness(test.sql, { merchantId: 1, env, now: NOW });
    assert.equal(inspect({ ...enabled, PERPAY_TAX_INVOICE_ENABLED: "false" }).localConfigurationReady, false);
    test.sql.exec("UPDATE epay_wechat_signing_keys SET provider_merchant_id='other-provider'");
    assert.equal(inspect().checks.find(check => check.code === "SIGNING_KEY_ACTIVE_AND_MATCHED")?.ok, false);
    test.sql.exec("UPDATE epay_wechat_signing_keys SET provider_merchant_id='provider-1'");
    test.sql.exec("INSERT INTO epay_wechat_credential_revocations VALUES('private-credential-reference')");
    assert.equal(inspect().checks.find(check => check.code === "CREDENTIAL_ACTIVE")?.ok, false);
    test.sql.exec("DELETE FROM epay_wechat_credential_revocations");
    test.sql.prepare("UPDATE epay_wechat_credentials SET valid_until=?").run(NOW);
    assert.equal(inspect().checks.find(check => check.code === "CREDENTIAL_ACTIVE")?.ok, false);
  } finally { test.close(); }
});

it("detects unconfigured or disabled merchant profiles and missing business fields", () => {
  const test = fixture();
  try {
    test.sql.exec("UPDATE epay_tax_invoice_profiles SET tax_code='not-classified',enabled=0,authorized=0");
    const report = auditInvoiceReadiness(test.sql, { merchantId: 1, env: enabled, now: NOW });
    assert.equal(report.localConfigurationReady, false);
    assert.equal(report.checks.find(check => check.code === "PROFILE_CONFIGURED")?.ok, false);
    assert.equal(report.checks.find(check => check.code === "MERCHANT_ENABLED_AND_AUTHORIZED")?.ok, false);
    const unknown = auditInvoiceReadiness(test.sql, { merchantId: 2, env: enabled, now: NOW });
    assert.equal(unknown.checks.find(check => check.code === "MERCHANT_BOUND_AND_ENABLED")?.ok, false);
  } finally { test.close(); }
});

it("does not migrate legacy stores or create a missing database", () => {
  const directory = mkdtempSync(join(tmpdir(), "invoice-readiness-old-"));
  const path = join(directory, "old.sqlite");
  const sql = new DatabaseSync(path);
  try {
    sql.exec("CREATE TABLE schema_migrations(version INTEGER); INSERT INTO schema_migrations VALUES(68)");
    const before = sql.prepare("SELECT name FROM sqlite_master ORDER BY name").all();
    const report = readInvoiceReadiness(path, { merchantId: 1, env: enabled, now: NOW });
    assert.equal(report.localConfigurationReady, false);
    assert.equal(report.schemaVersion, 68);
    assert.deepEqual(sql.prepare("SELECT name FROM sqlite_master ORDER BY name").all(), before);
    const missing = join(directory, "missing.sqlite");
    assert.throws(() => readInvoiceReadiness(missing, { merchantId: 1, env: enabled, now: NOW }));
    assert.equal(existsSync(missing), false);
  } finally { sql.close(); rmSync(directory, { recursive: true, force: true }); }
});

it("rejects invalid scope and produces a safe CLI failure without echoing paths or credentials", () => {
  const test = fixture();
  try {
    assert.throws(() => auditInvoiceReadiness(test.sql, { merchantId: 0, env: enabled, now: NOW }), /invalid merchant/);
    assert.throws(() => auditInvoiceReadiness(test.sql, { merchantId: 1, env: enabled, now: -1 }), /invalid clock/);
    let failure: unknown;
    try { execFileSync(process.execPath, ["--experimental-strip-types", "scripts/audit-invoice-readiness.ts", "--database", "private-missing-path", "--merchant-id", "1"], { encoding: "utf8", env: enabled, stdio: "pipe" }); }
    catch (error) { failure = error; }
    const output = failure as { status: number; stderr: string; stdout: string };
    assert.equal(output.status, 1);
    assert.match(output.stderr, /invoice readiness audit failed/);
    assert.doesNotMatch(output.stderr + output.stdout, /private-missing-path|private-credential|private-signing/);
  } finally { test.close(); }
});
