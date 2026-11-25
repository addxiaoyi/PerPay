import assert from "node:assert/strict";
import { it } from "node:test";
import { checkInvoiceAutomation } from "../src/invoices/automation-readiness.ts";
import { invoiceAutomationArguments } from "../scripts/check-invoice-automation.ts";
import type { FaPiaoCredentials } from "../src/invoices/fa-piao-client.ts";

const credentials: FaPiaoCredentials = { appKey: "sample-key", appSecret: "s".repeat(32), accountId: "1000",
  sellerTaxId: "91310000123456789A", sellerName: "Synthetic seller", username: "13900000000", plan: "6",
  sellerAddressPhone: "Synthetic address", sellerBankAccount: "Synthetic bank" };
const options = { credentials, eligibleProfiles: 1, issuanceEnabled: false, automaticQueryEnabled: false, remote: true };

function provider(code = 200, message = "") {
  const paths: string[] = [];
  const transport: typeof fetch = async input => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    if (path.endsWith("/authorization")) return Response.json({ code, msg: message, data: code === 200 ? { token: "synthetic-token" } : {} });
    if (path.endsWith("/queryFaceAuthState")) return Response.json({ code: 200, data: {} });
    throw new Error("diagnostics must never submit an invoice");
  };
  return { transport, paths };
}

it("checks authorization with issuance disabled and never submits invoices or writes the database", async () => {
  const remote = provider();
  const report = await checkInvoiceAutomation({ ...options, transport: remote.transport });
  assert.equal(report.healthy, true);
  assert.equal(report.canActivate, true);
  assert.equal(report.issuanceEnabled, false);
  assert.deepEqual(report.activationRequirements, ["ISSUANCE_SWITCH_CLOSED", "AUTOMATIC_QUERY_SWITCH_CLOSED"]);
  assert.deepEqual(remote.paths, ["/v5/enterprise/authorization", "/v5/enterprise/queryFaceAuthState"]);
  assert.equal(report.invoiceSubmissions, 0);
  assert.equal(report.databaseWrites, 0);
  assert.equal(JSON.stringify(report).includes(credentials.appSecret), false);
});

for (const [code, message, expected] of [[3002, "", "fapiao_service_expired"], [420, "", "fapiao_sms_required"],
  [430, "", "fapiao_face_required"], [401, "", "fapiao_authorization_expired"], [400, "服务已到期", "fapiao_service_expired"]] as const) {
  it(`reports ${expected} without exposing provider responses`, async () => {
    const remote = provider(code, message);
    const report = await checkInvoiceAutomation({ ...options, transport: remote.transport });
    assert.equal(report.healthy, false);
    assert.equal(report.canActivate, false);
    assert.deepEqual(report.blockers, [expected]);
    assert.equal(remote.paths.length, 1);
  });
}

it("does not treat an offline preflight as production readiness", async () => {
  const remote = provider();
  const report = await checkInvoiceAutomation({ ...options, remote: false, transport: remote.transport });
  assert.equal(report.remoteVerification, "NOT_PERFORMED");
  assert.equal(report.canActivate, false);
  assert.deepEqual(remote.paths, []);
});

it("keeps incomplete seller details and missing merchant profiles visible", async () => {
  const remote = provider();
  const report = await checkInvoiceAutomation({ ...options, credentials: { ...credentials, sellerAddressPhone: undefined },
    eligibleProfiles: 0, transport: remote.transport });
  assert.equal(report.canActivate, false);
  assert.deepEqual(report.blockers, ["SELLER_DETAILS_INCOMPLETE"]);
  assert.equal(report.activationRequirements.includes("MERCHANT_PROFILE_REVIEW_REQUIRED"), true);
});

it("reports bounded transport failure as unavailable without leaking exception text", async () => {
  const report = await checkInvoiceAutomation({ ...options, transport: async () => { throw new Error(credentials.appSecret); } });
  assert.deepEqual(report.blockers, ["response_unavailable"]);
  assert.equal(JSON.stringify(report).includes(credentials.appSecret), false);
});

it("rejects ambiguous command flags and invalid clocks", async () => {
  assert.throws(() => invoiceAutomationArguments(["--database", "relative", "--credential-file", "/private/key"]));
  assert.throws(() => invoiceAutomationArguments(["--remote", "--remote"]));
  await assert.rejects(() => checkInvoiceAutomation({ ...options, clock: () => NaN }));
  await assert.rejects(() => checkInvoiceAutomation({ ...options, eligibleProfiles: -1 }));
});
