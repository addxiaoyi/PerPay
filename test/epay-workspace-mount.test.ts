import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createApp } from "../src/http/app.ts";
import { createConfiguredHttpServices } from "./http-fixture.ts";
import { writeEncryptedMainOrder } from "../src/epay-compat/main-order-source.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { writeEncryptedMainRefund } from "../src/epay-compat/main-refund-source.ts";
import { preserveMainPaymentArchive } from "../src/epay-compat/main-payment-archive.ts";
import { createShadowBalanceWorkspace } from "../src/epay-compat/shadow-balance-workspace.ts";

it("mounts the merchant API only when explicitly supplied", async () => {
  const directory = mkdtempSync(join(tmpdir(), "epay-shadow-mount-"));
  const { config, database, identity, settings, orders } = await createConfiguredHttpServices({ directory, apiSecret: null, collectionCodePayload: "https://qr.alipay.com/fkx-test-code-2026" });
  try {
    database.write((db) => db.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'fixture',0,1,0,0);
      INSERT INTO epay_merchant_bindings(binding_id,main_api_id,main_merchant_id,epay_merchant_id,created_at,updated_at) VALUES ('binding','api','merchant',1,0,0)`));
    const dependencies = { config, database, identity, settings, orders, startedAt: new Date(0) };
    const target = "/api/merchant/epay/orders?merchantId=merchant";
    const disabled = createApp(dependencies);
    assert.equal((await disabled.request(target, { headers: { cookie: "s=fixture" } })).status, 404);
    const enabled = createApp({ ...dependencies, merchantWorkspace: { identityOrigin: "http://127.0.0.1:8787", identityFetch: async () => Response.json({ ok: true, merchantId: "merchant", apiId: "api", role: "owner" }) } });
    const response = await enabled.request(target, { headers: { cookie: "s=fixture" } });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { data: { total: number } }).data.total, 0);
    const history = "/api/merchant/epay/main-orders?merchantId=merchant";
    const combined = "/api/merchant/epay/combined-orders?merchantId=merchant";
    const balance = "/api/merchant/epay/shadow-ledger-balance?merchantId=merchant";
    const refunds = "/api/merchant/epay/main-refunds?merchantId=merchant";
    assert.equal((await enabled.request(history, { headers: { cookie: "s=fixture" } })).status, 404);
    assert.equal((await enabled.request(combined, { headers: { cookie: "s=fixture" } })).status, 404);
    assert.equal((await enabled.request(refunds, { headers: { cookie: "s=fixture" } })).status, 404);
    assert.equal((await enabled.request(balance, { headers: { cookie: "s=fixture" } })).status, 404);
    database.write((db) => {
      writeEncryptedMainOrder(db, new RuntimeSecretCipher(config.masterKey, database.instanceId()), JSON.stringify({ id: "historical", merchantId: "merchant", merchantOrderId: "external", amountCents: 100, status: "paid", createdAt: "2024-01-01T00:00:00Z", paymentHtml: "private-payment" }));
      writeEncryptedMainRefund(db, new RuntimeSecretCipher(config.masterKey, database.instanceId()), JSON.stringify({ id: "historical-refund", merchantId: "merchant", orderId: "historical", amountCents: 100, status: "recorded", reference: "private-reference" }));
      const guard = new RuntimeSecretCipher(config.masterKey, database.instanceId()).createGuard();
      db.prepare("INSERT OR IGNORE INTO runtime_master_key_guard(singleton_key,cipher_version,nonce,ciphertext,authentication_tag,created_at) VALUES(1,1,?,?,?,0)").run(guard.nonce, guard.ciphertext, guard.authenticationTag);
      db.exec("INSERT INTO epay_main_order_import_runs VALUES(1,1); INSERT INTO epay_main_refund_import_runs VALUES(1,1)");
      preserveMainPaymentArchive(db, new RuntimeSecretCipher(config.masterKey, database.instanceId()), { merchants: [{ id: "merchant", apiId: "api", feeRate: 0.05 }], ledger: [], refunds: [], settlements: [] });
      db.exec("INSERT INTO epay_main_ledger_import_runs VALUES(1,0)");
    });
    const candidate = createApp({ ...dependencies, merchantWorkspace: { identityOrigin: "http://127.0.0.1:8787", includeMainOrders: true, identityFetch: async () => Response.json({ ok: true, merchantId: "merchant", apiId: "api", role: "owner" }) } });
    const historical = await candidate.request(history, { headers: { cookie: "s=fixture" } });
    const combinedResponse = await candidate.request(combined, { headers: { cookie: "s=fixture" } });
    assert.equal(combinedResponse.status, 200);
    const combinedBody = await combinedResponse.json() as { data: { orders: Array<{ id: string; source: string }>; reconciled: boolean; deduplicated: boolean } };
    assert.deepEqual(combinedBody.data.orders.map(order => [order.source, order.id]), [["main_site", "historical"]]);
    assert.equal(combinedBody.data.reconciled, false);
    assert.equal(combinedBody.data.deduplicated, false);
    assert.equal(historical.status, 200);
    const historicalText = await historical.text();
    assert.match(historicalText, /historical/);
    assert.doesNotMatch(historicalText, /private-payment/);
    assert.equal((await candidate.request(history)).status, 401);
    const refund = await candidate.request(refunds, { headers: { cookie: "s=fixture" } });
    assert.equal(refund.status, 200);
    const refundText = await refund.text();
    assert.match(refundText, /historical-refund/);
    assert.doesNotMatch(refundText, /private-reference/);
    assert.equal((await candidate.request(refunds)).status, 401);
    assert.equal((await candidate.request(balance, { headers: { cookie: "s=fixture" } })).status, 404);
    const shadow = createApp({ ...dependencies, merchantWorkspace: { identityOrigin: "http://127.0.0.1:8787", includeShadowBalance: true, identityFetch: async () => Response.json({ ok: true, merchantId: "merchant", apiId: "api", role: "owner" }) } });
    const projected = await shadow.request(balance, { headers: { cookie: "s=fixture" } });
    assert.equal(projected.status, 200);
    assert.equal(projected.headers.get("cache-control"), "no-store");
    assert.deepEqual(await projected.json(), { ok: true, data: { merchantId: "merchant", availableCents: 0, frozenCents: 0, scope: "shadow_ledger_projection", financiallyReconciled: false } });
    assert.equal((await shadow.request(balance)).status, 401);
    assert.equal((await shadow.request(`${balance}&merchantId=other`, { headers: { cookie: "s=fixture" } })).status, 400);
    assert.equal((await shadow.request("/api/merchant/epay/shadow-ledger-balance?merchantId=other", { headers: { cookie: "s=fixture" } })).status, 404);
    database.write(db => db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<2001)
      INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at)
      SELECT 'limit-' || i,'limit-' || i,1,'fixture',100,'https://example.test','PENDING','PENDING',0,1,1 FROM n`));
    assert.equal((await shadow.request(balance, { headers: { cookie: "s=fixture" } })).status, 503);
    assert.equal(database.read(db => db.isTransaction), false);
    database.write(db => db.exec("DELETE FROM epay_orders WHERE trade_no LIKE 'limit-%'"));
    const failed = createShadowBalanceWorkspace({ database, masterKey: Buffer.alloc(32), identityOrigin: "http://127.0.0.1:8787", identityFetch: async () => Response.json({ ok: true, merchantId: "merchant", apiId: "api", role: "owner" }) });
    assert.equal((await failed.request("/shadow-ledger-balance?merchantId=merchant", { headers: { cookie: "s=fixture" } })).status, 503);
    assert.equal(database.read(db => db.isTransaction), false);
    let reads = 0;
    const changing = {
      instanceId: () => database.instanceId(),
      read: <T>(operation: Parameters<typeof database.read<T>>[0]) => {
        if (++reads === 2) database.write(db => db.prepare("UPDATE epay_merchant_bindings SET main_api_id='other-api' WHERE main_merchant_id='merchant'").run());
        return database.read(operation);
      },
    };
    const race = createShadowBalanceWorkspace({ database: changing, masterKey: config.masterKey, identityOrigin: "http://127.0.0.1:8787", identityFetch: async () => Response.json({ ok: true, merchantId: "merchant", apiId: "api", role: "owner" }) });
    assert.equal((await race.request("/shadow-ledger-balance?merchantId=merchant", { headers: { cookie: "s=fixture" } })).status, 404);
    assert.equal(database.read(db => db.isTransaction), false);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});
