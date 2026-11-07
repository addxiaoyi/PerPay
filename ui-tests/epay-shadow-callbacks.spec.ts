import { expect, test } from "@playwright/test";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createServer } from "vite";
import { resolve } from "node:path";

for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  test(`shadow callbacks stay usable at ${viewport.width}px`, async ({ page }, testInfo) => {
    const root = resolve(process.cwd(), "test/fixtures/legacy-workspace");
    const server = await createServer({ root, configFile: false, plugins: [react(), tailwindcss()], define: { "process.env.NEXT_PUBLIC_BASE_PATH": JSON.stringify("/pay") }, server: { host: "127.0.0.1", port: 0, strictPort: false } });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("fixture server unavailable");
    try {
      await page.setViewportSize(viewport);
      await page.route("**/pay/api/merchant/shadow-callbacks?*", async (route) => {
        const query = new URL(route.request().url()).searchParams;
        expect(query.get("merchantId")).toBe("fixture-merchant");
        if (query.get("tradeNo") === "order-error") return route.fulfill({ status: 503 });
        const attempts = query.get("tradeNo") === "order-a" ? [{ id: "a", number: 1, method: "POST", outcome: "RETRY", httpStatus: 500, startedAt: 1_800_000_000_000, failureReason: "商户接口响应超时" }] : [];
        return route.fulfill({ json: { ok: true, data: { attempts, hasNext: false } } });
      });
      await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/shadow-callbacks.html`);
      const panel = page.getByRole("region", { name: "候选系统回调记录" });
      await panel.getByLabel("订单").selectOption("epay_order-a");
      await panel.getByRole("button", { name: "查询", exact: true }).click();
      await expect(panel.getByText("商户接口响应超时")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`shadow-callbacks-${viewport.width}.png`), fullPage: true });
      await panel.getByLabel("订单").selectOption("epay_order-b");
      await expect(panel.getByText("商户接口响应超时")).toHaveCount(0);
      await panel.getByRole("button", { name: "查询", exact: true }).click();
      await expect(panel.getByText("暂无候选回调记录。")).toBeVisible();
      await panel.getByLabel("订单").selectOption("epay_order-error");
      await panel.getByRole("button", { name: "查询", exact: true }).click();
      await expect(panel.getByRole("alert")).toHaveText("候选记录暂时无法查询。");
      await panel.getByLabel("订单").selectOption(`epay_${"x".repeat(64)}`);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally { await server.close(); }
  });
}

test("hides previous merchant callback results and late responses after switching", async ({ page }) => {
  const root = resolve(process.cwd(), "test/fixtures/legacy-workspace");
  const server = await createServer({ root, configFile: false, plugins: [react(), tailwindcss()], define: { "process.env.NEXT_PUBLIC_BASE_PATH": JSON.stringify("/pay") }, server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("fixture server unavailable");
  let release!: () => void;
  let received!: () => void;
  const waiting = new Promise<void>((resolve) => { received = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  try {
    await page.route("**/pay/api/merchant/shadow-callbacks?*", async (route) => {
      calls++;
      if (calls === 2) { received(); await gate; }
      await route.fulfill({ json: { ok: true, data: { attempts: [{ id: "private", number: 1, method: "POST", outcome: "RETRY", httpStatus: 500, startedAt: 1800000000000, failureReason: "private merchant evidence" }], hasNext: false } } });
    });
    await page.goto(`http://127.0.0.1:${address.port}/tests/fixtures/shadow-callbacks.html`);
    const panel = page.locator("section");
    const switchMerchant = page.getByRole("button", { name: "Switch merchant" });
    await panel.locator("select").selectOption("epay_order-a");
    await panel.locator("button").click();
    await expect(panel.getByText("private merchant evidence")).toBeVisible();
    await switchMerchant.click();
    await expect(panel.getByText("private merchant evidence")).toHaveCount(0);
    await switchMerchant.click();
    await panel.locator("button").click();
    await waiting;
    await switchMerchant.click();
    const response = page.waitForResponse((response) => response.url().includes("/api/merchant/shadow-callbacks?"));
    release();
    await response;
    await expect(panel.locator("select")).toBeEnabled();
    await expect(panel.locator("button")).toBeDisabled();
    await expect(panel.getByText("private merchant evidence")).toHaveCount(0);
    await expect(panel.locator("select")).toHaveValue("");
  } finally { release(); await server.close(); }
});
