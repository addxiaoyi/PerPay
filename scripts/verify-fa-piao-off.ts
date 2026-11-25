import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { createInvoiceRuntime } from "../src/invoices/runtime.ts";
import { readFaPiaoCredentials } from "../src/invoices/fa-piao-runtime.ts";

async function verify() {
  for (const name of ["PERPAY_TAX_INVOICE_ENABLED", "PERPAY_TAX_INVOICE_AUTO_SYNC_ENABLED", "PERPAY_EPAY_INVOICE_ENABLED"])
    if ((process.env[name] ?? "false") !== "false") throw new Error("verification requires all invoice execution flags to be false");
  const file = process.env.PERPAY_TAX_INVOICE_FAPIAO_CREDENTIAL_FILE;
  if (!file || process.env.PERPAY_TAX_INVOICE_PROVIDER !== "fa-piao") throw new Error("fa-piao preparation configuration is missing");
  const config = loadConfig({ PERPAY_MASTER_KEY: "00".repeat(32), PERPAY_TAX_INVOICE_PROVIDER: "fa-piao",
    PERPAY_TAX_INVOICE_FAPIAO_CREDENTIAL_FILE: file, PERPAY_TAX_INVOICE_ENABLED: "false", PERPAY_TAX_INVOICE_AUTO_SYNC_ENABLED: "false" });
  const credentials = readFaPiaoCredentials(file);
  let requests = 0;
  const provider = createInvoiceRuntime({ database: {
    read: () => { throw new Error("offline verification must not access a database"); },
    write: () => { throw new Error("offline verification must not access a database"); },
    instanceId: () => "offline-verification",
  }, masterKey: config.masterKey, ...config.taxInvoices!, transport: async () => {
    requests++; throw new Error("offline verification must not make network requests");
  } });
  const authorization = await provider.authorize({ provider: "fa-piao", subMchId: credentials.accountId, sellerName: credentials.sellerName,
    sellerTaxId: credentials.sellerTaxId, billingPersonId: credentials.username, itemName: "configuration check", taxCode: "0".repeat(19), taxRateBps: 0 });
  assert.equal(provider.kind, "fa-piao");
  assert.equal(authorization.authorized, false);
  assert.equal(config.taxInvoices?.autoSync, false);
  assert.equal(requests, 0);
  process.stdout.write(JSON.stringify({ provider: "fa-piao", credentialsValidated: true, issuanceEnabled: false, autoSyncEnabled: false,
    networkRequests: requests, databaseAccess: false, remoteVerification: "NOT_PERFORMED" }) + "\n");
}

verify().catch(() => { process.stderr.write("fa-piao offline configuration verification failed\n"); process.exitCode = 1; });
