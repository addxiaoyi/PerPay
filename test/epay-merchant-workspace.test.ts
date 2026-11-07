import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { EPAY_COMPATIBILITY_SCHEMA_SQL } from "../src/epay-compat/schema.ts";
import { EPAY_OUTBOX_SCHEMA_SQL } from "../src/epay-compat/outbox-schema.ts";
import { MAIN_NATIVE_ORDER_SCHEMA } from "../src/epay-compat/main-native-schema.ts";
import { createMerchantWorkspace } from "../src/epay-compat/merchant-workspace.ts";

it("does not return merchant data when its API binding changes after authorization", async () => {
  const sql = new DatabaseSync(":memory:");
  sql.exec(EPAY_COMPATIBILITY_SCHEMA_SQL);
  sql.exec(EPAY_OUTBOX_SCHEMA_SQL);
  sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'a',0,1,0,0);
    INSERT INTO epay_merchant_bindings VALUES ('ba','api-a','a',1,0,0);
    INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at)
      VALUES ('private-order','ext-a',1,'private-name',100,'https://example.test','PAID','PENDING',0,1,1);
    INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,occurred_at) VALUES ('private-ledger',1,'payment_paid',100,1);
    INSERT INTO epay_invoices(invoice_id,trade_no,kind,merchant_id,title,amount_cents,status,provider,created_at,updated_at)
      VALUES ('private-invoice','private-order','normal',1,'private-title',100,'ISSUED','fixture',1,1);
    INSERT INTO epay_notify_logs(notify_id,trade_no,url,params_json,status,created_at) VALUES (1,'private-order','https://example.test','{}','SUCCESS',1);
    INSERT INTO epay_callback_jobs(trade_no,merchant_id,status,attempts,next_attempt_at,created_at,updated_at) VALUES ('private-order',1,'SUCCEEDED',0,1,1,1)`);
  let reads = 0;
  const database = { read: <T>(operation: (db: DatabaseSync) => T) => {
    if (++reads === 2) sql.exec("UPDATE epay_merchant_bindings SET main_api_id='api-new' WHERE main_merchant_id='a'");
    return operation(sql);
  } };
  const identityFetch: typeof fetch = async () => Response.json({ ok: true, merchantId: "a", apiId: "api-a", role: "owner" });
  const app = createMerchantWorkspace({ database, identityOrigin: "http://127.0.0.1:8787", identityFetch });
  try {
    for (const [path, status] of [
      ["/orders?merchantId=a", 200],
      ["/ledger-entries?merchantId=a", 200],
      ["/invoices?merchantId=a", 200],
      ["/notifications?merchantId=a&tradeNo=private-order", 404],
      ["/callback-attempts?merchantId=a&tradeNo=private-order", 404],
    ] as const) {
      sql.exec("UPDATE epay_merchant_bindings SET main_api_id='api-a' WHERE main_merchant_id='a'");
      reads = 0;
      const response = await app.request(path, { headers: { cookie: "session=a" } });
      assert.equal(response.status, status, path);
      assert.doesNotMatch(await response.text(), /private-(?:order|name|ledger|invoice|title)/, path);
    }
  } finally { sql.close(); }
});

it("rechecks the binding when reading notification details after the order lookup", async () => {
  const sql = new DatabaseSync(":memory:");
  sql.exec(`${EPAY_COMPATIBILITY_SCHEMA_SQL} ${EPAY_OUTBOX_SCHEMA_SQL}`);
  sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'a',0,1,0,0);
    INSERT INTO epay_merchant_bindings VALUES ('ba','api-a','a',1,0,0);
    INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at)
      VALUES ('t1','ext-a',1,'name',100,'https://example.test','PAID','PENDING',0,1,1);
    INSERT INTO epay_notify_logs(notify_id,trade_no,url,params_json,status,created_at) VALUES (1,'t1','https://example.test','{}','SUCCESS',1);
    INSERT INTO epay_callback_jobs(trade_no,merchant_id,status,attempts,next_attempt_at,created_at,updated_at) VALUES ('t1',1,'SUCCEEDED',0,1,1,1)`);
  let reads = 0;
  const database = { read: <T>(operation: (db: DatabaseSync) => T) => {
    if (++reads !== 2) return operation(sql);
    const proxy = { prepare: (query: string) => {
      const statement = sql.prepare(query);
      if (!query.includes("SELECT o.trade_no FROM epay_orders")) return statement;
      return { get: (...args: Parameters<typeof statement.get>) => {
        const row = statement.get(...args);
        sql.exec("UPDATE epay_merchant_bindings SET main_api_id='api-new' WHERE main_merchant_id='a'");
        return row;
      } };
    } } as unknown as DatabaseSync;
    return operation(proxy);
  } };
  const identityFetch: typeof fetch = async () => Response.json({ ok: true, merchantId: "a", apiId: "api-a", role: "owner" });
  const app = createMerchantWorkspace({ database, identityOrigin: "http://127.0.0.1:8787", identityFetch });
  try {
    for (const path of ["/notifications?merchantId=a&tradeNo=t1", "/callback-attempts?merchantId=a&tradeNo=t1"]) {
      sql.exec("UPDATE epay_merchant_bindings SET main_api_id='api-a' WHERE main_merchant_id='a'");
      reads = 0;
      const response = await app.request(path, { headers: { cookie: "session=a" } });
      assert.equal(response.status, 200);
      const body = await response.json() as { data: { notifications?: unknown[]; job?: unknown; attempts?: unknown[] } };
      if (body.data.notifications) assert.deepEqual(body.data.notifications, []);
      else { assert.equal(body.data.job, null); assert.deepEqual(body.data.attempts, []); }
    }
  } finally { sql.close(); }
});

