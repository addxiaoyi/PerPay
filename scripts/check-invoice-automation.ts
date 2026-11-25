import { lstatSync, statSync, realpathSync, mkdirSync, openSync, closeSync, fsyncSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { checkInvoiceAutomation, type InvoiceAutomationReport } from "../src/invoices/automation-readiness.ts";
import { readFaPiaoCredentials } from "../src/invoices/fa-piao-runtime.ts";
import { invoiceProfileInput } from "../src/invoices/model.ts";

export function invoiceAutomationArguments(args: string[]) {
  const flags = new Map<string, string>();
  let remote = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === "--remote" && !remote) { remote = true; continue; }
    if (!["--database", "--credential-file", "--output"].includes(flag) || flags.has(flag)) throw new Error("invalid invoice audit arguments");
    const value = args[++index];
    if (!value || value.startsWith("--") || !isAbsolute(value)) throw new Error("invoice audit paths must be absolute");
    flags.set(flag, value);
  }
  const database = flags.get("--database"), credentialFile = flags.get("--credential-file");
  if (!database || !credentialFile) throw new Error("database and credential file are required");
  return { database, credentialFile, output: flags.get("--output"), remote };
}

function saveReport(path: string, report: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("unsafe invoice report destination");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(report) + "\n"); fsyncSync(fd); }
  finally { closeSync(fd); }
  try { renameSync(temporary, path); }
  catch (error) { unlinkSync(temporary); throw error; }
}

function reportFileIdentity(path: string) {
  const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  try {
    const stat = statSync(path, { bigint: true });
    return { path: normalize(realpathSync(path)), device: stat.dev, inode: stat.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    let ancestor = resolve(path);
    const missing: string[] = [];
    for (;;) {
      try { return { path: normalize(join(realpathSync(ancestor), ...missing)), device: undefined, inode: undefined }; }
      catch (ancestorError) {
        if ((ancestorError as NodeJS.ErrnoException).code !== "ENOENT") throw ancestorError;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw ancestorError;
        missing.unshift(basename(ancestor));
        ancestor = parent;
      }
    }
  }
}

function assertReportOutput(options: ReturnType<typeof invoiceAutomationArguments>) {
  if (!options.output) return;
  const output = reportFileIdentity(options.output);
  const protectedPaths = [options.database, ...["-wal", "-shm", "-journal"].map(suffix => options.database + suffix), options.credentialFile];
  for (const path of protectedPaths) {
    const input = reportFileIdentity(path);
    const sameFile = output.inode !== undefined && output.device === input.device && output.inode === input.inode;
    if (output.path === input.path || sameFile) throw new Error("invoice report output conflicts with a protected input");
  }
}

async function inspectInvoiceAutomation(options: ReturnType<typeof invoiceAutomationArguments>, env: NodeJS.ProcessEnv) {
  const credentials = readFaPiaoCredentials(options.credentialFile);
  const sql = new DatabaseSync(options.database, { readOnly: true });
  let eligibleProfiles = 0;
  try {
    sql.exec("PRAGMA query_only=ON; BEGIN");
    const rows = sql.prepare(`SELECT p.* FROM epay_tax_invoice_profiles p
      JOIN epay_merchant_accounts m ON m.merchant_id=p.merchant_id AND m.enabled=1
      JOIN epay_merchant_bindings b ON b.epay_merchant_id=m.merchant_id
      WHERE p.provider='fa-piao' AND p.enabled=1 AND p.authorized=1 AND p.tax_rate_bps>0`).all();
    eligibleProfiles = rows.filter(row => invoiceProfileInput.safeParse({ expectedVersion: Number(row.version),
      provider: row.provider, subMchId: row.sub_mch_id, sellerName: row.seller_name, sellerTaxId: row.seller_tax_id,
      billingPersonId: row.billing_person_id, itemName: row.item_name, taxCode: row.tax_code,
      taxRateBps: Number(row.tax_rate_bps), enabled: Boolean(row.enabled),
    }).success && row.sub_mch_id === credentials.accountId && row.seller_tax_id === credentials.sellerTaxId
      && row.seller_name === credentials.sellerName && row.billing_person_id === credentials.username).length;
  } finally { try { if (sql.isTransaction) sql.exec("ROLLBACK"); } finally { sql.close(); } }
  const report = await checkInvoiceAutomation({ credentials, eligibleProfiles, remote: options.remote,
    issuanceEnabled: env.PERPAY_TAX_INVOICE_ENABLED === "true",
    automaticQueryEnabled: env.PERPAY_TAX_INVOICE_AUTO_SYNC_ENABLED === "true" });
  if (options.output) { assertReportOutput(options); saveReport(options.output, report); }
  return report;
}

export async function runInvoiceAutomation(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const options = invoiceAutomationArguments(args);
  assertReportOutput(options);
  try { return await inspectInvoiceAutomation(options, env); }
  catch (error) {
    if (options.output) {
      assertReportOutput(options);
      // A failed new probe invalidates an earlier green result immediately, rather than 90 minutes later.
      const unavailable: InvoiceAutomationReport = {
        schemaVersion: 1, checkedAt: new Date().toISOString(), healthy: false, canActivate: false,
        remoteVerification: "NOT_PERFORMED", eligibleProfiles: 0,
        issuanceEnabled: env.PERPAY_TAX_INVOICE_ENABLED === "true",
        automaticQueryEnabled: env.PERPAY_TAX_INVOICE_AUTO_SYNC_ENABLED === "true",
        blockers: ["INVOICE_AUDIT_UNAVAILABLE"], activationRequirements: [], invoiceSubmissions: 0, databaseWrites: 0,
      };
      saveReport(options.output, unavailable);
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = await runInvoiceAutomation(process.argv.slice(2));
    console.log(JSON.stringify(report));
    process.exitCode = report.healthy ? 0 : 2;
  } catch {
    console.error(JSON.stringify({ ok: false, error: "invoice_audit_unavailable", invoiceSubmissions: 0, databaseWrites: 0 }));
    process.exitCode = 1;
  }
}
