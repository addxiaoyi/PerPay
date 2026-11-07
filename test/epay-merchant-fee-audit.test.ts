import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { auditImportedMerchantFees } from "../src/epay-compat/merchant-fee-audit.ts";

it("compares only unambiguous bound current fees and reports every unresolved merchant", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE epay_merchant_accounts(merchant_id INTEGER PRIMARY KEY, fee_rate_bps INTEGER NOT NULL);
      CREATE TABLE epay_merchant_bindings(epay_merchant_id INTEGER, main_merchant_id TEXT, main_api_id TEXT);
      INSERT INTO epay_merchant_accounts VALUES (1,500),(2,0),(3,0),(4,0),(5,0),(6,0),(7,0);
      INSERT INTO epay_merchant_bindings VALUES (1,'a','api-a'),(2,'b','api-b'),(4,'missing','api-missing'),
        (5,'e','wrong'),(6,'f','shared'),(7,'g','api-g');`);
    const payment = { merchants: [
      { id: "a", apiId: "api-a", feeRate: 0.05 },
      { id: "b", apiId: "api-b", feeRate: 0.04 },
      { id: "e", apiId: "api-e", feeRate: 0 },
      { id: "f", apiId: "shared", feeRate: 0 },
      { id: "other", apiId: "shared", feeRate: 0 },
      { id: "g", apiId: "api-g", feeRate: 0.00001 },
    ], ledger: [] };
    assert.throws(() => auditImportedMerchantFees(db, payment), /requires a transaction/);
    db.exec("BEGIN");
    assert.deepEqual(auditImportedMerchantFees(db, payment), {
      merchants: 7, mainMerchants: 6, mainUnmapped: 3, mainAmbiguousBindings: 0, compared: 2, mismatched: 1, unbound: 1, missingMain: 1, identityMismatch: 1,
      ambiguousApi: 1, unsupportedPrecision: 1, sharedCutoffVerified: false, historicalFeesVerified: false,
    });
    assert.throws(() => auditImportedMerchantFees(db, { ...payment, merchants: [...payment.merchants, payment.merchants[0]] }), /duplicate merchant ID/);
    db.exec("ROLLBACK");
  } finally { db.close(); }
});

it("reports duplicate bindings and main merchants without an exact unambiguous identity", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE epay_merchant_accounts(merchant_id INTEGER PRIMARY KEY, fee_rate_bps INTEGER NOT NULL);
      CREATE TABLE epay_merchant_bindings(epay_merchant_id INTEGER, main_merchant_id TEXT, main_api_id TEXT);
      INSERT INTO epay_merchant_accounts VALUES (1,0),(2,0),(3,0);
      INSERT INTO epay_merchant_bindings VALUES (1,'a','api-a'),(2,'a','api-a'),(3,'b','wrong');
      BEGIN`);
    const report = auditImportedMerchantFees(db, { merchants: [
      { id: "a", apiId: "api-a", feeRate: 0 },
      { id: "b", apiId: "api-b", feeRate: 0 },
      { id: "c", apiId: "api-c", feeRate: 0 },
    ], ledger: [] });
    assert.equal(report.mainMerchants, 3);
    assert.equal(report.mainUnmapped, 2);
    assert.equal(report.mainAmbiguousBindings, 1);
    assert.equal(report.identityMismatch, 1);
    db.exec("ROLLBACK");
  } finally { db.close(); }
});