it("projects authorized EPay orders for the legacy dashboard without claiming invoice or main-order coverage", async () => {
  const sql = new DatabaseSync(":memory:");
  sql.exec(EPAY_COMPATIBILITY_SCHEMA_SQL);
  const database = { read: <T>(operation: (db: DatabaseSync) => T) => operation(sql) };
  try {
    sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'a',0,1,0,0),(2,'b',0,1,0,0);
      INSERT INTO epay_merchant_bindings VALUES ('ba','api-a','a',1,0,0),('bb','api-b','b',2,0,0);
      INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at,paid_at) VALUES
        ('a1','external-a1',1,'A1',101,'https://example.test','PAID','PENDING',0,1000,1000,1000),
        ('a2','external-a2',1,'A2',5,'https://example.test','PENDING','PENDING',0,2000,2000,NULL),
        ('b1','external-b1',2,'B1',500,'https://example.test','PAID','PENDING',0,3000,3000,3000)`);
    const identityFetch: typeof fetch = async (input) => new URL(String(input)).searchParams.get("merchantId") === "a" ? Response.json({ ok: true, merchantId: "a", apiId: "api-a", role: "owner" }) : new Response(null, { status: 403 });
    const app = createMerchantWorkspace({ database, identityOrigin: "http://127.0.0.1:8787", identityFetch });
    const headers = { cookie: "session=a" };
    const response = await app.request("/orders?merchantId=a&format=legacy&pageSize=1", { headers });
    assert.equal(response.status, 200);
    const body = await response.json() as { data: { orders: Array<Record<string, unknown>>; pageInfo: Record<string, unknown>; scope: string; invoiceAvailable: boolean } };
    assert.deepEqual(body.data.orders, [{ id: "epay_a2", merchantOrderId: "external-a2", name: "A2", amount: "0.05", status: "pending_payment", createdAt: "1970-01-01T00:00:02.000Z", paidAt: null, source: "epay", canInvoice: false }]);
    assert.deepEqual(body.data.pageInfo, { page: 1, pageSize: 1, total: 2, totalPages: 2, hasNext: true, hasPrevious: false });
    assert.equal(body.data.scope, "epay_only");
    assert.equal(body.data.invoiceAvailable, false);
    const second = await app.request("/orders?merchantId=a&format=legacy&pageSize=1&page=2", { headers });
    const secondBody = await second.json() as typeof body;
    assert.equal(secondBody.data.orders[0]?.amount, "1.01");
    assert.equal(secondBody.data.orders[0]?.status, "paid");
    assert.equal(secondBody.data.orders[0]?.paidAt, "1970-01-01T00:00:01.000Z");
    assert.equal(secondBody.data.pageInfo.hasNext, false);
    assert.equal((await app.request("/orders?merchantId=b&format=legacy", { headers })).status, 404);
    assert.equal((await app.request("/orders?merchantId=a&format=legacy")).status, 401);
    assert.equal((await app.request("/orders?merchantId=a&format=legacy&format=legacy", { headers })).status, 400);
    assert.equal((await app.request("/orders?merchantId=a&format=other", { headers })).status, 400);
  } finally { sql.close(); }
});

it("serves only the freshly authorized merchant's orders and paginates deterministically", async () => {
  const sql = new DatabaseSync(":memory:");
  sql.exec(EPAY_COMPATIBILITY_SCHEMA_SQL);
  const database = { read: <T>(operation: (db: DatabaseSync) => T) => operation(sql) };
  try {
    sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'a',0,1,0,0),(2,'b',0,1,0,0);
      INSERT INTO epay_merchant_bindings(binding_id,main_api_id,main_merchant_id,epay_merchant_id,created_at,updated_at) VALUES ('ba','api-a','a',1,0,0),('bb','api-b','b',2,0,0);
      INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES
      ('a1','ext-a1',1,'A1',100,'https://example.test','PENDING','PENDING',0,1,1),
      ('a2','ext-a2',1,'A2',200,'https://example.test','PAID','PENDING',0,2,2),
      ('b1','ext-b1',2,'B1',300,'https://example.test','PENDING','PENDING',0,3,3)`);
    let upstreamCalls = 0;
    const identityFetch: typeof fetch = async (input, init) => {
      upstreamCalls++;
      const id = new URL(String(input)).searchParams.get("merchantId");
      if (new Headers(init?.headers).get("cookie") !== "session=a") return new Response(null, { status: 401 });
      return id === "a" ? Response.json({ ok: true, merchantId: "a", apiId: "api-a", role: "owner" }) : new Response(null, { status: 404 });
    };
    const app = createMerchantWorkspace({ database, identityOrigin: "http://127.0.0.1:8787", identityFetch });
    const first = await app.request("/orders?merchantId=a&pageSize=1", { headers: { cookie: "session=a" } });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), "no-store");
    const body = await first.json() as { data: { orders: Array<{ tradeNo: string }>; total: number; hasNext: boolean } };
    assert.deepEqual(body.data.orders.map((row) => row.tradeNo), ["a2"]);
    assert.equal(body.data.hasNext, true);
    assert.equal(body.data.total, 2);
    const second = await app.request("/orders?merchantId=a&page=2&pageSize=1", { headers: { cookie: "session=a" } });
    const next = await second.json() as { data: { orders: Array<{ tradeNo: string }>; hasNext: boolean } };
    assert.deepEqual(next.data.orders.map((row) => row.tradeNo), ["a1"]);
    assert.equal(next.data.hasNext, false);
    assert.equal((await app.request("/orders?merchantId=b", { headers: { cookie: "session=a" } })).status, 404);
    assert.equal((await app.request("/orders?merchantId=a")).status, 401);
    assert.equal((await app.request("/orders?merchantId=a&merchantId=b", { headers: { cookie: "session=a" } })).status, 400);
    assert.equal((await app.request("/orders?merchantId=a&pageSize=101", { headers: { cookie: "session=a" } })).status, 400);
    const filtered = await app.request("/orders?merchantId=a&status=PAID&search=ext-a2", { headers: { cookie: "session=a" } });
    const filteredBody = await filtered.json() as { data: { orders: Array<{ tradeNo: string }>; total: number } };
    assert.deepEqual(filteredBody.data.orders.map((row) => row.tradeNo), ["a2"]);
    assert.equal(filteredBody.data.total, 1);
    const literal = await app.request("/orders?merchantId=a&search=%25", { headers: { cookie: "session=a" } });
    assert.equal(((await literal.json()) as { data: { total: number } }).data.total, 0);
    assert.equal((await app.request("/orders?merchantId=a&status=INVALID", { headers: { cookie: "session=a" } })).status, 400);
    assert.equal(upstreamCalls, 5);
    sql.exec("UPDATE epay_merchant_accounts SET enabled=0 WHERE merchant_id=1");
    assert.equal((await app.request("/orders?merchantId=a", { headers: { cookie: "session=a" } })).status, 404);
  } finally { sql.close(); }
});

