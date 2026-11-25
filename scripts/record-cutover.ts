import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AppDatabase } from "../src/database/database.ts";
import { SiteStore } from "../src/sites/store.ts";
import { auditConfirmedPayments } from "../src/epay-compat/confirmation-audit.ts";
import { auditNativeRefunds } from "../src/epay-compat/refund-audit.ts";
import { readLiveBalance } from "../src/epay-compat/live-balance.ts";
import { appendAuditEvent } from "../src/database/identity-store.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { readCurrentMainPayment } from "../src/epay-compat/main-delta-store.ts";
import { readLegacyCursor } from "../src/epay-compat/legacy-delta.ts";
import { captureReleaseContents } from "./rehearse-release-restore.ts";
import { canonicalSource } from "../src/epay-compat/source-drift.ts";

const [root, reconciliationPath, rollbackPath, channelsPath, reportPath] = process.argv.slice(2);
if (process.env.PERPAY_RECORD_CUTOVER !== "1" || !root || !reconciliationPath || !rollbackPath || !channelsPath || !reportPath || process.argv.length !== 7) throw new Error("explicit cutover paths required");
process.umask(0o077);
const load = (path: string) => { const bytes = readFileSync(path); return { value: JSON.parse(bytes.toString("utf8")), sha256: createHash("sha256").update(bytes).digest("hex") }; };
const reconciliation = load(reconciliationPath), rollback = load(rollbackPath), channels = load(channelsPath);
const now = Date.now(), cutoff = Date.parse(reconciliation.value.cutoff);
assert.ok(Number.isSafeInteger(cutoff) && now >= cutoff && now - cutoff < 300_000, "final reconciliation is stale");
assert.ok(reconciliation.value.sharedCutoff && reconciliation.value.migrationRecordsReconciled && reconciliation.value.openingLiabilitiesReconciled && reconciliation.value.preservedOwnership && reconciliation.value.unboundCollectionDisabled);
assert.ok(rollback.value.isolated && rollback.value.newFinancialRecordsPreserved && rollback.value.oldDatabaseNotRestored && rollback.value.productionFinancialRecordsUnchanged);
assert.equal(channels.value.providerQueries, 2);
for (const name of ["alipay", "wechat"]) for (const field of ["signatureVerified", "identityVerified", "exactAmountVerified", "transactionVerified"]) assert.equal(channels.value[name]?.[field], true);
assert.ok(Date.now() - Date.parse(channels.value.checkedAt) < 86400_000, "channel verification is stale");
const key = Buffer.from(readFileSync(join(root, "secrets/master-key"), "utf8").trim(), "hex");
const database = await AppDatabase.open(join(root, "data/perpay.sqlite3"), { masterKey: key });
try {
  const manifest = database.write(sql => {
    const sites = new SiteStore({ read: operation => operation(sql), write: operation => operation(sql), instanceId: () => database.instanceId() }, key);
    if (sql.prepare("SELECT 1 FROM system_metadata WHERE key='epay_cutover'").get()) throw new Error("cutover already recorded");
    const marker = JSON.parse(String(sql.prepare("SELECT value FROM system_metadata WHERE key='epay_candidate_import'").get()?.value));
    assert.equal(marker.snapshotId, reconciliation.value.snapshotId);
    const cipher = new RuntimeSecretCipher(key, database.instanceId());
    const legacy = readLegacyCursor(sql, cipher), main = readCurrentMainPayment(sql, cipher);
    assert.ok(legacy.capturedAt <= cutoff && main.capturedAt <= cutoff);
    assert.equal(createHash("sha256").update(canonicalSource({ tables: legacy.tables, columns: legacy.columns, payment: main.payment })).digest("hex"), reconciliation.value.sourceSha256);
    const current = captureReleaseContents(sql);
    for (const [table, contents] of Object.entries(reconciliation.value.exactTableComparisons)) assert.deepEqual(current[table], contents, `final records changed: ${table}`);
    const payments = auditConfirmedPayments(sql), refunds = auditNativeRefunds(sql);
    assert.equal(payments.confirmed, 0); assert.equal(payments.inconsistent, 0); assert.equal(refunds.refunds, 0);
    assert.equal(Number(sql.prepare("SELECT count(*) n FROM epay_callback_jobs").get()?.n), 0);
    const bindings = sql.prepare(`SELECT b.merchant_id,b.client_id FROM epay_site_bindings b JOIN epay_merchant_accounts m ON m.merchant_id=b.merchant_id
      JOIN epay_merchant_bindings a ON a.epay_merchant_id=b.merchant_id WHERE m.enabled=1`).all();
    assert.equal(bindings.length, reconciliation.value.merchants.length);
    for (const row of bindings) {
      const balance = readLiveBalance(sql, Number(row.merchant_id));
      const audited = reconciliation.value.merchants.find((merchant: { merchantId: number }) => merchant.merchantId === Number(row.merchant_id));
      assert.ok(audited?.matches); assert.equal(balance.availableCents, audited.availableCents); assert.equal(balance.frozenCents, audited.frozenCents);
      // All public order admission remains closed until the service and proxy switch.
      const site = sites.get(String(row.client_id)); assert.ok(site); assert.equal(site.configuration.accepting_orders, false);
      sites.update(site.clientId, { revision: site.revision, configuration: { ...site.configuration, accepting_orders: true } }, { actorId: "deployment:cutover" }, now);
    }
    const manifest = { version: 1, snapshotId: marker.snapshotId, sharedCutoff: true, cutoff: reconciliation.value.cutoff,
      reconciliationSha256: reconciliation.sha256, rollbackSha256: rollback.sha256, channelVerificationSha256: channels.sha256,
      recordedAt: new Date(now).toISOString(), quarantinedOrders: reconciliation.value.quarantinedOrders, invoicesEnabled: false };
    sql.prepare("INSERT INTO system_metadata VALUES('epay_cutover',?,?)").run(JSON.stringify(manifest), now);
    appendAuditEvent(sql, { occurredAt: now, actorType: "SYSTEM", actorId: "deployment:cutover", action: "epay.cutover.recorded", outcome: "SUCCESS", subjectType: "gateway", subjectId: "epay", details: manifest });
    return manifest;
  });
  writeFileSync(reportPath, JSON.stringify({ manifest, recorded: true, providerRequests: 0 }), { flag: "wx", mode: 0o600, flush: true });
  console.log(JSON.stringify({ recorded: true, sharedCutoff: true, invoicesEnabled: false, providerRequests: 0 }));
} finally { database.close(); key.fill(0); }
