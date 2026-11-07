import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { EPAY_COMPATIBILITY_SCHEMA_SQL } from "../src/epay-compat/schema.ts";
import { createMerchantWorkspace } from "../src/epay-compat/merchant-workspace.ts";

it("filters the PerPay workspace using the authenticated merchant binding", async (test) => {
  const client = new URL("./fixtures/legacy-epay/perpay-shadow-orders.ts", import.meta.url);
  if (!existsSync(fileURLToPath(client))) return test.skip("legacy workspace source is not available");
  const { readShadowOrders, ShadowOrdersError } = await import(client.href);
  const sql = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  let authorized = true;
  try {
    sql.exec(`${EPAY_COMPATIBILITY_SCHEMA_SQL}
      INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'one',0,1,0,0),(2,'two',0,1,0,0);
      INSERT INTO epay_merchant_bindings VALUES ('b1','api-one','one',1,0,0),('b2','api-two','two',2,0,0);
      INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES
        ('trade-one','reference-1',1,'first',100,'https://example.test','PAID','PENDING',0,1,1),
        ('trade-pending','reference-2',1,'second',200,'https://example.test','PENDING','PENDING',0,2,2),
        ('trade-other','reference-3',2,'other',300,'https://example.test','PAID','PENDING',0,3,3)`);
    const database = { read: (operation) => operation(sql) };
    const identityFetch = async (_url, options) => {
      if (!authorized || new Headers(options?.headers).get("cookie") !== "session=fixture") return new Response(null, { status: 401 });
      return Response.json({ ok: true, merchantId: "one", apiId: "api-one", role: "owner" });
    };
    const app = createMerchantWorkspace({ database, identityOrigin: "http://127.0.0.1:8787", identityFetch });
    const gatewayFetch = async (url, options) => {
      const request = new URL(String(url));
      assert.equal(request.pathname, "/api/merchant/epay/orders");
      return app.request(`/orders${request.search}`, options);
    };
    const input = { origin: "http://127.0.0.1:8000", cookie: "session=fixture", merchantId: "one", page: 1, pageSize: 20, fetch: gatewayFetch };
    const paid = await readShadowOrders({ ...input, status: "PAID", search: "reference" });
    assert.deepEqual(paid.orders.map((order) => order.id), ["epay_trade-one"]);
    assert.equal(paid.pageInfo.total, 1);
    const pending = await readShadowOrders({ ...input, status: "PENDING" });
    assert.deepEqual(pending.orders.map((order) => order.id), ["epay_trade-pending"]);
    await assert.rejects(() => readShadowOrders({ ...input, merchantId: "two" }), (error) => error instanceof ShadowOrdersError && error.status === 404);
    authorized = false;
    await assert.rejects(() => readShadowOrders(input), (error) => error instanceof ShadowOrdersError && error.status === 401);
  } finally { sql.close(); }
});
