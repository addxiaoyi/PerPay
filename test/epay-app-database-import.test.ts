import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { importMainLedgerInTransaction } from "../src/epay-compat/isolated-import.ts";
import { importMainOrdersInTransaction } from "../src/epay-compat/main-order-import.ts";
import { readEncryptedMainLedgerSource } from "../src/epay-compat/main-ledger-source.ts";
import { readEncryptedMainOrder } from "../src/epay-compat/main-order-source.ts";
import { preserveMainActivityInTransaction, readMainActivity } from "../src/epay-compat/main-activity-source.ts";
import { createMainOrdersWorkspace } from "../src/epay-compat/main-orders-workspace.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";

it("imports orders and ledger together through the application database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "perpay-app-import-"));
  const key = randomBytes(32);
  const path = join(directory, "fixture.sqlite");
  let db: AppDatabase | undefined;
  const order = { id: "order", merchantId: "main", merchantOrderId: "external", status: "paid", paidAt: "2024-01-02T03:04:05Z", amountCents: 100, platformFeeCents: 5, merchantNetCents: 95, createdAt: "2024-01-02T03:04:05Z" };
  const entry = { id: "ledger", merchantId: "main", type: "payment_paid", orderId: "order", at: "2024-01-02T03:04:05Z", availableDelta: 95, frozenDelta: 0, grossCents: 100, platformFeeCents: 5, merchantNetCents: 95 };
  const settlement = { id: "settlement", merchantId: "main", amountCents: 12 };
  const callback = { id: "callback", merchantId: "main", orderId: "order", secret: "fixture-callback-secret" };
  const callback2 = { id: "callback2", merchantId: "main", orderId: "order", secret: "another-secret" };
  const syncJob = { id: "sync", orderId: "order" };
  const payment = { merchants: [{ id: "main", apiId: "api", feeRate: 0.05 }], ledger: [entry], orders: [order], refunds: [], settlements: [settlement], callbacks: [callback, callback2], syncJobs: [syncJob], balanceSummaryVersion: 1, balanceSummaries: { main: { availableCents: 95, frozenCents: 0 } } };
  try {
    db = await AppDatabase.open(path, { masterKey: key });
    const cipher = new RuntimeSecretCipher(key, db.instanceId());
    db.write(sql => {
      sql.exec("INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES(1,'fixture',0,1,0,0); INSERT INTO epay_merchant_bindings VALUES('binding','api','main',1,0,0)");
      const guard = cipher.createGuard();
      sql.prepare("INSERT INTO runtime_master_key_guard(singleton_key,cipher_version,nonce,ciphertext,authentication_tag,created_at) VALUES(1,1,?,?,?,0)").run(guard.nonce, guard.ciphertext, guard.authenticationTag);
    });
    assert.throws(() => db!.write(sql => {
      importMainOrdersInTransaction(sql, cipher, payment);
      importMainLedgerInTransaction(sql, cipher, { ...payment, ledger: [{ ...entry, at: "2024-02-30T00:00:00Z" }] });
    }), /invalid main ledger timestamp/);
    db.read(sql => {
      assert.equal(sql.prepare("SELECT count(*) AS count FROM epay_main_order_sources").get()!.count, 0n);
      assert.equal(sql.prepare("SELECT count(*) AS count FROM epay_balance_ledger").get()!.count, 0n);
    });
    assert.throws(() => db!.write(sql => {
      importMainOrdersInTransaction(sql, cipher, payment);
      importMainLedgerInTransaction(sql, cipher, payment);
      preserveMainActivityInTransaction(sql, cipher, { ...payment, callbacks: [{ ...callback, merchantId: "other" }] });
    }), /merchant and order mismatch/);
    db.read(sql => {
      assert.equal(sql.prepare("SELECT count(*) AS count FROM epay_main_order_sources").get()!.count, 0n);
      assert.equal(sql.prepare("SELECT count(*) AS count FROM epay_balance_ledger").get()!.count, 0n);
      assert.equal(sql.prepare("SELECT count(*) AS count FROM epay_main_activity_sources").get()!.count, 0n);
    });
    db.write(sql => {
      assert.equal(importMainOrdersInTransaction(sql, cipher, payment), 1);
      assert.equal(importMainLedgerInTransaction(sql, cipher, payment).count, 1);
      assert.deepEqual(preserveMainActivityInTransaction(sql, cipher, payment).counts, { settlements: 1, callbacks: 2, syncJobs: 1 });
      const sealed = cipher.encrypt("epay:config:legacy-invoice:1", 1, "invoice-fixture-secret");
      sql.prepare("INSERT INTO epay_legacy_invoice_config_source VALUES(?,?,?,?)").run(1, sealed.nonce, sealed.ciphertext, sealed.authenticationTag);
    });
    db.close();
    db = await AppDatabase.open(path, { masterKey: key });
    const reopenedCipher = new RuntimeSecretCipher(key, db.instanceId());
    db.read(sql => {
      assert.equal(readEncryptedMainOrder(sql, reopenedCipher, order.id), JSON.stringify(order));
      assert.equal(readEncryptedMainLedgerSource(sql, reopenedCipher, entry.id), JSON.stringify(entry));
      assert.equal(readMainActivity(sql, reopenedCipher, "settlements", settlement.id), JSON.stringify(settlement));
      assert.equal(readMainActivity(sql, reopenedCipher, "callbacks", callback.id), JSON.stringify(callback));
      assert.equal(readMainActivity(sql, reopenedCipher, "syncJobs", syncJob.id), JSON.stringify(syncJob));
      const row = sql.prepare("SELECT nonce,ciphertext,authentication_tag FROM epay_legacy_invoice_config_source WHERE merchant_id=1").get() as { nonce: Uint8Array; ciphertext: Uint8Array; authentication_tag: Uint8Array };
      const encrypted = { cipherVersion: 1 as const, nonce: Buffer.from(row.nonce), ciphertext: Buffer.from(row.ciphertext), authenticationTag: Buffer.from(row.authentication_tag) };
      const clear = reopenedCipher.decrypt("epay:config:legacy-invoice:1", 1, encrypted);
      try { assert.equal(clear.toString("utf8"), "invoice-fixture-secret"); } finally { clear.fill(0); }
      assert.throws(() => reopenedCipher.decrypt("epay:config:legacy-invoice:2", 1, encrypted));
    });
    const identityFetch: typeof fetch = async (input, init) => {
      if (new Headers(init?.headers).get("cookie") !== "session=fixture") return new Response(null, { status: 401 });
      return new URL(String(input)).searchParams.get("merchantId") === "main" ? Response.json({ ok: true, merchantId: "main", apiId: "api", role: "owner" }) : new Response(null, { status: 403 });
    };
    const app = createMainOrdersWorkspace({ database: db, masterKey: key, identityOrigin: "http://127.0.0.1:8787", identityFetch });
    const headers = { cookie: "session=fixture" };
    const response = await app.request("/main-activity?merchantId=main&kind=callbacks&pageSize=1", { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json() as { data: { records: Array<{ id: string; orderId: string }>; reconciled: boolean; hasNext: boolean } };
    assert.deepEqual(body.data.records.map(({ id, orderId }) => ({ id, orderId })), [{ id: "callback", orderId: "order" }]);
    assert.equal(body.data.reconciled, false);
    assert.equal(body.data.hasNext, true);
    assert.doesNotMatch(JSON.stringify(body), /fixture-callback-secret/);
    const second = await app.request("/main-activity?merchantId=main&kind=callbacks&pageSize=1&page=2", { headers });
    assert.deepEqual(((await second.json()) as { data: { records: Array<{ id: string }> } }).data.records.map(row => row.id), ["callback2"]);
    const settlements = await app.request("/main-activity?merchantId=main&kind=settlements", { headers });
    assert.equal(((await settlements.json()) as { data: { records: Array<{ amountCents: number }> } }).data.records[0]!.amountCents, 12);
    assert.equal((await app.request("/main-activity?merchantId=other&kind=callbacks", { headers })).status, 404);
    assert.equal((await app.request("/main-activity?merchantId=main&kind=callbacks")).status, 401);
    assert.equal((await app.request("/main-activity?merchantId=main&kind=syncJobs", { headers })).status, 400);
    const wrongKey = createMainOrdersWorkspace({ database: db, masterKey: randomBytes(32), identityOrigin: "http://127.0.0.1:8787", identityFetch });
    assert.equal((await wrongKey.request("/main-activity?merchantId=main&kind=callbacks", { headers })).status, 503);
    db.write(sql => sql.exec("UPDATE epay_main_activity_import_runs SET callback_count=3"));
    assert.equal((await app.request("/main-activity?merchantId=main&kind=callbacks", { headers })).status, 503);
    db.write(sql => sql.exec("UPDATE epay_main_activity_import_runs SET callback_count=2"));
    db.write(sql => sql.exec("UPDATE epay_merchant_accounts SET enabled=0 WHERE merchant_id=1"));
    assert.equal((await app.request("/main-activity?merchantId=main&kind=callbacks", { headers })).status, 404);
    assert.equal(db.integrityCheck().ok, true);
  } finally {
    db?.close();
    key.fill(0);
    rmSync(directory, { recursive: true, force: true });
  }
});
