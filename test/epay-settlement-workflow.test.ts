import assert from "node:assert/strict";
import { it } from "node:test";
import { balanceFixture } from "./epay-live-balance-fixture.ts";
import { installBalanceOpenings, planBalanceOpenings } from "../src/epay-compat/balance-opening.ts";
import { readLiveBalance } from "../src/epay-compat/live-balance.ts";
import { requestSettlement, decideSettlement, listSettlements, auditNativeSettlements } from "../src/epay-compat/settlement-workflow.ts";
import { AppDatabase } from "../src/database/database.ts";
import { join } from "node:path";
import { Hono } from "hono";
import { createSettlementRoutes } from "../src/epay-compat/settlement-routes.ts";

const owner = { merchantId: "main-1", mainApiId: "api-1", epayMerchantId: 1, role: "owner" as const, userId: "owner" };
const admin = { ...owner, role: "admin" as const, userId: "admin" };
const now = 1_800_000_000_000;
async function fixture() {
  const f = await balanceFixture();
  f.db.write(sql => installBalanceOpenings(sql, f.cipher, planBalanceOpenings(sql, f.cipher, "a".repeat(64)), now));
  return { ...f, balance: () => f.db.read(sql => readLiveBalance(sql, 1)) };
}

it("freezes settlements once, rejects overspending and prevents merchants from approving payouts", async () => {
  const f = await fixture();
  const command = { requestId: "settlement-request-001", amountCents: 600, note: "提现" };
  try {
    const first = requestSettlement(f.db, owner, command, now + 1);
    assert.equal(f.balance().availableCents, 350);
    assert.equal(f.balance().frozenCents, 600);
    assert.equal(requestSettlement(f.db, owner, command, now + 2).id, first.id);
    assert.throws(() => requestSettlement(f.db, owner, { ...command, requestId: "settlement-request-002", amountCents: 351 }, now + 3), /insufficient/);
    assert.throws(() => requestSettlement(f.db, owner, { ...command, amountCents: 599 }, now + 3), /conflict/);
    assert.throws(() => decideSettlement(f.db, owner, first.id, { decision: "paid", reference: "receipt-1" }, now + 4), /administrator/);
    assert.throws(() => decideSettlement(f.db, { ...admin, epayMerchantId: 2 }, first.id, { decision: "paid", reference: "receipt-1" }, now + 4), /binding|merchant/);
    assert.equal(f.balance().frozenCents, 600);
    assert.throws(() => decideSettlement(f.db, admin, first.id, { decision: "paid", reference: "" }, now + 4));
    const paid = decideSettlement(f.db, admin, first.id, { decision: "paid", reference: "receipt-1" }, now + 4);
    assert.equal(paid.status, "PAID");
    assert.equal(f.balance().availableCents, 350);
    assert.equal(f.balance().frozenCents, 0);
    decideSettlement(f.db, admin, first.id, { decision: "paid", reference: "receipt-1" }, now + 5);
    assert.equal(f.balance().version, 2);
    assert.throws(() => decideSettlement(f.db, admin, first.id, { decision: "rejected", reference: "" }, now + 5), /processed/);
    assert.deepEqual(f.db.read(auditNativeSettlements), { settlements: 1, pending: 0, inconsistent: 0 });
  } finally { f.close(); }
});

