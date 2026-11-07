import { expect, test } from "@playwright/test";
import { serve } from "@hono/node-server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/http/app.ts";
import { createConfiguredHttpServices, HTTP_TEST_ADMIN_PASSWORD } from "../test/http-fixture.ts";

test("admin edits a fee through the real isolated backend and audit chain", async ({ page }) => {
  const directory = mkdtempSync(join(tmpdir(), "perpay-fee-e2e-"));
  let app: ReturnType<typeof createApp> | undefined;
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: request => app ? app.fetch(request) : new Response(null, { status: 503 }) });
  let services: Awaited<ReturnType<typeof createConfiguredHttpServices>> | undefined;
  let mainSessionActive = true;
  try {
    if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("isolated server unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    services = await createConfiguredHttpServices({ directory, publicUrl: origin, apiSecret: null, collectionCodePayload: "https://qr.alipay.com/test" });
    services.database.write(db => db.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,fee_rate_bps,created_at,updated_at)
      VALUES(1,'隔离商户',0,1,500,1,1);
      INSERT INTO epay_merchant_bindings VALUES('binding-1','api-1','main-1',1,1,1)`));
    const identityFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/merchant/access");
      expect(url.searchParams.get("merchantId")).toBe("main-1");
      if (!mainSessionActive || !new Headers(init?.headers).get("cookie")?.split("; ").includes("main_session=administrator")) return Response.json({ ok: false }, { status: 401 });
      return Response.json({ ok: true, merchantId: "main-1", apiId: "api-1", userId: "fixture-administrator", role: "admin" });
    };
    app = createApp({ ...services, config: { ...services.config, epayGateway: { mode: "live", callbackDelivery: false } }, startedAt: new Date(), merchantWorkspace: { identityOrigin: "http://127.0.0.1:8787", identityFetch } });
    expect((await page.request.get(`${origin}/api/admin/v1/epay/merchants`)).status()).toBe(401);
    const forged = await page.request.get(`${origin}/api/admin/v1/epay/merchants`, {
      headers: { cookie: "session=merchant; role=admin", "x-user-role": "admin", "x-admin": "true" },
    });
    expect(forged.status()).toBe(401);
    const login = await page.request.post(`${origin}/api/admin/v1/session/login`, { headers: { origin }, data: { password: HTTP_TEST_ADMIN_PASSWORD, remember_me: true } });
    expect(login.status()).toBe(200);
    const { data: { csrf_token: csrfToken } } = await login.json() as { data: { csrf_token: string } };
    expect((await page.request.get(`${origin}/api/admin/v1/epay/merchants`)).status()).toBe(401);
    await page.context().addCookies([{ name: "main_session", value: "administrator", url: origin }]);
    expect((await page.request.get(`${origin}/api/admin/v1/epay/merchants`)).status()).toBe(200);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/admin/merchants/main-1/fee`);
    await expect(page.getByRole("heading", { name: "费率与操作记录" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "隔离商户", exact: true })).toBeVisible();
    await page.getByLabel("新费率（%）").fill("3.50");
    await page.getByLabel("变更原因").fill("隔离测试");
    await page.getByRole("button", { name: "保存费率" }).click();
    await expect(page.getByLabel("新费率（%）")).toHaveValue("3.50");
    await expect(page.getByText("隔离测试")).toBeVisible();
    await expect(page.getByText("操作人 fixture-administrator")).toBeVisible();
    const state = services.database.read(db => ({
      fee: Number(db.prepare("SELECT fee_rate_bps FROM epay_merchant_accounts WHERE merchant_id=1").get()?.fee_rate_bps),
      audit: Number(db.prepare("SELECT count(*) AS n FROM audit_events WHERE action='epay.merchant_fee.updated' AND subject_id='1'").get()?.n),
    }));
    expect(state).toEqual({ fee: 350, audit: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const logout = await page.request.post(`${origin}/api/admin/v1/session/logout`, {
      headers: { origin, "x-csrf-token": csrfToken },
      data: {},
    });
    expect(logout.status()).toBe(204);
    expect((await page.request.get(`${origin}/api/admin/v1/epay/merchants`)).status()).toBe(401);
    mainSessionActive = false;
    expect((await page.request.get(`${origin}/api/merchant/epay/fee?merchantId=main-1`)).status()).toBe(401);
    await page.reload();
    await expect(page.getByLabel("新费率（%）")).toHaveCount(0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    services?.database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
