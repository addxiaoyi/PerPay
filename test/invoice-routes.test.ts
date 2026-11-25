import assert from "node:assert/strict";
import { it } from "node:test";
import { Hono } from "hono";
import { balanceFixture } from "./epay-live-balance-fixture.ts";
import { createInvoiceRoutes } from "../src/invoices/routes.ts";
import type { InvoiceProvider } from "../src/invoices/model.ts";

const NOW = 1_800_000_000_000;
const ROOT = "/tax-invoices";
const profile = { expectedVersion: 0, subMchId: "1900000001", sellerName: "Synthetic seller", sellerTaxId: "91310000123456789A",
  billingPersonId: "synthetic-biller", itemName: "Software service", taxCode: "3040201000000000000", taxRateBps: 600, enabled: false };

it("keeps unconfigured invoicing unavailable while allowing scoped administrator preparation", async () => {
  const fixture = await balanceFixture();
  let revoked = false;
  const app = new Hono().route(ROOT, createInvoiceRoutes({ database: fixture.db, masterKey: fixture.key, enabled: true,
    publicOrigin: "https://gateway.example", identityOrigin: "http://127.0.0.1:8787", clock: () => NOW,
    identityFetch: async (input, init) => {
      const role = new Headers(init?.headers).get("cookie");
      if (!role || revoked) return Response.json({ ok: false }, { status: 401 });
      if (new URL(String(input)).searchParams.get("merchantId") !== "main-1") return Response.json({ ok: false }, { status: 403 });
      return Response.json({ ok: true, merchantId: "main-1", apiId: "api-1", role, userId: role });
    } }));
  type Session = { providerConfigured: boolean; canConfigure: boolean; canRequest: boolean; csrfToken: string; profile: typeof profile };
  const session = async (cookie: string) => (await (await app.request(`${ROOT}/session?merchantId=main-1`, { headers: { cookie } })).json() as { data: Session }).data;
  const mutate = (path: string, cookie: string, token: string, body: unknown, origin = "https://gateway.example") => app.request(`${ROOT}/${path}?merchantId=main-1`, {
    method: "POST", headers: { cookie, origin, "content-type": "application/json", "x-csrf-token": token }, body: JSON.stringify(body),
  });
  try {
    const admin = await session("admin");
    assert.equal(admin.providerConfigured, false);
    assert.equal(admin.canConfigure, true);
    assert.equal(admin.canRequest, false);
    assert.equal((await mutate("profile", "admin", admin.csrfToken, profile)).status, 200);
    const owner = await session("owner"), member = await session("member");
    assert.equal(owner.profile.sellerName, profile.sellerName);
    assert.equal(owner.canConfigure, false);
    assert.equal(member.csrfToken, null);
    assert.equal((await mutate("profile", "owner", owner.csrfToken, profile)).status, 403);
    assert.equal((await mutate("profile", "admin", admin.csrfToken, profile, "https://evil.example")).status, 403);
    assert.equal((await mutate("profile", "admin", admin.csrfToken, { ...profile, expectedVersion: 1, enabled: true })).status, 503);
    assert.equal((await mutate("applications", "owner", owner.csrfToken, {})).status, 503);
    assert.equal((await app.request(`${ROOT}?merchantId=main-2`, { headers: { cookie: "owner" } })).status, 403);
    assert.equal((await app.request(`${ROOT}?merchantId=main-1&page=1&page=2`, { headers: { cookie: "owner" } })).status, 403);
    const listing = await app.request(`${ROOT}?merchantId=main-1`, { headers: { cookie: "member" } });
    assert.equal(listing.status, 200);
    assert.deepEqual((await listing.json() as { data: { invoices: unknown[] } }).data.invoices, []);
    revoked = true;
    assert.equal((await mutate("profile", "admin", admin.csrfToken, profile)).status, 401);
  } finally { fixture.close(); }
});

it("returns billing people after scoped authorization without enabling the merchant automatically", async () => {
  const fixture = await balanceFixture();
  const provider: InvoiceProvider = {
    authorize: async seller => ({ authorized: true, subMchId: seller.subMchId, billingPersonIds: ["registered-biller"] }),
    invite: async () => ({ url: "https://wxacurl.cn/?isolated-fixture" }),
    issue: async () => { throw new Error("this route test must not issue an invoice"); },
    query: async () => ({ status: "UNKNOWN" }), download: async () => { throw new Error("no invoice exists"); },
  };
  const app = new Hono().route(ROOT, createInvoiceRoutes({ database: fixture.db, masterKey: fixture.key, enabled: true, provider,
    publicOrigin: "https://gateway.example", identityOrigin: "http://127.0.0.1:8787", clock: () => NOW,
    identityFetch: async (_, init) => {
      const role = new Headers(init?.headers).get("cookie");
      return Response.json({ ok: true, merchantId: "main-1", apiId: "api-1", role, userId: role });
    } }));
  try {
    const session = await (await app.request(`${ROOT}/session?merchantId=main-1`, { headers: { cookie: "admin" } })).json() as { data: { csrfToken: string } };
    const post = (path: string, body: unknown) => app.request(`${ROOT}/${path}?merchantId=main-1`, { method: "POST",
      headers: { cookie: "admin", origin: "https://gateway.example", "x-csrf-token": session.data.csrfToken, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post("profile", { ...profile, billingPersonId: "" })).status, 200);
    assert.equal((await post("invite", {})).status, 200);
    const checked = await (await post("authorization", {})).json() as { data: { billingPersonIds: string[]; profile: { enabled: boolean; version: number } } };
    assert.deepEqual(checked.data.billingPersonIds, ["registered-biller"]);
    assert.equal(checked.data.profile.enabled, false);
    const enabled = await post("profile", { ...profile, expectedVersion: checked.data.profile.version, billingPersonId: "registered-biller", enabled: true });
    assert.equal(enabled.status, 200);
    const current = await (await app.request(`${ROOT}/session?merchantId=main-1`, { headers: { cookie: "owner" } })).json() as { data: { canRequest: boolean } };
    assert.equal(current.data.canRequest, true);
  } finally { fixture.close(); }
});
