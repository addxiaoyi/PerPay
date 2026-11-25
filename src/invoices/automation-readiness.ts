import { createFaPiaoClient, FaPiaoError, providerError, type FaPiaoCredentials } from "./fa-piao-client.ts";

export type InvoiceAutomationReport = {
  schemaVersion: 1;
  checkedAt: string;
  healthy: boolean;
  canActivate: boolean;
  remoteVerification: "PASSED" | "FAILED" | "NOT_PERFORMED";
  eligibleProfiles: number;
  issuanceEnabled: boolean;
  automaticQueryEnabled: boolean;
  blockers: string[];
  activationRequirements: string[];
  invoiceSubmissions: 0;
  databaseWrites: 0;
};

export async function checkInvoiceAutomation(options: {
  credentials: FaPiaoCredentials;
  eligibleProfiles: number;
  issuanceEnabled: boolean;
  automaticQueryEnabled: boolean;
  remote: boolean;
  transport?: typeof fetch;
  clock?: () => number;
}): Promise<InvoiceAutomationReport> {
  const now = (options.clock ?? Date.now)();
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) throw new Error("invalid invoice audit clock");
  if (!Number.isSafeInteger(options.eligibleProfiles) || options.eligibleProfiles < 0) throw new Error("invalid invoice profile count");
  const blockers: string[] = [];
  if (!options.credentials.sellerAddressPhone || !options.credentials.sellerBankAccount) blockers.push("SELLER_DETAILS_INCOMPLETE");
  let remoteVerification: InvoiceAutomationReport["remoteVerification"] = "NOT_PERFORMED";
  if (options.remote) {
    try {
      // The diagnostic client cannot issue invoices even when production issuance is enabled.
      const client = createFaPiaoClient({ credentials: options.credentials, allowIssue: false,
        ...(options.transport ? { transport: options.transport } : {}), clock: () => now });
      const reply = await client.checkLogin(undefined, true);
      remoteVerification = reply.code === 200 ? "PASSED" : "FAILED";
      if (reply.code !== 200) blockers.push(providerError(reply.code, reply.fields));
    } catch (error) {
      remoteVerification = "FAILED";
      blockers.push(error instanceof FaPiaoError ? error.code : "INVOICE_PROBE_UNAVAILABLE");
    }
  } else blockers.push("REMOTE_VERIFICATION_REQUIRED");
  const activationRequirements: string[] = [];
  if (options.eligibleProfiles === 0) activationRequirements.push("MERCHANT_PROFILE_REVIEW_REQUIRED");
  if (!options.issuanceEnabled) activationRequirements.push("ISSUANCE_SWITCH_CLOSED");
  if (!options.automaticQueryEnabled) activationRequirements.push("AUTOMATIC_QUERY_SWITCH_CLOSED");
  const healthy = blockers.length === 0 && remoteVerification === "PASSED";
  return {
    schemaVersion: 1, checkedAt: new Date(now).toISOString(), healthy,
    canActivate: healthy && options.eligibleProfiles > 0, remoteVerification,
    eligibleProfiles: options.eligibleProfiles, issuanceEnabled: options.issuanceEnabled,
    automaticQueryEnabled: options.automaticQueryEnabled, blockers, activationRequirements,
    invoiceSubmissions: 0, databaseWrites: 0,
  };
}
