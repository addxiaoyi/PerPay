import { serve } from "@hono/node-server";
import { test, expect } from "@playwright/test";
import { createServer } from "node:net";

import { createPreviewDemo } from "../scripts/preview-demo.ts";

test("admin navigation and checkout links stay under the configured mount", async ({ page }) => {
  test.setTimeout(180_000);
  const probe = createServer();
  await new Promise<void>((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("No loopback port available");
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));

  const demo = await createPreviewDemo({ port: address.port, basePath: "/pay" });
  const server = serve({ fetch: demo.app.fetch, hostname: "127.0.0.1", port: address.port });
  const failed: string[] = [];
  const misplaced: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("response", response => {
    const url = new URL(response.url());
    const offlineUpdate = url.pathname === "/pay/api/admin/v1/system/update" && response.status() === 503;
    if (url.origin === demo.origin && response.status() >= 400 && !offlineUpdate) failed.push(`${response.status()} ${url.pathname}`);
  });
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.origin === demo.origin && /^\/(?:admin|api|checkout)(?:\/|$)/.test(url.pathname)) misplaced.push(url.pathname);
  });
  await page.route("**/*", route => new URL(route.request().url()).origin === demo.origin ? route.continue() : route.abort("blockedbyclient"));
  try {
    const login = await page.request.post(`${demo.origin}/pay/api/admin/v1/session/login`, {
      headers: { origin: demo.origin }, data: { password: demo.password },
    });
    expect(login.status()).toBe(200);
    await page.goto(`${demo.origin}/pay/admin/`);
    await expect(page.locator("[data-content-width]")).toBeVisible();
    await page.goto(`${demo.origin}/pay/admin/orders/${demo.featured}`);
    await expect(page.locator("#main-content")).toBeVisible();
    const checkout = page.locator(`a[href$="/orders/${demo.featured}/checkout"]`);
    await expect(checkout).toHaveAttribute("href", `/pay/api/admin/v1/orders/${demo.featured}/checkout`);
    const checkoutResponse = await page.request.get(`${demo.origin}/pay/api/admin/v1/orders/${demo.featured}/checkout`, { maxRedirects: 0 });
    expect(checkoutResponse.status()).toBe(302);
    expect(checkoutResponse.headers().location).toMatch(/^\/pay\/checkout\//);
    await page.goto(`${demo.origin}/pay/admin/orders`);
    await expect(page.locator("#main-content")).toBeVisible();
    await page.goto(`${demo.origin}/pay/admin/notifications`);
    await expect(page.locator("#main-content")).toBeVisible();
    await page.goto(`${demo.origin}/pay/admin/sites/${demo.scenarios.sites.store}/orders`);
    await expect(page.locator("#main-content")).toBeVisible();
    await page.goto(demo.origin + checkoutResponse.headers().location);
    await expect(page.locator("#checkout-root")).toBeVisible();
    expect(misplaced).toEqual([]);
    expect(failed).toEqual([]);
    expect(pageErrors).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    demo.dispose();
  }
});
