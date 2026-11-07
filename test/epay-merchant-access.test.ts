import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { authorizeMainAdmin, authorizeMerchant, MerchantAccessError } from "../src/epay-compat/merchant-access.ts";

it("requires fresh exact merchant authorization and an existing local binding", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE epay_merchant_bindings(main_merchant_id TEXT PRIMARY KEY, main_api_id TEXT, epay_merchant_id INTEGER); CREATE TABLE epay_merchant_accounts(merchant_id INTEGER PRIMARY KEY, enabled INTEGER); INSERT INTO epay_merchant_bindings VALUES ('a', 'api-a', 12), ('b', 'api-b', 13); INSERT INTO epay_merchant_accounts VALUES (12, 1), (13, 1)");
  const database = { read: <T>(operation: (sql: DatabaseSync) => T) => operation(db) };
  let calls = 0;
  const valid = async (input: string | URL | Request, init?: RequestInit) => {
    calls++;
    assert.equal(new URL(String(input)).searchParams.get("merchantId"), "a");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    return Response.json({ ok: true, merchantId: "a", apiId: "api-a", role: "member" });
  };
  const options = { origin: "http://127.0.0.1:8787", cookie: "session=fixture", merchantId: "a", database, fetch: valid as typeof fetch };
  try {
    assert.deepEqual(await authorizeMerchant(options), { merchantId: "a", role: "member", epayMerchantId: 12, mainApiId: "api-a" });
    await authorizeMerchant(options);
    assert.equal(calls, 2);
    await assert.rejects(authorizeMerchant({ ...options, fetch: async () => Response.json({ ok: true, merchantId: "a", apiId: "api-b", role: "member" }) }), (error: unknown) => error instanceof MerchantAccessError && error.code === "invalid_binding");
    await assert.rejects(authorizeMerchant({ ...options, fetch: async () => Response.json({ ok: true, merchantId: "a", role: "member" }) }), (error: unknown) => error instanceof MerchantAccessError && error.code === "invalid_binding");
    await assert.rejects(authorizeMerchant({ ...options, fetch: async () => Response.json({ ok: true, merchantId: "b", role: "admin" }) }), (error: unknown) => error instanceof MerchantAccessError && error.code === "forbidden");
    await assert.rejects(authorizeMerchant({ ...options, fetch: async () => new Response("", { status: 401 }) }), (error: unknown) => error instanceof MerchantAccessError && error.code === "unauthenticated");
    await assert.rejects(authorizeMerchant({ ...options, fetch: async () => new Response("", { status: 404 }) }), (error: unknown) => error instanceof MerchantAccessError && error.code === "forbidden");
    await assert.rejects(authorizeMerchant({ ...options, origin: "http://example.test" }), (error: unknown) => error instanceof MerchantAccessError && error.code === "unavailable");
    await assert.rejects(authorizeMerchant({ ...options, cookie: "session=x\r\nX-Forged: yes" }), (error: unknown) => error instanceof MerchantAccessError && error.code === "unauthenticated");
    db.exec("UPDATE epay_merchant_accounts SET enabled = 0 WHERE merchant_id = 12");
    await assert.rejects(authorizeMerchant(options), (error: unknown) => error instanceof MerchantAccessError && error.code === "invalid_binding");
  } finally { db.close(); }
});

it("requires a fresh main-site administrator identity for an auditable actor", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE epay_merchant_bindings(main_merchant_id TEXT PRIMARY KEY, main_api_id TEXT, epay_merchant_id INTEGER); CREATE TABLE epay_merchant_accounts(merchant_id INTEGER PRIMARY KEY, enabled INTEGER); INSERT INTO epay_merchant_bindings VALUES ('a', 'api-a', 12); INSERT INTO epay_merchant_accounts VALUES (12, 1)");
  const database = { read: <T>(operation: (sql: DatabaseSync) => T) => operation(db) };
  const options = { origin: "http://127.0.0.1:8787", cookie: "session=fixture", merchantId: "a", database };
  const response = (role: string, userId?: unknown) => async () => Response.json({ ok: true, merchantId: "a", apiId: "api-a", role, ...(userId === undefined ? {} : { userId }) });
  try {
    assert.deepEqual(await authorizeMainAdmin({ ...options, fetch: response("admin", "admin-1") }), { merchantId: "a", role: "admin", userId: "admin-1", epayMerchantId: 12, mainApiId: "api-a" });
    for (const fetch of [response("member", "member-1"), response("admin"), response("admin", " "), response("admin", "bad\nactor")]) {
      await assert.rejects(authorizeMainAdmin({ ...options, fetch }), MerchantAccessError);
    }
    db.exec("UPDATE epay_merchant_accounts SET enabled=0 WHERE merchant_id=12");
    await assert.rejects(authorizeMainAdmin({ ...options, fetch: response("admin", "admin-1") }), MerchantAccessError);
  } finally { db.close(); }
});

it("fails closed on large and malformed upstream responses", async () => {
  const db = new DatabaseSync(":memory:");
  const database = { read: <T>(operation: (sql: DatabaseSync) => T) => operation(db) };
  const options = { origin: "http://127.0.0.1:8787", cookie: "s=x", merchantId: "a", database };
  try {
    await assert.rejects(authorizeMerchant({ ...options, fetch: async () => new Response("x".repeat(5000), { headers: { "content-type": "application/json" } }) }), MerchantAccessError);
    await assert.rejects(authorizeMerchant({ ...options, fetch: async () => Response.json({ ok: true, merchantId: "a", role: "superadmin" }) }), MerchantAccessError);
    await assert.rejects(authorizeMerchant({ ...options, fetch: async () => Response.json({ ok: true, merchantId: "a", role: ["admin"] }) }), MerchantAccessError);
  } finally { db.close(); }
});
