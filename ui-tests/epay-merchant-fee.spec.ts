import { expect, test } from "@playwright/test";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createServer } from "vite";
import { resolve } from "node:path";

for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  test(`merchant fee editing at ${viewport.width}px`, async ({ page }, testInfo) => {
    const root = resolve(process.cwd(), "web");
    const server = await createServer({ root, configFile: false, plugins: [react(), tailwindcss()], resolve: { alias: { "@": resolve(root, "src") } }, server: { host: "127.0.0.1", port: 0 } });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("fixture server unavailable");
    let fee = 500, version = 1;
    let history = false;
    try {
      await page.setViewportSize(viewport);
      await page.context().addCookies([{ name: "perpay_csrf", value: "fixture-token", url: `http://127.0.0.1:${address.port}` }]);
      await page.route("**/api/admin/v1/epay/merchants**", async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path.endsWith("/history")) return route.fulfill({ json: { data: { changes: history ? [{ sequence: 1, occurredAt: 1800000000000, actor: "管理员", oldFeeBps: 500, newFeeBps: 350, reason: "合同调整" }] : [], nextBefore: null } } });
        if (request.method() === "POST") {
          expect(request.headers()["x-csrf-token"]).toBe("fixture-token");
          if (version === 2) return route.fulfill({ status: 409, json: { error: "fee_conflict" } });
          expect(request.postDataJSON()).toEqual({ expectedFeeBps: 500, expectedVersion: 1, feeBps: 350, reason: "合同调整" });
          fee = 350; version = 2; history = true;
          return route.fulfill({ json: { data: { merchantId: 1, feeBps: fee, version } } });
        }
        return route.fulfill({ json: { data: { merchants: [{ merchantId: 1, name: "测试商户", enabled: true, feeBps: fee, version }], nextAfter: null } } });
      });
      await page.goto(`http://127.0.0.1:${address.port}/test/fixtures/epay-merchant-fee.html`);
      await expect(page.getByText("测试商户")).toBeVisible();
      await page.getByRole("button", { name: "管理费率" }).click();
      await page.getByLabel("新费率（%）").fill("3.50");
      await page.getByLabel("变更原因").fill("合同调整");
      await page.getByRole("button", { name: "保存费率" }).click();
      await expect(page.getByRole("status").filter({ hasText: "费率已更新" })).toBeVisible();
      await expect(page.getByText("合同调整")).toBeVisible();
      await expect(page.getByRole("columnheader", { name: "商户" })).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`merchant-fee-${viewport.width}.png`), fullPage: true });
      await page.getByLabel("新费率（%）").fill("50.01");
      await page.getByLabel("变更原因").fill("并发修改");
      await expect(page.getByRole("button", { name: "保存费率" })).toBeDisabled();
      await page.getByLabel("新费率（%）").fill("3.51");
      await page.getByRole("button", { name: "保存费率" }).click();
      await expect(page.getByRole("alert")).toContainText("其他管理员修改");
    } finally { await server.close(); }
  });
}
