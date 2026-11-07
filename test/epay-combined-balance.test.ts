import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { RuntimeSettingsStore } from "../src/settings/store.ts";
import { preserveMainPaymentArchive } from "../src/epay-compat/main-payment-archive.ts";
import { writeEncryptedMainOrder } from "../src/epay-compat/main-order-source.ts";
import { projectCombinedMerchantBalance } from "../src/epay-compat/combined-balance.ts";
import { createShadowBalanceWorkspace } from "../src/epay-compat/shadow-balance-workspace.ts";
import { recordSyntheticAlipayConfirmation } from "./epay-payment-fixture.ts";
import { enqueuePaidCallback } from "../src/epay-compat/outbox.ts";

it("combines legacy net income and invoice fees without repricing history or double-counting new payments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perpay-combined-balance-"));
  const key = randomBytes(32), database = await AppDatabase.open(join(dir, "db.sqlite"), { masterKey: key });
  const cipher = new RuntimeSecretCipher(key, database.instanceId());
  try {
    new RuntimeSettingsStore(database, key).initialize();
    database.write(sql => {
      sql.exec(`INSERT INTO epay_merchant_accounts VALUES(1,'One',0,1,500,0,0),(2,'Two',0,1,500,0,0);
        INSERT INTO epay_merchant_bindings VALUES('one','api-one','main-one',1,0,0),('two','api-two','main-two',2,0,0);
        INSERT INTO epay_main_ledger_import_runs VALUES(1,0);
        INSERT INTO epay_main_order_import_runs VALUES(1,1);
        INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,get_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at,paid_at) VALUES
        ('legacy','outside',1,'legacy',110,110,110,'https://example.test/notify','PAID','PENDING',0,0,0,0),
        ('shared','shared',1,'shared',100,100,100,'https://example.test/notify','PAID','PENDING',0,0,0,0),
        ('other','other',2,'other',9999,9999,9999,'https://example.test/notify','PAID','PENDING',0,0,0,0);
        INSERT INTO epay_invoice_applications(application_id,merchant_id,trade_no,out_trade_no,title,tax_id,email,fee_cents,status,created_at,updated_at,email_sent)
        VALUES('invoice',1,'legacy','outside','fixture','tax','test@example.test',10,'ISSUED',0,0,0)`);
      const order = { id: "source-order", merchantId: "main-one", merchantOrderId: "shared", amountCents: 100, status: "paid", createdAt: "1970-01-01T00:00:00.000Z" };
      preserveMainPaymentArchive(sql, cipher, { merchants: [{ id: "main-one", apiId: "api-one", feeRate: 0.05 }, { id: "main-two", apiId: "api-two", feeRate: 0.05 }], ledger: [], orders: [order], refunds: [], settlements: [] });
      writeEncryptedMainOrder(sql, cipher, JSON.stringify(order));
      assert.equal(projectCombinedMerchantBalance(sql, cipher, 1).availableCents, 94);
      sql.exec("UPDATE epay_merchant_accounts SET fee_rate_bps=1000 WHERE merchant_id=1");
      assert.equal(projectCombinedMerchantBalance(sql, cipher, 1).availableCents, 94);
      sql.exec(`INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at,paid_at)
        VALUES('native','native',1,'native',100,100,'https://example.test/notify','PAID','PENDING',0,0,0,0)`);
      recordSyntheticAlipayConfirmation(sql, "native", 1, 100, 10);
      enqueuePaidCallback(sql, "native", 1, 0);
      const combined = projectCombinedMerchantBalance(sql, cipher, 1);
      assert.equal(combined.availableCents, 184);
      assert.deepEqual(combined.components, { ledgerCents: 90, gatewayNetCents: 104, invoiceFeesCents: 10 });
      assert.equal(combined.historicalFeeBps, 500);
      assert.equal(combined.financiallyReconciled, false);
    });
    const identityFetch: typeof fetch = async (_request, init) => new Headers(init?.headers).get("cookie") === "session=owner"
      ? Response.json({ ok: true, merchantId: "main-one", apiId: "api-one", role: "owner" }) : Response.json({ ok: false }, { status: 401 });
    const app = createShadowBalanceWorkspace({ database, masterKey: key, identityOrigin: "http://127.0.0.1:8787", identityFetch });
    const path = "/shadow-combined-balance?merchantId=main-one";
    assert.equal((await app.request(path)).status, 401);
    assert.equal((await app.request("/shadow-combined-balance?merchantId=main-two", { headers: { cookie: "session=owner" } })).status, 404);
    const response = await app.request(path, { headers: { cookie: "session=owner" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json() as { data: { availableCents: number } }).data.availableCents, 184);
    database.write(sql => sql.exec("UPDATE epay_main_order_sources SET amount_cents=101 WHERE order_id='source-order'"));
    assert.equal((await app.request(path, { headers: { cookie: "session=owner" } })).status, 503);
    database.write(sql => sql.exec("UPDATE epay_merchant_accounts SET enabled=0 WHERE merchant_id=1"));
    assert.equal((await app.request(path, { headers: { cookie: "session=owner" } })).status, 404);
  } finally { database.close(); key.fill(0); rmSync(dir, { recursive: true, force: true }); }
});
