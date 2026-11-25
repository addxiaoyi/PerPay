import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it, type TestContext } from "node:test";
import { runInvoiceAutomation } from "../scripts/check-invoice-automation.ts";

const conflict = /invoice report output conflicts with a protected input/;

function invoiceFiles(test: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "invoice-report-output-"));
  test.after(() => rmSync(directory, { recursive: true, force: true }));
  const inputs = join(directory, "inputs");
  mkdirSync(inputs);
  const database = join(inputs, "invoice.sqlite"), credentialFile = join(inputs, "credentials.json");
  // Invalid input contents prove collisions fail before either input is opened for the audit.
  writeFileSync(database, "synthetic database sentinel");
  writeFileSync(credentialFile, "synthetic credential sentinel", { mode: 0o600 });
  const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const before = [digest(database), digest(credentialFile)];
  const audit = (output: string) => runInvoiceAutomation([
    "--database", database, "--credential-file", credentialFile, "--output", output, "--remote",
  ]);
  const unchanged = () => assert.deepEqual([digest(database), digest(credentialFile)], before);
  return { directory, inputs, database, credentialFile, audit, unchanged };
}

for (const protectedInput of ["database", "credentialFile"] as const) {
  it(`rejects the ${protectedInput} as report output before inspecting its contents`, async test => {
    const files = invoiceFiles(test);
    await assert.rejects(files.audit(files[protectedInput]), conflict);
    files.unchanged();
  });

  it(`rejects a normalized ${protectedInput} output alias`, async test => {
    const files = invoiceFiles(test);
    const output = `${files.inputs}${sep}unused${sep}..${sep}${basename(files[protectedInput])}`;
    await assert.rejects(files.audit(output), conflict);
    files.unchanged();
  });

  it(`rejects an existing hard link to the ${protectedInput}`, async test => {
    const files = invoiceFiles(test), output = join(files.directory, "report.json");
    linkSync(files[protectedInput], output);
    await assert.rejects(files.audit(output), conflict);
    files.unchanged();
  });

  it(`rejects a symbolic directory alias to the ${protectedInput}`, async test => {
    const files = invoiceFiles(test), alias = join(files.directory, "input-alias");
    symlinkSync(files.inputs, alias, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(files.audit(join(alias, basename(files[protectedInput]))), conflict);
    files.unchanged();
  });
}

it("rejects an output collision even when the database does not exist", async test => {
  const files = invoiceFiles(test), missing = join(files.directory, "missing.sqlite");
  await assert.rejects(runInvoiceAutomation([
    "--database", missing, "--credential-file", files.credentialFile, "--output", missing,
  ]), conflict);
  assert.equal(existsSync(missing), false);
  files.unchanged();
});

it("treats differently cased Windows paths as the same output", { skip: process.platform !== "win32" }, async test => {
  const files = invoiceFiles(test);
  await assert.rejects(files.audit(files.database.toUpperCase()), conflict);
  files.unchanged();
});

it("writes a separate report without contacting the provider or changing its inputs", async test => {
  const files = invoiceFiles(test), output = join(files.directory, "reports", "readiness.json");
  rmSync(files.database);
  const sql = new DatabaseSync(files.database);
  sql.exec(`CREATE TABLE epay_tax_invoice_profiles (provider TEXT, merchant_id INTEGER, enabled INTEGER, authorized INTEGER, tax_rate_bps INTEGER);
    CREATE TABLE epay_merchant_accounts (merchant_id INTEGER, enabled INTEGER);
    CREATE TABLE epay_merchant_bindings (epay_merchant_id INTEGER);`);
  sql.close();
  writeFileSync(files.credentialFile, JSON.stringify({
    appKey: "synthetic-key", appSecret: "s".repeat(32), accountId: "1000", sellerTaxId: "91310000123456789A",
    sellerName: "Synthetic seller", username: "13900000000", plan: "6",
  }), { mode: 0o600 });
  const databaseBefore = readFileSync(files.database), credentialsBefore = readFileSync(files.credentialFile);
  let requests = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { requests++; throw new Error("offline audit must not contact the provider"); };
  try {
    const report = await runInvoiceAutomation([
      "--database", files.database, "--credential-file", files.credentialFile, "--output", output,
    ], {});
    assert.equal(requests, 0);
    assert.equal(report.remoteVerification, "NOT_PERFORMED");
    assert.equal(report.canActivate, false);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), report);
    assert.deepEqual(readFileSync(files.database), databaseBefore);
    assert.deepEqual(readFileSync(files.credentialFile), credentialsBefore);
  } finally { globalThis.fetch = previousFetch; }
});

