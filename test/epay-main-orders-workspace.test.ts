import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { EPAY_COMPATIBILITY_SCHEMA_SQL } from "../src/epay-compat/schema.ts";
import { EPAY_MAIN_ORDER_SOURCE_SCHEMA_SQL, writeEncryptedMainOrder } from "../src/epay-compat/main-order-source.ts";
import { createMainOrdersWorkspace } from "../src/epay-compat/main-orders-workspace.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { EPAY_MAIN_REFUND_SOURCE_SCHEMA_SQL, writeEncryptedMainRefund } from "../src/epay-compat/main-refund-source.ts";

it("isolates historical refund summaries and rechecks revoked bindings", async () => {
  const sql = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  const key = randomBytes(32), cipher = new RuntimeSecretCipher(key, "instance");
  let reads = 0, revoke = false;
  const database = { instanceId: () => "instance", read: <T>(fn: (db: DatabaseSync) => T) => { if (++reads === 2 && revoke) sql.exec("UPDATE epay_merchant_bindings SET main_api_id='changed' WHERE main_merchant_id='a'"); return fn(sql); } };
  const identityFetch: typeof fetch = async (input, init) => {
    if (new Headers(init?.headers).get("cookie") !== "session=a") return new Response(null, { status: 401 });
    return new URL(String(input)).searchParams.get("merchantId") === "a" ? Response.json({ ok: true, merchantId: "a", apiId: "api-a", role: "owner" }) : new Response(null, { status: 403 });
  };
  try {
    sql.exec(`${EPAY_COMPATIBILITY_SCHEMA_SQL} ${EPAY_MAIN_REFUND_SOURCE_SCHEMA_SQL}
      CREATE TABLE runtime_master_key_guard(singleton_key INTEGER PRIMARY KEY,cipher_version INTEGER,nonce BLOB,ciphertext BLOB,authentication_tag BLOB);
      INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'a',0,1,0,0),(2,'b',0,1,0,0);
      INSERT INTO epay_merchant_bindings VALUES ('ba','api-a','a',1,0,0),('bb','api-b','b',2,0,0)`);
    for (const refund of [
      { id: "a1", merchantId: "a", orderId: "order-a", amountCents: 50, status: "recorded", reference: "private-reference" },
      { id: "a2", merchantId: "a", amountCents: 20, status: "pending" },
      { id: "b1", merchantId: "b", amountCents: 99, status: "recorded", reference: "other-private" },
    ]) writeEncryptedMainRefund(sql, cipher, JSON.stringify(refund));
    const guard = cipher.createGuard();
    sql.prepare("INSERT INTO runtime_master_key_guard VALUES(1,1,?,?,?)").run(guard.nonce, guard.ciphertext, guard.authenticationTag);
    sql.exec("INSERT INTO epay_main_refund_import_runs VALUES(1,3)");
    const app = createMainOrdersWorkspace({ database, masterKey: key, identityOrigin: "http://127.0.0.1:8787", identityFetch });
    const headers = { cookie: "session=a" };
    const first = await app.request("/main-refunds?merchantId=a&pageSize=1", { headers });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), "no-store");
    const body = await first.json() as { data: { refunds: Array<{ id: string }>; hasNext: boolean; reconciled: boolean } };
    assert.deepEqual(body.data.refunds.map((refund) => refund.id), ["a1"]);
    assert.equal(body.data.hasNext, true);
    assert.equal(body.data.reconciled, false);
    assert.doesNotMatch(JSON.stringify(body), /private|b1/);
    assert.equal((await app.request("/main-refunds?merchantId=b", { headers })).status, 404);
    assert.equal((await app.request("/main-refunds?merchantId=a")).status, 401);
    assert.equal((await app.request("/main-refunds?merchantId=a&page=1&page=2", { headers })).status, 400);
    const wrongKey = createMainOrdersWorkspace({ database, masterKey: randomBytes(32), identityOrigin: "http://127.0.0.1:8787", identityFetch });
    assert.equal((await wrongKey.request("/main-refunds?merchantId=a", { headers })).status, 503);
    sql.exec("UPDATE epay_main_refund_import_runs SET refund_count=4");
    assert.equal((await app.request("/main-refunds?merchantId=a", { headers })).status, 503);
    sql.exec("DELETE FROM epay_main_refund_import_runs");
    assert.equal((await app.request("/main-refunds?merchantId=a", { headers })).status, 503);
    sql.exec("INSERT INTO epay_main_refund_import_runs VALUES(1,3)");
    reads = 0; revoke = true;
    const revoked = await app.request("/main-refunds?merchantId=a", { headers });
    assert.deepEqual(((await revoked.json()) as { data: { refunds: unknown[] } }).data.refunds, []);
  } finally { sql.close(); key.fill(0); }
});

