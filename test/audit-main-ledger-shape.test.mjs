import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

it("reports aggregate ledger shape and exact bindings without disclosing IDs", () => {
  const directory = mkdtempSync(join(tmpdir(), "perpay-ledger-shape-"));
  const file = join(directory, "store.json");
  const merchant = { id: "fixture-private-merchant", apiId: "fixture-private-api", feeRate: 0.05 };
  const entry = { id: "fixture-private-entry", merchantId: merchant.id, type: "payment_paid", at: "2024-01-02T00:00:00Z", availableDelta: 100, frozenDelta: 0 };
  try {
    writeFileSync(file, JSON.stringify({ payment: { merchants: [merchant], ledger: [entry, { ...entry, id: "bad-date", at: "2024-02-30T00:00:00Z" }] } }));
    const script = fileURLToPath(new URL("../scripts/audit-main-ledger-shape.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script, file, "--bindings-stdin"], { input: JSON.stringify([[merchant.id, merchant.apiId]]), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ledgerCount, 2);
    assert.equal(report.errors.invalidTimestamp, 1);
    assert.deepEqual(report.bindings, { sourceCount: 1, matchedMainMerchants: 1, unmatchedMainMerchants: 0 });
    assert.equal(report.coordinatedSnapshot, false);
    assert.equal(result.stdout.includes("fixture-private"), false);
    const mismatched = spawnSync(process.execPath, [script, file, "--bindings-stdin"], { input: JSON.stringify([[merchant.id, "other"]]), encoding: "utf8" });
    assert.equal(JSON.parse(mismatched.stdout).bindings.unmatchedMainMerchants, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
