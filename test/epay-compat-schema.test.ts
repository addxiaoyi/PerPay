import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { AppDatabase } from "../src/database/database.ts";

describe("legacy EPay compatibility schema", () => {
  it("migrates into isolated tables and keeps the database healthy", async () => {
    const directory = mkdtempSync(join(tmpdir(), "perpay-epay-compat-"));
    const databasePath = join(directory, "perpay.sqlite3");
    let database: AppDatabase | undefined;
    try {
      database = await AppDatabase.open(databasePath, { masterKey: randomBytes(32) });
      const names = database.read((connection) =>
        (connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'epay_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name),
      );
      assert.deepEqual(names, [
        "epay_alipay_bindings",
        "epay_alipay_confirmations",
        "epay_alipay_intents",
        "epay_alipay_orders",
        "epay_alipay_prepay",
        "epay_alipay_requests",
        "epay_alipay_submissions",
        "epay_alipay_web_links",
        "epay_alipay_web_orders",
        "epay_balance_adjustments",
        "epay_balance_ledger",
        "epay_balance_openings",
        "epay_callback_attempts",
        "epay_callback_jobs",
        "epay_callback_retries",
        "epay_channel_config_secrets",
        "epay_channels",
        "epay_compat_import_runs",
        "epay_config_secrets",
        "epay_config_values",
        "epay_exact_order_requests",
        "epay_invoice_applications",
        "epay_invoices",
        "epay_legacy_invoice_config_source",
        "epay_legacy_sync_runs",
        "epay_live_balances",
        "epay_main_activity_import_runs",
        "epay_main_activity_sources",
        "epay_main_delta_postings",
        "epay_main_ledger_import_runs",
        "epay_main_ledger_sources",
        "epay_main_native_orders",
        "epay_main_order_access",
        "epay_main_order_import_runs",
        "epay_main_order_sources",
        "epay_main_payment_archive",
        "epay_main_refund_import_runs",
        "epay_main_refund_sources",
        "epay_main_sync_runs",
        "epay_merchant_accounts",
        "epay_merchant_bindings",
        "epay_merchant_creation_requests",
        "epay_merchant_enrollments",
        "epay_merchant_key_rotations",
        "epay_merchant_key_versions",
        "epay_merchant_secrets",
        "epay_native_refund_attempts",
        "epay_native_refunds",
        "epay_native_settlements",
        "epay_notify_logs",
        "epay_order_key_versions",
        "epay_orders",
        "epay_pay_types",
        "epay_payout_accounts",
        "epay_payout_attempts",
        "epay_payout_reconciliation_rows",
        "epay_payout_reconciliations",
        "epay_payout_returns",
        "epay_payout_statement_rows",
        "epay_payout_statements",
        "epay_payouts",
        "epay_site_bindings",
        "epay_snapshot_rows",
        "epay_snapshot_runs",
        "epay_wechat_confirmations",
        "epay_wechat_credential_revocations",
        "epay_wechat_credentials",
        "epay_wechat_intents",
        "epay_wechat_payout_authorizations",
        "epay_wechat_payout_identities",
        "epay_wechat_payout_oauth",
        "epay_wechat_prepay_results",
        "epay_wechat_signing_key_revocations",
        "epay_wechat_signing_keys",
        "epay_wechat_site_bindings",
        "epay_wechat_submissions",
      ]);
      assert.deepEqual(database.health(), { ok: true, result: "ok" });
      assert.equal(database.integrityCheck().ok, true);
    } finally {
      database?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
