import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/database/database.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { RuntimeSettingsStore } from "../src/settings/store.ts";
import { preserveMainPaymentArchive } from "../src/epay-compat/main-payment-archive.ts";
import { writeEncryptedMainOrder } from "../src/epay-compat/main-order-source.ts";

export async function balanceFixture(paymentOverrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "perpay-live-balance-"));
  const key = randomBytes(32), db = await AppDatabase.open(join(dir, "db.sqlite"), { masterKey: key });
  const cipher = new RuntimeSecretCipher(key, db.instanceId());
  new RuntimeSettingsStore(db, key).initialize();
  db.write(sql => {
    sql.exec(`INSERT INTO epay_merchant_accounts VALUES(1,'One',0,1,500,0,0),(2,'Two',0,1,500,0,0),(3,'Quarantined',100,0,0,0,0);
      INSERT INTO epay_merchant_bindings VALUES('b1','api-1','main-1',1,0,0),('b2','api-2','main-2',2,0,0);
      INSERT INTO epay_main_ledger_import_runs VALUES(1,0);
      INSERT INTO epay_main_order_import_runs VALUES(1,0);
      INSERT INTO system_metadata VALUES('epay_candidate_import','{"snapshotId":"fixture"}',0);
      INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,get_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at,paid_at)
        VALUES('legacy-1','legacy-1',1,'legacy',1000,1000,'https://example.test','PAID','SUCCESS',1,0,0,0),
        ('legacy-2','legacy-2',2,'legacy',2000,2000,'https://example.test','PAID','SUCCESS',1,0,0,0)`);
    const payment = { merchants: [{ id: "main-1", apiId: "api-1", feeRate: 0.05 }, { id: "main-2", apiId: "api-2", feeRate: 0.05 }], orders: [], ledger: [], refunds: [], settlements: [], callbacks: [], syncJobs: [], paymentEvents: [], orderMirrors: [], accessTokens: [], invoiceApplications: [], balanceSummaryVersion: 1, balanceSummaries: {}, ...paymentOverrides };
    preserveMainPaymentArchive(sql, cipher, payment);
    const orders = payment.orders as Record<string, unknown>[];
    for (const order of orders) writeEncryptedMainOrder(sql, cipher, JSON.stringify(order));
    sql.prepare("UPDATE epay_main_order_import_runs SET order_count=?").run(orders.length);
  });
  return { db, key, cipher, directory: dir, close: () => { db.close(); key.fill(0); rmSync(dir, { recursive: true, force: true }); } };
}