it("only lists notification metadata for an order owned by the authorized merchant", async () => {
  const sql = new DatabaseSync(":memory:");
  sql.exec(EPAY_COMPATIBILITY_SCHEMA_SQL);
  const database = { read: <T>(operation: (db: DatabaseSync) => T) => operation(sql) };
  try {
    sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'a',0,1,0,0),(2,'b',0,1,0,0);
      INSERT INTO epay_merchant_bindings VALUES ('ba','api-a','a',1,0,0),('bb','api-b','b',2,0,0);
      INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES ('a','ext-a',1,'A',100,'https://example.test','PAID','PENDING',0,1,1),('b','ext-b',2,'B',100,'https://example.test','PAID','PENDING',0,1,1);
      INSERT INTO epay_notify_logs(notify_id,trade_no,url,params_json,response_code,response_body,status,error,created_at) VALUES (1,'a','https://example.test/secret','{"sign":"secret-value"}',200,'private-response','SUCCESS',NULL,1),(2,'a','https://example.test','{}',500,NULL,'FAILED','private-error',2),(3,'b','https://example.test','{}',200,NULL,'SUCCESS',NULL,3)`);
    const identityFetch: typeof fetch = async (input) => new URL(String(input)).searchParams.get("merchantId") === "a" ? Response.json({ ok: true, merchantId: "a", apiId: "api-a", role: "owner" }) : new Response(null, { status: 403 });
    const app = createMerchantWorkspace({ database, identityOrigin: "http://127.0.0.1:8787", identityFetch });
    const response = await app.request("/notifications?merchantId=a&tradeNo=a&pageSize=1", { headers: { cookie: "session=a" } });
    assert.equal(response.status, 200);
    const body = await response.json() as { data: { notifications: Array<{ id: number; httpStatus: number }>; hasNext: boolean } };
    assert.deepEqual(body.data.notifications.map((row) => [row.id, row.httpStatus]), [[2, 500]]);
    assert.equal(body.data.hasNext, true);
    const second = await app.request("/notifications?merchantId=a&tradeNo=a&pageSize=1&page=2", { headers: { cookie: "session=a" } });
    const secondText = await second.text();
    assert.equal(secondText.includes("secret-value"), false);
    assert.equal(secondText.includes("private-response"), false);
    assert.equal((JSON.parse(secondText) as { data: { notifications: Array<{ id: number }> } }).data.notifications[0]?.id, 1);
    assert.equal((await app.request("/notifications?merchantId=a&tradeNo=b", { headers: { cookie: "session=a" } })).status, 404);
    assert.equal((await app.request("/notifications?merchantId=a&tradeNo=a")).status, 401);
    assert.equal((await app.request("/notifications?merchantId=a&tradeNo=a&tradeNo=b", { headers: { cookie: "session=a" } })).status, 400);
  } finally { sql.close(); }
});

it("lists isolated ledger entries without presenting them as a reconciled balance", async () => {
  const sql = new DatabaseSync(":memory:");
  sql.exec(EPAY_COMPATIBILITY_SCHEMA_SQL);
  const database = { read: <T>(operation: (db: DatabaseSync) => T) => operation(sql) };
  try {
    sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'a',999,1,0,0),(2,'b',555,1,0,0);
      INSERT INTO epay_merchant_bindings VALUES ('ba','api-a','a',1,0,0),('bb','api-b','b',2,0,0);
      INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,frozen_delta_cents,reason,actor_id,occurred_at,source) VALUES
        ('a1',1,'payment_paid',100,0,'private-reason','private-actor',1,'perpay_epay'),
        ('a2',1,'withdrawal',-75,75,'private-reason','private-actor',2,'legacy_epay'),
        ('b1',2,'payment_paid',500,0,'other-reason','other-actor',3,'perpay_epay')`);
    let permitted = true;
    const identityFetch: typeof fetch = async (input, init) => {
      if (!new Headers(init?.headers).get("cookie")) return new Response(null, { status: 401 });
      return permitted && new URL(String(input)).searchParams.get("merchantId") === "a" ? Response.json({ ok: true, merchantId: "a", apiId: "api-a", role: "owner" }) : new Response(null, { status: 403 });
    };
    const app = createMerchantWorkspace({ database, identityOrigin: "http://127.0.0.1:8787", identityFetch });
    const response = await app.request("/ledger-entries?merchantId=a&pageSize=1", { headers: { cookie: "session=a" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json() as { data: { entries: Array<{ id: string; availableDeltaCents: number; frozenDeltaCents: number; source: string }>; hasNext: boolean; reconciled: boolean } };
    assert.deepEqual(body.data.entries.map((row) => [row.id, row.availableDeltaCents, row.frozenDeltaCents, row.source]), [["a2", -75, 75, "legacy_epay"]]);
    assert.equal(body.data.hasNext, true);
    assert.equal(body.data.reconciled, false);
    assert.equal(JSON.stringify(body).includes("private-reason"), false);
    assert.equal(JSON.stringify(body).includes("private-actor"), false);
    assert.equal(JSON.stringify(body).includes("999"), false);
    const second = await app.request("/ledger-entries?merchantId=a&page=2&pageSize=1", { headers: { cookie: "session=a" } });
    const secondBody = await second.json() as { data: { entries: Array<{ id: string }>; hasNext: boolean } };
    assert.deepEqual(secondBody.data.entries.map((row) => row.id), ["a1"]);
    assert.equal(secondBody.data.hasNext, false);
    assert.equal((await app.request("/ledger-entries?merchantId=b", { headers: { cookie: "session=a" } })).status, 404);
    assert.equal((await app.request("/ledger-entries?merchantId=a")).status, 401);
    assert.equal((await app.request("/ledger-entries?merchantId=a&merchantId=b", { headers: { cookie: "session=a" } })).status, 400);
    sql.exec("INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,occurred_at) VALUES ('overflow',1,'payment_paid',9007199254740992,4)");
    assert.equal((await app.request("/ledger-entries?merchantId=a", { headers: { cookie: "session=a" } })).status, 503);
    permitted = false;
    assert.equal((await app.request("/ledger-entries?merchantId=a", { headers: { cookie: "session=a" } })).status, 404);
  } finally { sql.close(); }
});

it("restricts invoice and application reads to the authorized active binding", async () => {
  const sql = new DatabaseSync(":memory:");
  sql.exec(EPAY_COMPATIBILITY_SCHEMA_SQL);
  const database = { read: <T>(operation: (db: DatabaseSync) => T) => operation(sql) };
  try {
    sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'a',0,1,0,0),(2,'b',0,1,0,0);
      INSERT INTO epay_merchant_bindings VALUES ('ba','api-a','a',1,0,0),('bb','api-b','b',2,0,0);
      INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES
        ('t1','external',1,'A',120,'https://example.test','PAID','SUCCESS',0,1,1),
        ('t2','external2',2,'B',900,'https://example.test','PAID','SUCCESS',0,2,2),
        ('t3','external3',1,'A3',300,'https://example.test','PAID','SUCCESS',0,3,3);
      INSERT INTO epay_invoices(invoice_id,trade_no,kind,merchant_id,title,amount_cents,status,provider,created_at,updated_at) VALUES ('i1','t1','normal',1,'A',120,'ISSUED','fixture',1,1),('i2','t2','normal',2,'B',900,'ISSUED','fixture',2,2);
      INSERT INTO epay_invoice_applications(application_id,merchant_id,trade_no,out_trade_no,title,tax_id,email,fee_cents,status,created_at,updated_at,email_sent) VALUES ('a1',1,'t1','external','A','secret-tax','private@example.test',5,'ISSUED',1,1,0),('a2',2,'t2','external2','B','other-tax','other@example.test',7,'ISSUED',2,2,0)`);
    let authorized = true;
    const identityFetch: typeof fetch = async (input, init) => {
      const merchantId = new URL(String(input)).searchParams.get("merchantId");
      if (!new Headers(init?.headers).get("cookie")) return new Response(null, { status: 401 });
      return authorized && merchantId === "a" ? Response.json({ ok: true, merchantId: "a", apiId: "api-a", role: "owner" }) : new Response(null, { status: 403 });
    };
    const app = createMerchantWorkspace({ database, identityOrigin: "http://127.0.0.1:8787", identityFetch });
    const response = await app.request("/invoices?merchantId=a", { headers: { cookie: "session=a" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json() as { data: { invoices: Array<{ id: string; amountCents: number }>; applications: Array<{ id: string; feeCents: number }> } };
    assert.deepEqual(body.data.invoices.map((row) => [row.id, row.amountCents]), [["i1", 120]]);
    assert.deepEqual(body.data.applications.map((row) => [row.id, row.feeCents]), [["a1", 5]]);
    assert.equal(JSON.stringify(body).includes("private@example.test"), false);
    assert.equal((await app.request("/invoices?merchantId=b", { headers: { cookie: "session=a" } })).status, 404);
    assert.equal((await app.request("/invoices?merchantId=a")).status, 401);
    assert.equal((await app.request("/invoices?merchantId=a&page=1&page=2", { headers: { cookie: "session=a" } })).status, 400);
    sql.exec(`INSERT INTO epay_invoices(invoice_id,trade_no,kind,merchant_id,title,amount_cents,status,provider,created_at,updated_at) VALUES ('i3','t3','normal',1,'A3',300,'ISSUED','fixture',3,3);
      INSERT INTO epay_invoice_applications(application_id,merchant_id,trade_no,out_trade_no,title,tax_id,email,fee_cents,status,created_at,updated_at,email_sent) VALUES ('a3',1,'t3','external3','A3','tax','a@example.test',8,'ISSUED',3,3,0)`);
    const independent = await app.request("/invoices?merchantId=a&pageSize=1&invoicePage=2&applicationPage=1", { headers: { cookie: "session=a" } });
    const independentBody = await independent.json() as { data: { invoices: Array<{ id: string }>; applications: Array<{ id: string }>; invoicePage: number; applicationPage: number; applicationsHaveNext: boolean } };
    assert.deepEqual(independentBody.data.invoices.map((row) => row.id), ["i1"]);
    assert.deepEqual(independentBody.data.applications.map((row) => row.id), ["a3"]);
    assert.equal(independentBody.data.invoicePage, 2);
    assert.equal(independentBody.data.applicationPage, 1);
    assert.equal(independentBody.data.applicationsHaveNext, true);
    assert.equal((await app.request("/invoices?merchantId=a&invoicePage=0", { headers: { cookie: "session=a" } })).status, 400);
    assert.equal((await app.request("/invoices?merchantId=a&applicationPage=1&applicationPage=2", { headers: { cookie: "session=a" } })).status, 400);
    sql.exec("INSERT INTO epay_invoices(invoice_id,trade_no,kind,merchant_id,title,amount_cents,status,provider,created_at,updated_at) VALUES ('wrong-owner','t2','normal',1,'private',1,'ISSUED','fixture',4,4)");
    const badInvoice = await app.request("/invoices?merchantId=a", { headers: { cookie: "session=a" } });
    assert.equal(badInvoice.status, 503);
    assert.doesNotMatch(await badInvoice.text(), /private|t2|wrong-owner/);
    sql.exec("DELETE FROM epay_invoices WHERE invoice_id='wrong-owner'; UPDATE epay_invoice_applications SET out_trade_no='wrong' WHERE application_id='a1'");
    assert.equal((await app.request("/invoices?merchantId=a", { headers: { cookie: "session=a" } })).status, 503);
    authorized = false;
    assert.equal((await app.request("/invoices?merchantId=a", { headers: { cookie: "session=a" } })).status, 404);
  } finally { sql.close(); }
});

it("restricts new callback attempts to the authorized order and hides delivery secrets", async () => {
  const sql = new DatabaseSync(":memory:");
  sql.exec(`${EPAY_COMPATIBILITY_SCHEMA_SQL} ${EPAY_OUTBOX_SCHEMA_SQL} ALTER TABLE epay_callback_attempts ADD COLUMN method TEXT NOT NULL DEFAULT 'POST';`);
  sql.exec(MAIN_NATIVE_ORDER_SCHEMA);
  const database = { read: <T>(operation: (db: DatabaseSync) => T) => operation(sql) };
  try {
    sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'a',0,1,0,0),(2,'b',0,1,0,0);
      INSERT INTO epay_merchant_bindings VALUES ('ba','api-a','a',1,0,0),('bb','api-b','b',2,0,0);
      INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES
        ('a','ext-a',1,'A',100,'https://example.test/private','PAID','PENDING',0,1,1),('empty','ext-empty',1,'Empty',100,'https://example.test','PENDING','PENDING',0,1,1),('b','ext-b',2,'B',100,'https://example.test','PAID','PENDING',0,1,1);
      INSERT INTO epay_callback_jobs(trade_no,merchant_id,status,attempts,next_attempt_at,created_at,updated_at) VALUES ('a',1,'SUCCEEDED',2,3,1,3),('b',2,'FAILED',1,3,1,3);
      INSERT INTO epay_callback_attempts(attempt_id,trade_no,attempt_number,started_at,finished_at,outcome,http_status,error_code,method) VALUES
        ('a-1','a',1,1,2,'RETRY',500,'private-error','POST'),('a-2','a',2,2,3,'SUCCESS',200,NULL,'GET'),('b-1','b',1,1,2,'FAILED',500,'other-secret','POST')`);
    let authorized = true;
    const identityFetch: typeof fetch = async (input, init) => {
      if (!new Headers(init?.headers).get("cookie")) return new Response(null, { status: 401 });
      return authorized && new URL(String(input)).searchParams.get("merchantId") === "a" ? Response.json({ ok: true, merchantId: "a", apiId: "api-a", role: "owner" }) : new Response(null, { status: 403 });
    };
    const app = createMerchantWorkspace({ database, identityOrigin: "http://127.0.0.1:8787", identityFetch });
    const response = await app.request("/callback-attempts?merchantId=a&tradeNo=a&pageSize=1", { headers: { cookie: "session=a" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json() as { data: { job: { status: string; attempts: number }; attempts: Array<{ id: string; method: string; httpStatus: number }>; hasNext: boolean } };
    assert.deepEqual(body.data.job, { status: "SUCCEEDED", attempts: 2, updatedAt: 3 });
    assert.deepEqual(body.data.attempts.map((row) => [row.id, row.method, row.httpStatus]), [["a-2", "GET", 200]]);
    assert.equal(body.data.hasNext, true);
    const second = await app.request("/callback-attempts?merchantId=a&tradeNo=a&pageSize=1&page=2", { headers: { cookie: "session=a" } });
    const secondText = await second.text();
    assert.equal(secondText.includes("private-error"), false);
    assert.equal(secondText.includes("example.test"), false);
    assert.equal(secondText.includes("lease"), false);
    assert.equal((JSON.parse(secondText) as { data: { attempts: Array<{ id: string }> } }).data.attempts[0]?.id, "a-1");
    assert.equal((JSON.parse(secondText) as { data: { attempts: Array<{ failureReason: string }> } }).data.attempts[0]?.failureReason, "通知处理失败，请联系管理员");
    sql.exec("UPDATE epay_callback_attempts SET error_code='transport_timeout' WHERE attempt_id='a-1'");
    const timedOut = await app.request("/callback-attempts?merchantId=a&tradeNo=a&pageSize=1&page=2", { headers: { cookie: "session=a" } });
    const timedOutBody = await timedOut.json() as { data: { attempts: Array<{ failureReason: string }> } };
    assert.equal(timedOutBody.data.attempts[0]?.failureReason, "商户接口响应超时");
    const empty = await app.request("/callback-attempts?merchantId=a&tradeNo=empty", { headers: { cookie: "session=a" } });
    assert.equal(((await empty.json()) as { data: { job: unknown } }).data.job, null);
    assert.equal((await app.request("/callback-attempts?merchantId=a&tradeNo=b", { headers: { cookie: "session=a" } })).status, 404);
    assert.equal((await app.request("/callback-attempts?merchantId=b&tradeNo=b", { headers: { cookie: "session=a" } })).status, 404);
    assert.equal((await app.request("/callback-attempts?merchantId=a&tradeNo=a")).status, 401);
    assert.equal((await app.request("/callback-attempts?merchantId=a&tradeNo=a&tradeNo=b", { headers: { cookie: "session=a" } })).status, 400);
    sql.exec("UPDATE epay_callback_jobs SET merchant_id=2 WHERE trade_no='a'");
    const inconsistent = await app.request("/callback-attempts?merchantId=a&tradeNo=a", { headers: { cookie: "session=a" } });
    assert.equal(inconsistent.status, 503);
    assert.equal((await inconsistent.text()).includes("merchant mismatch"), false);
    authorized = false;
    assert.equal((await app.request("/callback-attempts?merchantId=a&tradeNo=a", { headers: { cookie: "session=a" } })).status, 404);
  } finally { sql.close(); }
});
