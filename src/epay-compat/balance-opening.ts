import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { RuntimeSecretCipher } from "../settings/crypto.ts";
import { projectCombinedMerchantBalance } from "./combined-balance.ts";
import { canonicalSource } from "./source-drift.ts";
import { readLiveBalance, safeCents } from "./live-balance.ts";

const hash = (value: unknown) => createHash("sha256").update(canonicalSource(value)).digest("hex");

export function planBalanceOpenings(db: DatabaseSync, cipher: RuntimeSecretCipher, sourceReportSha256: string) {
  if (!db.isTransaction || !/^[a-f0-9]{64}$/.test(sourceReportSha256)) throw new Error("balance opening requires a transaction and source reconciliation digest");
  const marker = JSON.parse(String(db.prepare("SELECT value FROM system_metadata WHERE key='epay_candidate_import'").get()?.value ?? "null"));
  if (!marker || typeof marker.snapshotId !== "string" || !marker.snapshotId || marker.snapshotId.length > 128) throw new Error("balance opening import snapshot is missing");
  for (const table of ["epay_balance_openings", "epay_alipay_intents", "epay_wechat_intents", "epay_callback_jobs"]) {
    if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) throw new Error("balance opening requires an unopened candidate without native orders");
  }
  const bindings = db.prepare(`SELECT b.epay_merchant_id,b.main_merchant_id,b.main_api_id,m.enabled FROM epay_merchant_bindings b
    JOIN epay_merchant_accounts m ON m.merchant_id=b.epay_merchant_id ORDER BY b.epay_merchant_id`).all();
  if (!bindings.length) throw new Error("balance opening requires proven merchant bindings");
  const merchants = bindings.map(binding => {
    const merchantId = Number(binding.epay_merchant_id);
    const projected = projectCombinedMerchantBalance(db, cipher, merchantId);
    return { merchantId, mainMerchantId: String(binding.main_merchant_id), apiId: String(binding.main_api_id), enabled: Number(binding.enabled) === 1,
      availableCents: projected.availableCents, frozenCents: projected.frozenCents,
      historicalExtraCents: safeCents(BigInt(projected.components.gatewayNetCents) - BigInt(projected.components.invoiceFeesCents)),
      historicalFeeBps: projected.historicalFeeBps, components: projected.components };
  });
  const sourceTables = ["epay_orders", "epay_balance_ledger", "epay_invoice_applications", "epay_merchant_accounts", "epay_merchant_bindings"];
  const records = Object.fromEntries(sourceTables.map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()
    .map(row => canonicalSource(JSON.parse(JSON.stringify(row, (_, value: unknown) => typeof value === "bigint" ? value.toString() : value)))).sort()]));
  const body = { version: 1, snapshotId: marker.snapshotId as string, sourceReportSha256, candidateRecordsSha256: hash(records), merchants };
  return { ...body, planSha256: hash(body) };
}

// Carry forward the reconciled legacy liability; do not replay historical provider notifications.
export function installBalanceOpenings(db: DatabaseSync, cipher: RuntimeSecretCipher, plan: ReturnType<typeof planBalanceOpenings>, now: number) {
  if (!db.isTransaction || !Number.isSafeInteger(now) || now < 0) throw new Error("balance opening requires a transaction and valid cutoff");
  if (canonicalSource(planBalanceOpenings(db, cipher, plan.sourceReportSha256)) !== canonicalSource(plan)) throw new Error("balance opening plan changed");
  db.exec("SAVEPOINT epay_balance_opening");
  try {
    for (const merchant of plan.merchants) {
      db.prepare("INSERT INTO epay_balance_openings VALUES(?,?,?,?,?,?,?,?)").run(merchant.merchantId, plan.snapshotId, merchant.availableCents, merchant.frozenCents, merchant.historicalExtraCents, plan.sourceReportSha256, plan.planSha256, now);
      db.prepare("INSERT INTO epay_live_balances VALUES(?,?,?,0)").run(merchant.merchantId, merchant.availableCents, merchant.frozenCents);
      readLiveBalance(db, merchant.merchantId);
    }
    db.exec("RELEASE SAVEPOINT epay_balance_opening");
    return { merchantsOpened: plan.merchants.length, planSha256: plan.planSha256, replayedPayments: 0 };
  } catch (error) {
    db.exec("ROLLBACK TO SAVEPOINT epay_balance_opening; RELEASE SAVEPOINT epay_balance_opening");
    throw error;
  }
}
