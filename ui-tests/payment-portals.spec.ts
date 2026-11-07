import { expect, test } from "@playwright/test";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createServer } from "vite";
import { resolve } from "node:path";
test.use({ actionTimeout: 10000 });

for (const mode of ["admin", "merchant"] as const) for (const width of [320, 390, 1440]) {
  test(`${mode} portal uses separate navigation and scoped records at ${width}px`, async ({ page }, testInfo) => {
    const root = resolve("web"), server = await createServer({ root, configFile: false, plugins: [react(), tailwindcss()], resolve: { alias: { "@": resolve(root, "src") } }, server: { host: "127.0.0.1", port: 0, hmr: false } });
    await server.listen(); const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("portal fixture unavailable");
    const origin = `http://127.0.0.1:${address.port}`, errors: string[] = [], requests: string[] = [];
    let role = "admin";
    page.on("pageerror", error => errors.push(error.message));
    const merchants = [1, 2].map(id => ({ merchantId: `main-${id}`, epayMerchantId: id, name: id === 1 ? "星光社区" : "云端商店", role, feeBps: 500, version: 1, enabled: true, availableCents: 65040, frozenCents: 0, reconciled: true }));
    const trend = Array.from({ length: 30 }, (_, index) => ({ date: `2026-10-${String(index + 1).padStart(2, "0")}`, amountCents: (index % 6 + 1) * 10000, confirmed: index % 6 + 1, created: index % 8 + 2 }));
    try {
      await page.setViewportSize({ width, height: 1000 });
      await page.route("**/pay/**", async route => {
        const request = route.request(), url = new URL(request.url());
        if (request.resourceType() === "document") return route.fulfill({ contentType: "text/html", body: await server.transformIndexHtml(url.pathname, `<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="perpay-admin-base" content="/pay/admin/"><meta name="perpay-router-base" content="/pay/${mode}/"><meta name="perpay-portal" content="${mode}"><script src="/theme.js"></script></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`) });
        if (!url.pathname.includes("/api/merchant/epay/")) return route.continue();
        const endpoint = url.pathname.split("/epay/")[1]; requests.push(endpoint ?? "");
        const scope = url.searchParams.get("scope"), merchantId = url.searchParams.get("merchantId");
        if (scope === "admin" && role !== "admin") return route.fulfill({ status: 403, json: { ok: false, error: "forbidden" } });
        const data = endpoint === "access" ? { merchants: merchants.map(row => ({ ...row, role })), administrationEnabled: true, collectionChannels: ["alipay_web", "wechat_native"] }
          : endpoint === "portal/overview" ? { observedAt: 1793955600000, days: 30, today: trend[29], trend, periodCents: 1050000, pending: 3, tasks: { callbacks: 1, refunds: 0, settlements: 0 }, missingPaidAt: 0, merchants: scope === "admin" ? merchants : merchants.filter(row => row.merchantId === merchantId), balances: { availableCents: 65040, frozenCents: 0 }, statisticsScope: "epay" }
          : endpoint?.startsWith("portal/") ? { total: 1, hasNext: false, records: [{ id: "order-1", merchantId: "main-1", epayMerchantId: 1, merchantName: "星光社区", merchantOrderId: "TEST-001", name: "会员服务", status: "paid", createdAt: 1793955600000, amountCents: 101, source: "epay" }] }
          : endpoint === "fee" ? { feeBps: 500, version: 1 }
          : endpoint === "fee/history" ? { changes: [] }
          : endpoint === "session" ? { role, canAdminister: role === "admin", csrfToken: "fixture", expiresAt: 1800000000000 }
          : endpoint === "profile" ? { merchantId, displayName: "星光社区", callbackUrl: "https://merchant.example/notify", canEdit: true, csrfToken: "fixture" }
          : endpoint === "keys/meta" ? { merchantId, epayPid: "1", apiId: "api-1", keyConfigured: true }
          : endpoint === "keys/rotation-session" ? { canRotate: false, version: 1, csrfToken: null }
          : endpoint === "refunds/session" ? { enabled: true, canApprove: true, csrfToken: "fixture" }
          : endpoint === "refunds" ? { refunds: [{ refundNo: "refund-1", tradeNo: "order-1", amountCents: 101, debitCents: 96, status: "REQUESTED", reason: "客户申请", createdAt: 1793955600000, requestedBy: "owner", approvedBy: null }], hasNext: false }
          : { entries: [], adjustments: [], invoices: [], applications: [], records: [], settlements: [], hasNext: false };
        return route.fulfill({ json: { ok: true, data } });
      });
      await page.goto(`${origin}/pay/${mode}/`);
      await expect(page.getByText("收款趋势", { exact: true })).toBeVisible();
      await expect(page).toHaveTitle(/StarPAY/);
      await expect(page.locator("body")).not.toContainText(/perpay/i);
      await expect(page.getByText("¥10,500.00", { exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`${mode}-${width}.png`), fullPage: true });
      await page.getByRole("button", { name: "每日数据", exact: true }).click();
      await expect(page.getByRole("table", { name: "每日支付网关收款数据" })).toBeVisible();
      await page.getByRole("button", { name: /外观，当前/ }).click();
      await page.getByRole("menuitemradio", { name: "深色", exact: true }).click();
      await expect(page.locator("html")).toHaveClass(/dark/);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menuitemradio", { name: "深色", exact: true })).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`${mode}-${width}-dark.png`), fullPage: true });
      await page.getByRole("button", { name: /外观，当前/ }).click();
      await page.getByRole("menuitemradio", { name: "浅色", exact: true }).click();
      await page.keyboard.press("Escape");
      const navigate = async (name: string) => {
        if (width < 768) await page.getByRole("button", { name: "切换导航" }).click();
        await page.getByRole("navigation", { name: mode === "admin" ? "管理员导航" : "商户导航", exact: true }).getByRole("link", { name, exact: true }).click();
      };
      if (mode === "admin") {
        await navigate("商户管理");
        await expect(page.getByRole("button", { name: "新增商户", exact: true })).toHaveCount(0);
        await expect(page.getByRole("link", { name: "新增商户", exact: true })).toBeVisible();
        await page.getByRole("row").filter({ hasText: "星光社区" }).getByRole("link", { name: "进入管理 →" }).click();
        await expect(page.getByRole("navigation", { name: "商户管理功能" })).toBeVisible();
        await page.getByRole("navigation", { name: "商户管理功能" }).getByRole("link", { name: "费率管理" }).click();
        await expect(page.getByLabel("新费率（%）")).toBeVisible();
        await page.reload(); await expect(page.getByLabel("新费率（%）")).toBeVisible();
        role = "owner"; await page.getByRole("button", { name: "刷新权限与记录" }).click();
        await expect(page.getByText("无管理员权限", { exact: true })).toBeVisible();
        await expect(page.getByLabel("新费率（%）")).toHaveCount(0);
      } else {
        await navigate("我的订单"); await expect(page.getByText("TEST-001", { exact: true })).toBeVisible();
        await expect(page.getByRole("combobox", { name: "商户筛选" })).toHaveCount(0);
        await navigate("我的费率"); await expect(page.getByText("费率由管理员维护。", { exact: true })).toBeVisible();
        await expect(page.getByLabel("新费率（%）")).toHaveCount(0);
        await navigate("退款申请"); await expect(page.getByRole("button", { name: "批准原路退款" })).toHaveCount(0);
        await navigate("创建收款"); await expect(page.getByLabel("金额（元）")).toBeVisible();
        await page.reload(); await expect(page.getByLabel("金额（元）")).toBeVisible();
        await page.getByLabel("支付方式", { exact: true }).click();
        await expect(page.getByRole("option", { name: "支付宝网页", exact: true })).toBeVisible();
        await expect(page.getByRole("option", { name: "支付宝扫码", exact: true })).toHaveCount(0);
        await page.keyboard.press("Escape");
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(errors).toEqual([]); expect(requests).toContain("portal/overview");
    } finally { await server.close(); }
  });
}