it("releases rejected settlements atomically and preserves settlement records across reopen", async () => {
  const f = await fixture();
  try {
    const first = requestSettlement(f.db, owner, { requestId: "settlement-request-001", amountCents: 950, note: "取消提现" }, now + 1);
    f.db.write(sql => sql.exec("CREATE TRIGGER fail_settlement_audit BEFORE INSERT ON audit_events WHEN NEW.action='epay.settlement.rejected' BEGIN SELECT RAISE(ABORT,'audit failure'); END"));
    assert.throws(() => decideSettlement(f.db, admin, first.id, { decision: "rejected", reference: "资料有误" }, now + 2), /audit failure/);
    assert.equal(f.balance().frozenCents, 950);
    assert.equal(listSettlements(f.db, owner, 1).settlements[0]?.status, "PENDING");
    f.db.write(sql => sql.exec("DROP TRIGGER fail_settlement_audit"));
    decideSettlement(f.db, admin, first.id, { decision: "rejected", reference: "资料有误" }, now + 2);
    assert.equal(f.balance().availableCents, 950);
    assert.equal(f.balance().frozenCents, 0);
    assert.deepEqual(f.db.read(auditNativeSettlements), { settlements: 1, pending: 0, inconsistent: 0 });
    f.db.write(sql => {
      assert.throws(() => sql.exec("DELETE FROM epay_native_settlements"), /immutable/);
      assert.throws(() => sql.exec("UPDATE epay_native_settlements SET amount_cents=1"), /immutable/);
    });
    f.db.close();
    const reopened = await AppDatabase.open(join(f.directory, "db.sqlite"), { masterKey: f.key });
    try {
      assert.equal(listSettlements(reopened, owner, 1).settlements[0]?.status, "REJECTED");
      assert.equal(reopened.read(sql => readLiveBalance(sql, 1)).availableCents, 950);
      assert.deepEqual(reopened.read(auditNativeSettlements), { settlements: 1, pending: 0, inconsistent: 0 });
    } finally { reopened.close(); }
  } finally { f.close(); }
});

it("rejects forged settlement approvals and CSRF before changing the ledger", async () => {
  const f = await fixture();
  const routes = createSettlementRoutes({ database: f.db, masterKey: f.key, enabled: true, clock: () => now + 10,
    identityOrigin: "http://127.0.0.1:8787", publicOrigin: "https://gateway.example", identityFetch: async (input, init) => {
      const cookie = new Headers(init?.headers).get("cookie");
      if (!cookie) return Response.json({ ok: false }, { status: 401 });
      if (new URL(String(input)).searchParams.get("merchantId") !== "main-1") return Response.json({ ok: false }, { status: 403 });
      return Response.json({ ok: true, merchantId: "main-1", apiId: "api-1", role: cookie === "admin" ? "admin" : "owner", userId: cookie });
    } });
  const root = "/api/merchant/epay/settlements", app = new Hono().route(root, routes);
  try {
    assert.equal((await app.request(root + "?merchantId=main-1")).status, 401);
    const session = await app.request(root + "/session?merchantId=main-1", { headers: { cookie: "owner" } });
    const token = (await session.json() as { data: { csrfToken: string } }).data.csrfToken;
    const headers = { cookie: "owner", origin: "https://gateway.example", "x-csrf-token": token, "content-type": "application/json" };
    const body = JSON.stringify({ requestId: "settlement-http-001", amountCents: 600, note: "提现" });
    assert.equal((await app.request(root + "?merchantId=main-1", { method: "POST", headers: { ...headers, origin: "https://evil.example" }, body })).status, 403);
    assert.equal((await app.request(root + "?merchantId=main-1", { method: "POST", headers, body: JSON.stringify({ requestId: "settlement-http-001", amountCents: 600, note: "提现", allowNegative: true }) })).status, 400);
    assert.equal(f.balance().availableCents, 950);
    const accepted = await app.request(root + "?merchantId=main-1", { method: "POST", headers, body });
    assert.equal(accepted.status, 201);
    const settlement = (await accepted.json() as { data: { id: string } }).data;
    const decision = { method: "POST", headers, body: JSON.stringify({ decision: "paid", reference: "synthetic-receipt" }) };
    assert.equal((await app.request(`${root}/${settlement.id}/decision?merchantId=main-1`, decision)).status, 403);
    assert.equal((await app.request(`${root}/${settlement.id}/decision?merchantId=main-2`, decision)).status, 403);
    assert.equal(f.balance().frozenCents, 600);
    const adminSession = await app.request(root + "/session?merchantId=main-1", { headers: { cookie: "admin" } });
    const adminToken = (await adminSession.json() as { data: { csrfToken: string } }).data.csrfToken;
    const completed = await app.request(`${root}/${settlement.id}/decision?merchantId=main-1`, { ...decision, headers: { ...headers, cookie: "admin", "x-csrf-token": adminToken } });
    assert.equal(completed.status, 200, await completed.clone().text());
    assert.equal(f.balance().availableCents, 350);
    assert.equal(f.balance().frozenCents, 0);
  } finally { f.close(); }
});
