import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { EPAY_COMPATIBILITY_SCHEMA_SQL } from "../src/epay-compat/schema.ts";
import { EPAY_MAIN_ORDER_SOURCE_SCHEMA_SQL, writeEncryptedMainOrder } from "../src/epay-compat/main-order-source.ts";
import { createMainOrdersWorkspace } from "../src/epay-compat/main-orders-workspace.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { CombinedShadowError, readCombinedShadowOrders } from "./fixtures/legacy-epay/perpay-shadow-combined-orders.ts";

it("passes both isolated order sources through the authenticated merchant proxy", async () => {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  const key = randomBytes(32), cipher = new RuntimeSecretCipher(key, "fixture");
  let allowed = true;
  try {
    db.exec(`${EPAY_COMPATIBILITY_SCHEMA_SQL} ${EPAY_MAIN_ORDER_SOURCE_SCHEMA_SQL}
      CREATE TABLE runtime_master_key_guard(singleton_key INTEGER PRIMARY KEY,cipher_version INTEGER,nonce BLOB,ciphertext BLOB,authentication_tag BLOB);
      INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES(1,'one',0,1,0,0),(2,'two',0,1,0,0);
      INSERT INTO epay_merchant_bindings VALUES('b1','api-one','one',1,0,0),('b2','api-two','two',2,0,0);
      INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES
        ('epay-one','external',1,'item',100,'https://example.test','PAID','PENDING',0,2,2),('private','other',2,'private',200,'https://example.test','PAID','PENDING',0,3,3)`);
    writeEncryptedMainOrder(db, cipher, JSON.stringify({ id: "main-one", merchantId: "one", merchantOrderId: "external", amountCents: 100, status: "paid", createdAt: "1970-01-01T00:00:01Z", paymentHtml: "private-data" }));
    db.exec("INSERT INTO epay_main_order_import_runs VALUES(1,1)");
    const guard = cipher.createGuard();
    db.prepare("INSERT INTO runtime_master_key_guard VALUES(1,1,?,?,?)").run(guard.nonce, guard.ciphertext, guard.authenticationTag);
    const identityFetch = async (url, init) => {
      if (!allowed || new Headers(init?.headers).get("cookie") !== "session=fixture") return new Response(null, { status: 401 });
      if (new URL(String(url)).searchParams.get("merchantId") !== "one") return new Response(null, { status: 403 });
      return Response.json({ ok: true, merchantId: "one", apiId: "api-one", role: "owner" });
    };
    const app = createMainOrdersWorkspace({ database: { read: fn => fn(db), instanceId: () => "fixture" }, masterKey: key, identityOrigin: "http://127.0.0.1:8787", identityFetch });
    const gatewayFetch = async (url, options) => app.request(`/combined-orders${new URL(String(url)).search}`, options);
    const input = { origin: "http://127.0.0.1:8000", cookie: "session=fixture", merchantId: "one", page: 1, pageSize: 20, fetch: gatewayFetch };
    const result = await readCombinedShadowOrders(input);
    assert.deepEqual(result.orders.map(row => [row.source, row.id]), [["main_site", "main-one"], ["epay", "epay-one"]]);
    assert.equal(result.reconciled, false);
    assert.equal(result.deduplicated, false);
    assert.doesNotMatch(JSON.stringify(result), /private|https:/);
    await assert.rejects(() => readCombinedShadowOrders({ ...input, merchantId: "two" }), error => error instanceof CombinedShadowError && error.status === 404);
    allowed = false;
    await assert.rejects(() => readCombinedShadowOrders(input), error => error instanceof CombinedShadowError && error.status === 401);
    await assert.rejects(() => readCombinedShadowOrders({ ...input, origin: "http://example.com" }), error => error instanceof CombinedShadowError && error.status === 503);
  } finally { db.close(); key.fill(0); }
});

it("rejects a forged reconciled response and strips extra fields", async () => {
  const data = { merchantId: "one", page: 1, pageSize: 20, hasNext: false, scope: "unreconciled_sources", deduplicated: false, reconciled: false,
    orders: [{ id: "one", merchantOrderId: "external", amountCents: 100, status: "paid", createdAt: "2024-01-01T00:00:00Z", source: "epay", secret: "hidden" }] };
  const input = { origin: "http://127.0.0.1:8000", cookie: "session=fixture", merchantId: "one", page: 1, pageSize: 20 };
  const clean = await readCombinedShadowOrders({ ...input, fetch: async () => Response.json({ ok: true, data }) });
  assert.doesNotMatch(JSON.stringify(clean), /hidden|secret/);
  await assert.rejects(() => readCombinedShadowOrders({ ...input, fetch: async () => Response.json({ ok: true, data: { ...data, reconciled: true } }) }), error => error instanceof CombinedShadowError && error.status === 503);
  await assert.rejects(() => readCombinedShadowOrders({ ...input, fetch: async () => Response.json({ ok: true, data: { ...data, merchantId: "other" } }) }), error => error instanceof CombinedShadowError && error.status === 503);
});
