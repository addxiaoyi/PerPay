import { expect, test } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { viteFixtureCache } from "./vite-cache";
import { resolve } from "node:path";

test("hides old merchant orders and rejects late responses when switching", async ({ page }) => {
  const root = resolve(process.cwd(), "test/fixtures/legacy-workspace");
  const server = await createServer({ root, cacheDir: viteFixtureCache("epay-shadow-orders-isolation"), configFile: false, plugins: [react()], define: { "process.env.NEXT_PUBLIC_BASE_PATH": JSON.stringify("/pay") }, server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("fixture server unavailable");
  let release!: () => void;
  let received!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const waiting = new Promise<void>((resolve) => { received = resolve; });
  let calls = 0;
  try {
    await page.route("**/pay/api/merchant/shadow-orders?*", async (route) => {
      calls++;
      if (calls === 2) { received(); await gate; }
      await route.fulfill({ json: { ok: true, data: { scope: "epay_only", invoiceAvailable: false, orders: [{ id: "epay_a", merchantOrderId: "private-order", name: "private item", amount: "1.00", status: "paid", createdAt: "2026-01-01T00:00:00.000Z" }], pageInfo: { page: 1, totalPages: 1, total: 1, hasNext: false, hasPrevious: false } } } }).catch(() => {});
    });
    await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/shadow-orders.html`);
    const panel = page.locator("section");
    const switchMerchant = page.getByRole("button", { name: "Switch merchant" });
    await panel.locator("button").first().click();
    await expect(panel.getByText("private-order")).toBeVisible();
    await switchMerchant.click();
    await expect(panel.getByText("private-order")).toHaveCount(0);
    await switchMerchant.click();
    await panel.locator("button").first().click();
    await waiting;
    await switchMerchant.click();
    release();
    await expect(panel.locator("button").first()).toBeEnabled();
    await expect(panel.getByText("private-order")).toHaveCount(0);
  } finally { release(); await server.close(); }
});
