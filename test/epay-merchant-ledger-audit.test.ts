import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { EPAY_COMPATIBILITY_SCHEMA_SQL } from "../src/epay-compat/schema.ts";
import { createMerchantWorkspace } from "../src/epay-compat/merchant-workspace.ts";

type AuditResponse = { data: { adjustments: Array<{ id: string }>; hasNext: boolean } };

function fixture() {
  const sql = new DatabaseSync(":memory:", { readBigInts: true });
  sql.exec(EPAY_COMPATIBILITY_SCHEMA_SQL);
  sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'A',100,1,0,0),(2,'B',200,1,0,0);
    INSERT INTO epay_merchant_bindings VALUES ('ba','api-a','a',1,0,0),('bb','api-b','b',2,0,0);
    INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,reason,actor_id,occurred_at) VALUES
      ('adjust-a',1,'manual_adjustment',-25,'申请提现','admin-a',100),
      ('adjust-b',2,'payment_manual_adjustment',-80,'other-reason','other-admin',200),
      ('payment-a',1,'payment_paid',100,'private-provider-record',NULL,300)`);
  const state = { role: "admin", userId: "admin-a", changedBinding: false, reads: 0 };
  const database = { read: <T>(operation: (db: DatabaseSync) => T) => {
    if (++state.reads === 2 && state.changedBinding) sql.exec("UPDATE epay_merchant_bindings SET main_api_id='new-api' WHERE main_merchant_id='a'");
    return operation(sql);
  } };
  const identityFetch: typeof fetch = async input => new URL(String(input)).searchParams.get("merchantId") === "a"
    ? Response.json({ ok: true, merchantId: "a", apiId: "api-a", role: state.role, ...(state.userId ? { userId: state.userId } : {}) })
    : new Response(null, { status: 403 });
  const app = createMerchantWorkspace({ database, identityOrigin: "http://127.0.0.1:8787", identityFetch });
  const request = (path = "/ledger-adjustments?merchantId=a", headers = { cookie: "session=a" }) => {
    state.reads = 0;
    return app.request(path, { headers });
  };
  const snapshot = () => JSON.stringify({ merchants: sql.prepare("SELECT * FROM epay_merchant_accounts ORDER BY merchant_id").all(), ledger: sql.prepare("SELECT * FROM epay_balance_ledger ORDER BY entry_id").all() }, (_key, value) => typeof value === "bigint" ? value.toString() : value);
  return { sql, state, request, snapshot };
}

it("shows adjustment actor, reason, exact deltas and time only to a current main-site admin", async () => {
  const { sql, state, request, snapshot } = fixture();
  try {
    const before = snapshot();
    const response = await request();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json() as AuditResponse;
    assert.deepEqual(body.data.adjustments, [{ id: "adjust-a", type: "manual_adjustment", availableDeltaCents: -25, frozenDeltaCents: 0, occurredAt: 100, reason: "申请提现", actorId: "admin-a", source: "legacy_epay" }]);
    assert.doesNotMatch(JSON.stringify(body), /other-reason|other-admin|private-provider-record/);
    for (const role of ["owner", "member"]) {
      state.role = role;
      const denied = await request();
      assert.equal(denied.status, 403);
      assert.doesNotMatch(await denied.text(), /admin-a|申请提现|adjust-a/);
    }
    state.role = "admin";
    state.userId = "";
    assert.equal((await request()).status, 403);
    state.userId = "admin-a";
    assert.equal((await request("/ledger-adjustments?merchantId=b")).status, 403);
    assert.equal((await request("/ledger-adjustments?merchantId=a", { cookie: "" })).status, 401);
    assert.equal((await request("/ledger-adjustments?merchantId=a&role=admin")).status, 400);
    assert.equal((await request("/ledger-adjustments?merchantId=a&merchantId=b")).status, 400);
    assert.equal(snapshot(), before);
  } finally { sql.close(); }
});

it("rechecks binding, refuses disabled merchants and rejects unsafe stored amounts", async () => {
  const { sql, state, request } = fixture();
  try {
    state.changedBinding = true;
    assert.equal((await request()).status, 403);
    state.changedBinding = false;
    sql.exec("UPDATE epay_merchant_bindings SET main_api_id='api-a' WHERE main_merchant_id='a'; UPDATE epay_merchant_accounts SET enabled=0 WHERE merchant_id=1");
    assert.equal((await request()).status, 403);
    sql.exec("UPDATE epay_merchant_accounts SET enabled=1 WHERE merchant_id=1; UPDATE epay_balance_ledger SET available_delta_cents=9007199254740992 WHERE entry_id='adjust-a'");
    assert.equal((await request()).status, 503);
  } finally { sql.close(); }
});

it("paginates equal-time adjustments without dropping or repeating records", async () => {
  const { sql, request } = fixture();
  try {
    const insert = sql.prepare("INSERT INTO epay_balance_ledger(entry_id,merchant_id,entry_type,available_delta_cents,occurred_at) VALUES (?,1,'manual_adjustment',1,400)");
    for (let n = 0; n < 22; n++) insert.run(`batch-${n.toString().padStart(2, "0")}`);
    const first = await (await request()).json() as AuditResponse;
    const second = await (await request("/ledger-adjustments?merchantId=a&page=2")).json() as AuditResponse;
    assert.equal(first.data.hasNext, true);
    assert.equal(second.data.hasNext, false);
    assert.equal(new Set([...first.data.adjustments, ...second.data.adjustments].map(entry => entry.id)).size, 23);
    assert.equal(first.data.adjustments[0]?.id, "batch-21");
    for (const page of ["0", "-1", "1.5", "100000", "1&page=2"]) assert.equal((await request(`/ledger-adjustments?merchantId=a&page=${page}`)).status, 400);
  } finally { sql.close(); }
});
