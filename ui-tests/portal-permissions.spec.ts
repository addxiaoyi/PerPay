import { expect, test } from "@playwright/test";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createServer } from "vite";
import { resolve } from "node:path";

test.use({ actionTimeout: 10000 });
for (const role of ["owner", "member"] as const) for (const width of [390, 1280]) {
  test(`${role} sees only its merchant at ${width}px and cannot enter admin or peer routes`, async ({ page }) => {
    const root = resolve("web"), server = await createServer({ root, configFile: false, plugins: [react(), tailwindcss()], resolve: { alias: { "@": resolve(root, "src") } }, server: { host: "127.0.0.1", port: 0, hmr: false } });
    await server.listen(); const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("portal fixture unavailable");
    const base = `http://127.0.0.1:${address.port}`, adminRequests: string[] = [];
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.route("**/pay/**", async route => {
        const url = new URL(route.request().url());
        if (route.request().resourceType() === "document") {
          const mode = url.pathname.startsWith("/pay/admin") ? "admin" : "merchant";
          return route.fulfill({ contentType: "text/html", body: await server.transformIndexHtml(url.pathname, `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="perpay-admin-base" content="/pay/admin/"><meta name="perpay-router-base" content="/pay/${mode}/"><meta name="perpay-portal" content="${mode}"><script src="/theme.js"></script></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`) });
        }
        if (!url.pathname.includes("/api/merchant/epay/")) return route.continue();
        const endpoint = url.pathname.split("/epay/")[1];
        if (url.searchParams.get("scope") === "admin" || /management|members|adjustments|fee\/history|portal\/system/.test(endpoint ?? "")) adminRequests.push(endpoint ?? "");
        if (endpoint === "access") return route.fulfill({ json: { ok: true, data: { userId: "ordinary-user", merchants: [{ merchantId: "own", epayMerchantId: 1, name: "我的商户", role, feeBps: 500, version: 1 }], administrationEnabled: true, collectionChannels: ["wechat_native"] } } });
        if (url.searchParams.get("merchantId") !== "own" || url.searchParams.get("scope") === "admin") return route.fulfill({ status: 403, json: { ok: false, error: "forbidden" } });
        return route.fulfill({ json: { ok: true, data: { records: [{ id: "my-order", merchantId: "own", epayMerchantId: 1, merchantName: "我的商户", name: "自己的订单", source: "epay", amountCents: 100, status: "paid", createdAt: 1_800_000_000_000 }], total: 1, hasNext: false } } });
      });
      await page.goto(`${base}/pay/merchant/orders`);
      await expect(page.getByText("自己的订单", { exact: true })).toBeVisible();
      if (width < 768) await page.getByRole("button", { name: "切换导航" }).click();
      await expect(page.getByRole("navigation", { name: "商户导航" })).toBeVisible();
      for (const name of ["进入管理端", "商户管理", "全部订单", "全部通知", "全局待处理", "退款审批", "提现审批", "运行状态", "余额调整", "成员权限"]) {
        await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0);
      }
      await expect(page.getByRole("combobox", { name: "当前商户" })).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText("其他商户");
      await page.goto(`${base}/pay/merchant/orders?merchantId=peer`);
      await expect(page.getByText("请选择可访问的商户", { exact: true })).toBeVisible();
      await expect(page.getByText("自己的订单", { exact: true })).toHaveCount(0);
      await page.goto(`${base}/pay/admin/merchants`);
      await expect(page.getByText("无管理员权限", { exact: true })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "管理员导航" })).toHaveCount(0);
      expect(adminRequests).toEqual([]);
    } finally { await server.close(); }
  });
}

test("a restored tab hides old administrator content until fresh permissions arrive", async ({ page }) => {
  const root = resolve("web"), server = await createServer({ root, configFile: false, plugins: [react(), tailwindcss()], resolve: { alias: { "@": resolve(root, "src") } }, server: { host: "127.0.0.1", port: 0, hmr: false } });
  await server.listen(); const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("portal fixture unavailable");
  let ordinary = false, waiting = false, release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await page.route("**/pay/**", async route => {
      const url = new URL(route.request().url());
      if (route.request().resourceType() === "document") return route.fulfill({ contentType: "text/html", body: await server.transformIndexHtml(url.pathname, '<html lang="zh-CN"><head><meta name="perpay-admin-base" content="/pay/admin/"><meta name="perpay-router-base" content="/pay/admin/"><meta name="perpay-portal" content="admin"></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>') });
      if (!url.pathname.includes("/api/merchant/epay/")) return route.continue();
      if (url.pathname.endsWith("/access")) {
        if (ordinary) { waiting = true; await gate; }
        return route.fulfill({ json: { ok: true, data: { userId: ordinary ? "ordinary-user" : "administrator", administrationEnabled: true,
          merchants: (ordinary ? [1] : [1, 2]).map(id => ({ merchantId: `merchant-${id}`, epayMerchantId: id, role: ordinary ? "owner" : "admin", name: id === 1 ? "自己的商户" : "其他商户的保密名称", feeBps: 500, version: 1 })) } } });
      }
      return route.fulfill({ json: { ok: true, data: { merchants: [{ merchantId: "merchant-2", epayMerchantId: 2, name: "其他商户的保密名称", enabled: true, feeBps: 500, availableCents: 100, frozenCents: 0 }] } } });
    });
    await page.goto(`http://127.0.0.1:${address.port}/pay/admin/merchants`);
    await expect(page.getByText("其他商户的保密名称", { exact: true })).toBeVisible();
    ordinary = true;
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await expect.poll(() => waiting).toBe(true);
    await expect(page.getByText("其他商户的保密名称", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("navigation", { name: "管理员导航" })).toHaveCount(0);
    release!();
    await expect(page.getByText("无管理员权限", { exact: true })).toBeVisible();
  } finally { release?.(); await server.close(); }
});
