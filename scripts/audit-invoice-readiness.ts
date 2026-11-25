import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { invoiceProfileInput } from "../src/invoices/model.ts";

const MIN_INVOICE_SCHEMA = 69;
const referencePattern = /^[A-Za-z0-9_-]{1,64}$/;
const invoiceTables = ["epay_tax_invoice_profiles", "epay_tax_invoice_requests", "epay_merchant_accounts", "epay_merchant_bindings",
  "epay_wechat_credentials", "epay_wechat_credential_revocations", "epay_wechat_signing_keys", "epay_wechat_signing_key_revocations"] as const;

type AuditOptions = { merchantId: number; env: NodeJS.ProcessEnv; now?: number };
type ReadinessCheck = { code: string; ok: boolean };

function identityBridgeConfigured(env: NodeJS.ProcessEnv): boolean {
  const secretFile = env.PERPAY_EPAY_MAIN_BRIDGE_SECRET_FILE ?? "";
  if (!secretFile.trim() || /[\x00-\x1f\x7f]/.test(secretFile)) return false;
  try {
    const origin = new URL(env.PERPAY_EPAY_SHADOW_IDENTITY_ORIGIN ?? "");
    return origin.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(origin.hostname)
      && origin.pathname === "/" && !origin.username && !origin.password && !origin.search && !origin.hash;
  } catch { return false; }
}

function pendingQueryIndexAvailable(sql: DatabaseSync): boolean {
  const index = sql.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='epay_tax_invoice_pending_query' AND tbl_name='epay_tax_invoice_requests'").get();
  if (!index || typeof index.sql !== "string") return false;
  const columns = sql.prepare("PRAGMA index_info(epay_tax_invoice_pending_query)").all();
  return columns.length === 2 && columns[0]?.name === "updated_at" && columns[1]?.name === "invoice_id"
    && /\bWHERE\s+status\s+IN\s*\(\s*'UNKNOWN'\s*,\s*'PROCESSING'\s*,\s*'REVERSING'\s*\)\s*;?\s*$/.test(index.sql);
}

export type InvoiceReadiness = {
  readOnly: true;
  merchantId: number;
  checkedAt: string;
  schemaVersion: number;
  localConfigurationReady: boolean;
  readyToIssue: false;
  remoteVerification: "NOT_PERFORMED";
  checks: ReadinessCheck[];
  remainingVerification: readonly string[];
};