it("returns only verified, authorized historical order metadata", async () => {
  const sql = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  const key = randomBytes(32), cipher = new RuntimeSecretCipher(key, "instance");
  let reads = 0, revokeDuringRead = false;
  const database = { instanceId: () => "instance", read: <T>(fn: (db: DatabaseSync) => T) => { if (++reads === 2 && revokeDuringRead) sql.exec("UPDATE epay_merchant_bindings SET main_api_id='changed' WHERE main_merchant_id='a'"); return fn(sql); } };
  const identityFetch: typeof fetch = async (input, init) => {
    if (new Headers(init?.headers).get("cookie") !== "session=a") return new Response(null, { status: 401 });
    return new URL(String(input)).searchParams.get("merchantId") === "a" ? Response.json({ ok: true, merchantId: "a", apiId: "api-a", role: "owner" }) : new Response(null, { status: 403 });
  };
  try {
    sql.exec(`${EPAY_COMPATIBILITY_SCHEMA_SQL} ${EPAY_MAIN_ORDER_SOURCE_SCHEMA_SQL}
      CREATE TABLE runtime_master_key_guard(singleton_key INTEGER PRIMARY KEY,cipher_version INTEGER,nonce BLOB,ciphertext BLOB,authentication_tag BLOB)`);
    sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'a',0,1,0,0),(2,'b',0,1,0,0);
      INSERT INTO epay_merchant_bindings VALUES ('ba','api-a','a',1,0,0),('bb','api-b','b',2,0,0)`);
    for (const order of [
      { id: "a1", merchantId: "a", merchantOrderId: "external-1", amountCents: 100, status: "paid", createdAt: "2024-01-01T00:00:00Z", paymentHtml: "private-payment" },
      { id: "a2", merchantId: "a", merchantOrderId: "external-2", amountCents: 200, status: "pending_payment", createdAt: "2024-01-02T00:00:00Z" },
      { id: "b1", merchantId: "b", merchantOrderId: "other-private-order", amountCents: 300, status: "paid", createdAt: "2024-01-03T00:00:00Z" },
    ]) writeEncryptedMainOrder(sql, cipher, JSON.stringify(order));
    const guard = cipher.createGuard();
    sql.prepare("INSERT INTO runtime_master_key_guard VALUES(1,1,?,?,?)").run(guard.nonce, guard.ciphertext, guard.authenticationTag);
    sql.exec("INSERT INTO epay_main_order_import_runs VALUES(1,3)");
    sql.exec(`INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES
      ('epay-a','external-1',1,'visible',100,'https://example.test/notify','PAID','PENDING',0,1704153600000,1704153600000),
      ('epay-b','other-private-order',2,'private','100','https://example.test/notify','PAID','PENDING',0,1704240000000,1704240000000)`);
    const app = createMainOrdersWorkspace({ database, masterKey: key, identityOrigin: "http://127.0.0.1:8787", identityFetch });
    const headers = { cookie: "session=a" };
    const combined = await app.request("/combined-orders?merchantId=a&pageSize=1", { headers });
    assert.equal(combined.status, 200);
    assert.equal(combined.headers.get("cache-control"), "no-store");
    const combinedBody = await combined.json() as { data: { orders: Array<{ id: string; source: string }>; hasNext: boolean; deduplicated: boolean; reconciled: boolean } };
    assert.deepEqual(combinedBody.data.orders, [{ id: "a2", merchantOrderId: "external-2", amountCents: 200, status: "pending_payment", createdAt: "2024-01-02T00:00:00Z", source: "main_site" }]);
    assert.equal(combinedBody.data.hasNext, true);
    assert.equal(combinedBody.data.deduplicated, false);
    assert.equal(combinedBody.data.reconciled, false);
    const secondCombined = await app.request("/combined-orders?merchantId=a&pageSize=1&page=2", { headers });
    assert.deepEqual(((await secondCombined.json()) as { data: { orders: Array<{ id: string }> } }).data.orders.map(order => order.id), ["epay-a"]);
    const thirdCombined = await app.request("/combined-orders?merchantId=a&pageSize=1&page=3", { headers });
    assert.deepEqual(((await thirdCombined.json()) as { data: { orders: Array<{ id: string }>; hasNext: boolean } }).data.orders.map(order => order.id), ["a1"]);
    const paired = await app.request("/combined-orders?merchantId=a&status=paid&search=external-1", { headers });
    const pairedText = await paired.text();
    const pairedBody = JSON.parse(pairedText) as { data: { orders: Array<{ id: string; source: string }> } };
    assert.deepEqual(pairedBody.data.orders.map(order => [order.source, order.id]), [["epay", "epay-a"], ["main_site", "a1"]]);
    assert.doesNotMatch(pairedText, /private|other-private-order/);
    assert.equal((await app.request("/combined-orders?merchantId=b", { headers })).status, 404);
    assert.equal((await app.request("/combined-orders?merchantId=a")).status, 401);
    assert.equal((await app.request("/combined-orders?merchantId=a&page=1&page=2", { headers })).status, 400);
    const combinedLiteral = await app.request("/combined-orders?merchantId=a&search=%25", { headers });
    assert.deepEqual(((await combinedLiteral.json()) as { data: { orders: unknown[] } }).data.orders, []);
    const first = await app.request("/main-orders?merchantId=a&pageSize=1", { headers });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), "no-store");
    const body = await first.json() as { data: { orders: Array<{ id: string }>; hasNext: boolean; reconciled: boolean } };
    assert.deepEqual(body.data.orders.map((order) => order.id), ["a2"]);
    assert.equal(body.data.hasNext, true);
    assert.equal(body.data.reconciled, false);
    const second = await app.request("/main-orders?merchantId=a&pageSize=1&page=2", { headers });
    const text = await second.text();
    assert.match(text, /a1/);
    assert.doesNotMatch(text, /private-payment|other-private-order/);
    assert.equal((await app.request("/main-orders?merchantId=b", { headers })).status, 404);
    assert.equal((await app.request("/main-orders?merchantId=a")).status, 401);
    assert.equal((await app.request("/main-orders?merchantId=a&merchantId=b", { headers })).status, 400);
    const paid = await app.request("/main-orders?merchantId=a&status=paid", { headers });
    assert.deepEqual(((await paid.json()) as { data: { orders: Array<{ id: string }> } }).data.orders.map((order) => order.id), ["a1"]);
    const pending = await app.request("/main-orders?merchantId=a&status=pending_payment&search=external-2", { headers });
    assert.deepEqual(((await pending.json()) as { data: { orders: Array<{ id: string }> } }).data.orders.map((order) => order.id), ["a2"]);
    assert.equal((await app.request("/main-orders?merchantId=a&status=paid&status=pending_payment", { headers })).status, 400);
    assert.equal((await app.request("/main-orders?merchantId=a&status=paid%25", { headers })).status, 400);
    const literal = await app.request("/main-orders?merchantId=a&search=%25", { headers });
    assert.deepEqual(((await literal.json()) as { data: { orders: unknown[] } }).data.orders, []);
    const wrongKey = createMainOrdersWorkspace({ database, masterKey: randomBytes(32), identityOrigin: "http://127.0.0.1:8787", identityFetch });
    assert.equal((await wrongKey.request("/combined-orders?merchantId=a", { headers })).status, 503);
    assert.equal((await wrongKey.request("/main-orders?merchantId=a", { headers })).status, 503);
    assert.equal((await wrongKey.request("/main-orders?merchantId=a&search=missing", { headers })).status, 503);
    sql.exec("UPDATE epay_main_order_import_runs SET order_count=4");
    assert.equal((await app.request("/combined-orders?merchantId=a", { headers })).status, 503);
    assert.equal((await app.request("/main-orders?merchantId=a", { headers })).status, 503);
    sql.exec("DELETE FROM epay_main_order_import_runs");
    assert.equal((await app.request("/main-orders?merchantId=a", { headers })).status, 503);
    sql.exec("INSERT INTO epay_main_order_import_runs VALUES(1,3)");
    sql.exec("UPDATE epay_main_order_sources SET amount_cents=101 WHERE order_id='a1'");
    assert.equal((await app.request("/combined-orders?merchantId=a&search=a1", { headers })).status, 503);
    assert.equal((await app.request("/main-orders?merchantId=a&search=a1", { headers })).status, 503);
    sql.exec("UPDATE epay_main_order_sources SET amount_cents=100 WHERE order_id='a1'");
    reads = 0; revokeDuringRead = true;
    const combinedRevoked = await app.request("/combined-orders?merchantId=a", { headers });
    assert.equal(combinedRevoked.status, 200);
    assert.deepEqual(((await combinedRevoked.json()) as { data: { orders: unknown[] } }).data.orders, []);
    sql.exec("UPDATE epay_merchant_bindings SET main_api_id='api-a' WHERE main_merchant_id='a'");
    reads = 0; revokeDuringRead = true;
    const revoked = await app.request("/main-orders?merchantId=a", { headers });
    assert.equal(revoked.status, 200);
    assert.deepEqual(((await revoked.json()) as { data: { orders: unknown[] } }).data.orders, []);
  } finally { sql.close(); key.fill(0); }
});