for (const suffix of ["-wal", "-shm", "-journal"]) {
  it(`protects the SQLite ${suffix} sidecar even when it does not exist yet`, async test => {
    const files = invoiceFiles(test), sidecar = files.database + suffix;
    await assert.rejects(files.audit(sidecar), conflict);
    assert.equal(existsSync(sidecar), false);
    files.unchanged();
  });

  it(`protects a missing SQLite ${suffix} through a symbolic parent alias`, async test => {
    const files = invoiceFiles(test), alias = join(files.directory, "sidecar-alias");
    symlinkSync(files.inputs, alias, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(files.audit(join(alias, basename(files.database) + suffix)), conflict);
    assert.equal(existsSync(files.database + suffix), false);
    files.unchanged();
  });

  it(`protects existing SQLite ${suffix} bytes and hard-link aliases`, async test => {
    const files = invoiceFiles(test), sidecar = files.database + suffix, alias = join(files.directory, "report.json");
    writeFileSync(sidecar, "synthetic active SQLite sidecar");
    linkSync(sidecar, alias);
    await assert.rejects(files.audit(sidecar), conflict);
    await assert.rejects(files.audit(alias), conflict);
    assert.equal(readFileSync(sidecar, "utf8"), "synthetic active SQLite sidecar");
    files.unchanged();
  });
}

it("counts only enabled, authorized, positive-tax seller profiles as activation candidates", async test => {
  const files = invoiceFiles(test);
  rmSync(files.database);
  const sql = new DatabaseSync(files.database);
  sql.exec(`CREATE TABLE epay_tax_invoice_profiles (provider TEXT,merchant_id INTEGER,version INTEGER,
    sub_mch_id TEXT,seller_name TEXT,seller_tax_id TEXT,billing_person_id TEXT,item_name TEXT,tax_code TEXT,
    tax_rate_bps INTEGER,enabled INTEGER,authorized INTEGER);
    CREATE TABLE epay_merchant_accounts (merchant_id INTEGER,enabled INTEGER);
    CREATE TABLE epay_merchant_bindings (epay_merchant_id INTEGER);
    INSERT INTO epay_merchant_accounts VALUES(1,1);
    INSERT INTO epay_merchant_bindings VALUES(1);`);
  const insert = sql.prepare("INSERT INTO epay_tax_invoice_profiles VALUES('fa-piao',1,1,'1000','Synthetic seller','91310000123456789A','13900000000','Item','1234567890123456789',?,?,?)");
  for (const row of [[300, 0, 1], [300, 1, 0], [0, 1, 1], [300, 1, 1]]) insert.run(...row);
  sql.close();
  writeFileSync(files.credentialFile, JSON.stringify({
    appKey: "synthetic-key", appSecret: "s".repeat(32), accountId: "1000", sellerTaxId: "91310000123456789A",
    sellerName: "Synthetic seller", username: "13900000000", plan: "6",
  }), { mode: 0o600 });
  const before = readFileSync(files.database);
  const report = await runInvoiceAutomation(["--database", files.database, "--credential-file", files.credentialFile], {});
  assert.equal(report.eligibleProfiles, 1);
  assert.deepEqual(readFileSync(files.database), before);
});

it("invalidates an earlier healthy report immediately when credentials cannot be read", async test => {
  const files = invoiceFiles(test), output = join(files.directory, "readiness.json");
  writeFileSync(output, JSON.stringify({ healthy: true, canActivate: true }));
  await assert.rejects(files.audit(output));
  const report = JSON.parse(readFileSync(output, "utf8")) as Record<string, unknown>;
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.healthy, false);
  assert.equal(report.canActivate, false);
  assert.equal(report.remoteVerification, "NOT_PERFORMED");
  assert.deepEqual(report.blockers, ["INVOICE_AUDIT_UNAVAILABLE"]);
  assert.equal(report.invoiceSubmissions, 0);
  assert.equal(report.databaseWrites, 0);
  assert.ok(Number.isFinite(Date.parse(String(report.checkedAt))));
  files.unchanged();
});