/** Inspect metadata only; this audit neither decrypts keys nor calls an invoice provider. */
export function auditInvoiceReadiness(sql: DatabaseSync, options: AuditOptions): InvoiceReadiness {
  if (!Number.isSafeInteger(options.merchantId) || options.merchantId < 1) throw new Error("invalid merchant scope");
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) throw new Error("invalid clock");
  const tables = new Set(sql.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)));
  const schemaVersion = tables.has("schema_migrations")
    ? Number(sql.prepare("SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations").get()?.version) : 0;
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 0) throw new Error("invalid schema metadata");
  const checks: ReadinessCheck[] = [];
  const check = (code: string, ok: boolean) => { checks.push({ code, ok }); };
  const finish = (): InvoiceReadiness => ({
    readOnly: true, merchantId: options.merchantId, checkedAt: new Date(now).toISOString(), schemaVersion,
    localConfigurationReady: checks.every(item => item.ok), readyToIssue: false, remoteVerification: "NOT_PERFORMED", checks,
    remainingVerification: ["DEPLOYED_RUNTIME_AND_KEY_DECRYPTION", "TENCENT_DIGITAL_TAX_AUTHORIZATION",
      "TAX_INVOICE_TYPE_AND_AVAILABLE_QUOTA", "BILLING_PERSON_AND_CARD_TEMPLATE", "ACTUAL_SALE_AND_BUYER_DETAILS"],
  });
  const schemaReady = schemaVersion >= MIN_INVOICE_SCHEMA && invoiceTables.every(table => tables.has(table));
  check("INVOICE_SCHEMA_AVAILABLE", schemaReady);
  check("AUTO_QUERY_INDEX_AVAILABLE", pendingQueryIndexAvailable(sql));
  check("GATEWAY_LIVE", options.env.PERPAY_EPAY_GATEWAY_MODE === "live");
  check("INVOICE_RUNTIME_ENABLED", options.env.PERPAY_TAX_INVOICE_ENABLED === "true");
  check("AUTO_QUERY_ENABLED", options.env.PERPAY_TAX_INVOICE_AUTO_SYNC_ENABLED === undefined
    || options.env.PERPAY_TAX_INVOICE_AUTO_SYNC_ENABLED === "true");
  check("IDENTITY_BRIDGE_CONFIGURED", identityBridgeConfigured(options.env));
  const credentialId = options.env.PERPAY_TAX_INVOICE_WECHAT_CREDENTIAL_ID ?? "";
  const signingKeyId = options.env.PERPAY_TAX_INVOICE_WECHAT_SIGNING_KEY_ID ?? "";
  check("CREDENTIAL_REFERENCE_CONFIGURED", referencePattern.test(credentialId));
  check("SIGNING_KEY_REFERENCE_CONFIGURED", referencePattern.test(signingKeyId));
  if (!schemaReady) return finish();

  const merchant = sql.prepare(`SELECT 1 FROM epay_merchant_accounts m JOIN epay_merchant_bindings b
    ON b.epay_merchant_id=m.merchant_id WHERE m.merchant_id=? AND m.enabled=1`).get(options.merchantId);
  check("MERCHANT_BOUND_AND_ENABLED", Boolean(merchant));
  const profile = sql.prepare(`SELECT sub_mch_id,seller_name,seller_tax_id,billing_person_id,item_name,tax_code,
    tax_rate_bps,enabled,authorized,authorization_checked_at,version FROM epay_tax_invoice_profiles WHERE merchant_id=?`).get(options.merchantId);
  const validProfile = profile && invoiceProfileInput.safeParse({
    expectedVersion: Number(profile.version), subMchId: profile.sub_mch_id, sellerName: profile.seller_name,
    sellerTaxId: profile.seller_tax_id, billingPersonId: profile.billing_person_id, itemName: profile.item_name,
    taxCode: profile.tax_code, taxRateBps: Number(profile.tax_rate_bps), enabled: true,
  }).success;
  check("PROFILE_CONFIGURED", Boolean(validProfile));
  const checkedAt = Number(profile?.authorization_checked_at);
  check("MERCHANT_ENABLED_AND_AUTHORIZED", Boolean(profile && Number(profile.enabled) === 1 && Number(profile.authorized) === 1
    && Number.isSafeInteger(checkedAt) && checkedAt > 0 && checkedAt <= now));

  // Select only validity and identity metadata; encrypted key material never enters this process.
  const credential = referencePattern.test(credentialId) ? sql.prepare(`SELECT c.app_id,c.provider_merchant_id
    FROM epay_wechat_credentials c LEFT JOIN epay_wechat_credential_revocations r ON r.credential_id=c.credential_id
    WHERE c.credential_id=? AND c.valid_from<=? AND c.valid_until>? AND c.created_at<=? AND r.credential_id IS NULL`)
    .get(credentialId, now, now, now) : undefined;
  check("CREDENTIAL_ACTIVE", Boolean(credential));
  const signingKey = credential && referencePattern.test(signingKeyId) ? sql.prepare(`SELECT 1
    FROM epay_wechat_signing_keys k LEFT JOIN epay_wechat_signing_key_revocations r ON r.key_id=k.key_id
    WHERE k.key_id=? AND k.app_id=? AND k.provider_merchant_id=? AND k.valid_from<=? AND k.valid_until>?
      AND k.created_at<=? AND r.key_id IS NULL`).get(signingKeyId, credential.app_id!, credential.provider_merchant_id!, now, now, now) : undefined;
  check("SIGNING_KEY_ACTIVE_AND_MATCHED", Boolean(signingKey));
  return finish();
}

export function readInvoiceReadiness(path: string, options: AuditOptions): InvoiceReadiness {
  const sql = new DatabaseSync(path, { readOnly: true });
  try {
    sql.exec("PRAGMA query_only=ON; BEGIN");
    return auditInvoiceReadiness(sql, options);
  } finally {
    try { if (sql.isTransaction) sql.exec("ROLLBACK"); }
    finally { sql.close(); }
  }
}

function cliArguments(args: string[]): { database: string; merchantId: number } {
  if (args.length !== 4) throw new Error("expected --database PATH --merchant-id ID");
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!, value = args[index + 1]!;
    if (!["--database", "--merchant-id"].includes(flag) || !value || flags.has(flag)) throw new Error("invalid audit arguments");
    flags.set(flag, value);
  }
  const merchantId = flags.get("--merchant-id") ?? "";
  if (!/^[1-9]\d{0,15}$/.test(merchantId)) throw new Error("invalid merchant scope");
  const database = flags.get("--database");
  if (!database) throw new Error("database path is required");
  return { database, merchantId: Number(merchantId) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = cliArguments(process.argv.slice(2));
    const report = readInvoiceReadiness(args.database, { merchantId: args.merchantId, env: process.env });
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.localConfigurationReady ? 0 : 2;
  } catch {
    console.error("invoice readiness audit failed; check database access, schema and command arguments");
    process.exitCode = 1;
  }
}
