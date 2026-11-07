import assert from "node:assert/strict";
import { it } from "node:test";
import { auditLegacyDashboardBalance, type LegacyBalanceInput } from "../src/epay-compat/legacy-balance-audit.ts";

const fixture = (): LegacyBalanceInput => ({
  mainAvailableCents: -20, mainFrozenCents: 50, feeBps: 500,
  mainOrders: [{ id: "main", merchantOrderId: "shared", amountCents: 100, status: "paid", createdAt: 10 }],
  gatewayOrders: [
    { tradeNo: "shared", merchantOrderId: "shared", amountCents: 100, receivedCents: 100, status: "PAID", createdAt: 10, paidAt: 12 },
    { tradeNo: "separate", merchantOrderId: "separate", amountCents: 110, receivedCents: null, status: "PAID", createdAt: 11, paidAt: 13 },
    { tradeNo: "refunded", merchantOrderId: "refunded", amountCents: 500, receivedCents: 500, status: "REFUNDED", createdAt: 11, paidAt: 14 },
  ],
  invoiceApplications: [
    { id: "issued", feeCents: 10, status: "ISSUED" },
    { id: "issuing", feeCents: 10, status: "ISSUING" },
    { id: "unknown", feeCents: 10, status: "UNKNOWN" },
    { id: "failed", feeCents: 900, status: "FAILED" },
    { id: "pending", feeCents: 900, status: "PENDING" },
  ],
});

it("preserves the legacy balance formula with exact cents and excludes matched/refunded orders", () => {
  const audit = auditLegacyDashboardBalance(fixture());
  assert.equal(audit.legacyAvailableCents, 54);
  assert.equal(audit.fullAvailableCents, 54);
  assert.equal(audit.gatewayNetCents, 104);
  assert.equal(audit.invoiceFeesCents, 30);
  assert.equal(audit.frozenCents, 50);
  assert.equal(audit.financiallyReconciled, false);
  assert.equal(audit.counts.independentlyProjectedOrders, 1);
  assert.equal(audit.evidenceSha256, auditLegacyDashboardBalance(fixture()).evidenceSha256);
});

it("reports truncation, ambiguous matches and rounding changes without declaring reconciliation", () => {
  const source = fixture();
  const mainOrders = [...Array.from({ length: 100 }, (_, id) => ({ id: `m-${id}`, merchantOrderId: `m-${id}`, amountCents: 100, status: "paid", createdAt: 100 })), ...source.mainOrders];
  const audit = auditLegacyDashboardBalance({ ...source, mainOrders });
  assert.equal(audit.legacyAvailableCents - audit.fullAvailableCents, 95);
  assert.equal(audit.issues.mainWindowTruncated, true);
  const duplicate = auditLegacyDashboardBalance({ ...source, mainOrders: [...source.mainOrders, { ...source.mainOrders[0]!, id: "duplicate" }] });
  assert.equal(duplicate.issues.duplicateMainOrderNumbers, 1);
  const mismatch = auditLegacyDashboardBalance({ ...source, mainOrders: [{ ...source.mainOrders[0]!, amountCents: 101 }] });
  assert.equal(mismatch.issues.matchedOrderDifferences, 1);
  const rounding = auditLegacyDashboardBalance({ ...source, feeBps: 2900, gatewayOrders: [{ ...source.gatewayOrders[1]!, amountCents: 50 }] });
  assert.equal(rounding.issues.roundingDifferences, 1);
  assert.equal(rounding.legacyAvailableCents - rounding.fullAvailableCents, 1);
  const tied = auditLegacyDashboardBalance({ ...source, mainOrders: mainOrders.map(order => ({ ...order, createdAt: 100 })) });
  assert.equal(tied.issues.windowBoundaryAmbiguous, true);
});

it("rejects malformed amounts, duplicate records and overflowing totals", () => {
  const source = fixture();
  assert.throws(() => auditLegacyDashboardBalance({ ...source, feeBps: 5001 }));
  assert.throws(() => auditLegacyDashboardBalance({ ...source, mainAvailableCents: 1.01 }));
  assert.throws(() => auditLegacyDashboardBalance({ ...source, gatewayOrders: [...source.gatewayOrders, source.gatewayOrders[0]!] }));
  assert.throws(() => auditLegacyDashboardBalance({ ...source, invoiceApplications: [{ id: "bad", feeCents: -1, status: "ISSUED" }] }));
  assert.throws(() => auditLegacyDashboardBalance({ ...source, mainAvailableCents: Number.MAX_SAFE_INTEGER }));
});
