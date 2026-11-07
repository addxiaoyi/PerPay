import assert from "node:assert/strict";
import { it } from "node:test";
import { balanceFixture } from "./epay-live-balance-fixture.ts";
import { createMainMerchantConsole } from "../src/epay-compat/main-merchant-console.ts";

it("separates merchant and administrator data, retains original records, and reports real daily totals", async () => {
  const f = await balanceFixture();
  const now = Date.parse("2026-11-06T09:00:00Z");
  let revoked = false;
  const identityFetch: typeof fetch = async (input, init) => {
    const id = new URL(String(input)).searchParams.get("merchantId"), cookie = new Headers(init?.headers).get("cookie");
    if (!cookie || revoked) return Response.json({ ok: false }, { status: 401 });
    if (cookie === "owner" && id !== "main-1") return Response.json({ ok: false }, { status: 403 });
    return Response.json({ ok: true, merchantId: id, apiId: id === "main-1" ? "api-1" : "api-2", userId: cookie, role: cookie === "admin" ? "admin" : "owner" });
  };
  const app = createMainMerchantConsole({ database: f.db, masterKey: f.key, identityOrigin: "http://127.0.0.1:8787", publicOrigin: "https://gateway.example", identityFetch, allowAdministration: true, clock: () => now });
  const get = (kind: string, scope = "merchant", cookie = "owner", more = "") => app.request(`/portal/${kind}?merchantId=main-1&scope=${scope}${more}`, { headers: { cookie } });
  try {
    f.db.write(sql => sql.prepare("UPDATE epay_orders SET paid_at=?,updated_at=?").run(now, now));
    assert.equal((await get("overview", "admin", "owner")).status, 403);
    const own = await get("overview"); assert.equal(own.status, 200);
    const ownBody = await own.json() as { data: { today: { amountCents: number }; merchants: Array<{ enabled: boolean }> } };
    assert.equal(ownBody.data.today.amountCents, 1000); assert.equal(ownBody.data.merchants.length, 1);
    assert.equal(ownBody.data.merchants[0]?.enabled, true);
    const all = await get("overview", "admin", "admin"); assert.equal(all.status, 200);
    const allBody = await all.json() as { data: { today: { amountCents: number }; merchants: unknown[] } };
    assert.equal(allBody.data.today.amountCents, 3000); assert.equal(allBody.data.merchants.length, 3);
    assert.equal((await get("orders", "merchant", "owner", "&targetMerchantId=main-2")).status, 403);
    const orders = await get("orders"); assert.equal(orders.status, 200);
    assert.doesNotMatch(await orders.text(), /legacy-2|Two|nonce|ciphertext|apiSecret/);
    const filtered = await get("orders", "admin", "admin", "&targetMerchantId=main-2&search=legacy-2");
    const filteredBody = await filtered.json() as { data: { total: number; records: Array<{ id: string }> } };
    assert.equal(filteredBody.data.total, 1); assert.equal(filteredBody.data.records[0]?.id, "legacy-2");
    for (const kind of ["notifications", "ledger", "refunds", "settlements"]) assert.equal((await get(kind)).status, 200, kind);
    assert.equal((await get("system")).status, 403);
    assert.equal((await get("system", "admin", "admin")).status, 200);
    assert.equal((await get("overview", "merchant", "owner", "&days=999")).status, 400);
    revoked = true; assert.equal((await get("orders", "admin", "admin")).status, 401);
    assert.equal(Number(f.db.read(sql => sql.prepare("SELECT count(*) n FROM epay_balance_ledger").get()?.n)), 0);
  } finally { f.close(); }
});
