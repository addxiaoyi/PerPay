import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { isAbsolute } from "node:path";
import { readFaPiaoCredentials, createFaPiaoRuntime } from "../src/invoices/fa-piao-runtime.ts";
import { createFeeInvoiceService } from "../src/invoices/fee-service.ts";
import { FaPiaoError } from "../src/invoices/fa-piao-client.ts";
import { verifiedAuthorization } from "../src/invoices/model.ts";

const { values } = parseArgs({ options: { database: { type: "string" }, credentials: { type: "string" }, "check-provider": { type: "boolean", default: false } }, strict: true });
if (!values.database || !values.credentials || !isAbsolute(values.database) || !isAbsolute(values.credentials)) throw new Error("usage: --database ABSOLUTE_SQLITE_PATH --credentials ABSOLUTE_PRIVATE_JSON [--check-provider]");
const sql = new DatabaseSync(values.database, { readOnly: true });
try {
  sql.exec("PRAGMA query_only=ON");
  const database = { read: <T>(read: (sql: DatabaseSync) => T) => read(sql), write: (): never => { throw new Error("readiness inspection prohibits database writes"); } };
  const credentials = readFaPiaoCredentials(values.credentials);
  const provider = createFaPiaoRuntime({ database, credentialFile: values.credentials, allowIssue: false });
  const service = createFeeInvoiceService({ database, provider, canIssue: () => false });
  let providerCode: string | null = "NOT_CHECKED", authorized = false;
  if (values["check-provider"] && provider.platformFees && provider.checkStatus) {
    try { const state = await provider.checkStatus(provider.platformFees.profile); authorized = verifiedAuthorization(provider.platformFees.profile, state); providerCode = authorized ? null : state.reason ?? "invoice_not_authorized"; }
    catch (error) { providerCode = error instanceof FaPiaoError ? error.code : "invoice_provider_unavailable"; }
  }
  sql.exec("BEGIN");
  const merchants = sql.prepare(`SELECT b.main_merchant_id,b.main_api_id,b.epay_merchant_id FROM epay_merchant_bindings b
    JOIN epay_merchant_accounts m ON m.merchant_id=b.epay_merchant_id WHERE m.enabled=1 ORDER BY b.epay_merchant_id`).all().map(row => {
      const state = service.readiness({ merchantId: String(row.main_merchant_id), mainApiId: String(row.main_api_id), epayMerchantId: Number(row.epay_merchant_id), role: "admin", userId: "read-only-preflight" });
      return { merchantId: Number(row.epay_merchant_id), buyerReady: state.buyerReady, automaticPreference: state.buyerAutoInvoice, selfInvoice: state.selfInvoice, subscriptionActive: state.subscription.active,
        pendingFees: state.pendingCount, pendingFeeCents: state.pendingAmountCents, unverified: state.unverifiedCount };
    });
  const configurationPrepared = Boolean(credentials.sellerBankAccount && credentials.sellerAddressPhone && provider.platformFees && provider.platformFees.validUntil > Date.now());
  const readyMerchants = merchants.filter(row => row.buyerReady && row.automaticPreference && !row.selfInvoice && row.subscriptionActive).length;
  sql.exec("COMMIT");
  console.log(JSON.stringify({ configurationPrepared, providerAuthorized: authorized, providerCode, readyMerchants, merchants,
    canActivate: configurationPrepared && authorized, waitingForMerchantDetails: merchants.filter(row => !row.buyerReady || !row.automaticPreference).length,
    invoiceExecutionEnabled: false, invoiceSubmissions: 0, databaseWrites: 0 }));
} finally { sql.close(); }
