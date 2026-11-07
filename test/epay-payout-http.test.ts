import assert from "node:assert/strict";
import { it } from "node:test";
import { Hono } from "hono";
import { balanceFixture } from "./epay-live-balance-fixture.ts";
import { createPayoutRoutes } from "../src/epay-compat/payout-routes.ts";

it("enforces live identity, CSRF, ownership and disabled channels at payout HTTP boundaries", async () => {
  const f = await balanceFixture(), now = 1_800_000_000_000;
  let downgraded = false;
  const app = new Hono().route("/payouts", createPayoutRoutes({ database: f.db, masterKey: f.key, enabled: true, clock: () => now,
    identityOrigin: "http://127.0.0.1:8787", publicOrigin: "https://gateway.example", identityFetch: async (input, init) => {
      const cookie = new Headers(init?.headers).get("cookie");
      if (!["owner", "admin", "member"].includes(cookie ?? "")) return Response.json({ ok: false }, { status: 401 });
      if (new URL(String(input)).searchParams.get("merchantId") !== "main-1") return Response.json({ ok: false }, { status: 403 });
      return Response.json({ ok: true, merchantId: "main-1", apiId: "api-1", role: downgraded ? "member" : cookie, userId: cookie });
    } }));
  const session = async (cookie: string) => {
    const reply = await app.request("/payouts/session?merchantId=main-1", { headers: { cookie } });
    assert.equal(reply.status, 200);
    return (await reply.json() as { data: { csrfToken: string; canRequest: boolean; channels: Array<{ enabled: boolean }> } }).data;
  };
  try {
    assert.equal((await app.request("/payouts/accounts?merchantId=main-1")).status, 401);
    const owner = await session("owner"), admin = await session("admin");
    assert.equal(owner.canRequest, false); assert.ok(owner.channels.every(channel => !channel.enabled));
    const headers = { cookie: "owner", origin: "https://gateway.example", "x-csrf-token": owner.csrfToken, "content-type": "application/json" };
    const body = JSON.stringify({ requestId: "account-request-001", kind: "alipay", account: "test@example.test", holderName: "合成账户" });
    const path = "/payouts/accounts?merchantId=main-1";
    assert.equal((await app.request(path, { method: "POST", headers: { ...headers, origin: "https://evil.example" }, body })).status, 403);
    assert.equal((await app.request(path, { method: "POST", headers: { ...headers, "x-csrf-token": "forged" }, body })).status, 403);
    const saved = await app.request(path, { method: "POST", headers, body }); assert.equal(saved.status, 201);
    const { data: account } = await saved.json() as { data: { id: string } };
    const review = `/payouts/accounts/${account.id}/review?merchantId=main-1`;
    const decision = JSON.stringify({ decision: "approve", reference: "ownership verified" });
    assert.equal((await app.request(review, { method: "POST", headers, body: decision })).status, 403);
    assert.equal((await app.request(`/payouts/accounts/${account.id}/reveal?merchantId=main-1`, { method: "POST", headers, body: "{}" })).status, 403);
    assert.equal((await app.request("/payouts/accounts?merchantId=main-2", { headers })).status, 403);
    const adminHeaders = { ...headers, cookie: "admin", "x-csrf-token": admin.csrfToken };
    assert.equal((await app.request(review, { method: "POST", headers: adminHeaders, body: decision })).status, 200);
    const create = await app.request("/payouts/requests?merchantId=main-1", { method: "POST", headers, body: JSON.stringify({ requestId: "payout-request-001", accountId: account.id, amountCents: 100 }) });
    assert.equal(create.status, 503);
    const bodyStream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from('{"decision":"revoke",')); setTimeout(() => { downgraded = true; controller.enqueue(Buffer.from('"reference":"stale administrator"}')); controller.close(); }, 20); } });
    const delayed = new Request(`http://localhost${review}`, { method: "POST", headers: adminHeaders, body: bodyStream, duplex: "half" } as RequestInit);
    assert.equal((await app.request(delayed)).status, 403, "administrator downgraded while body arrives cannot revoke the account");
    const tables = f.db.read(sql => ["epay_native_settlements", "epay_payouts", "epay_balance_ledger"].map(table => Number(sql.prepare(`SELECT count(*) n FROM ${table}`).get()?.n)));
    assert.deepEqual(tables, [0, 0, 0]);
  } finally { f.close(); }
});
