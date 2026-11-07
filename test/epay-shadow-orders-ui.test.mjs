import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";

const fixtureOrigin = process.env.EPAY_SHADOW_UI_FIXTURE_ORIGIN;

test("candidate order view clears data when access is revoked", { skip: !fixtureOrigin }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.EPAY_SHADOW_UI_BROWSER ? { executablePath: process.env.EPAY_SHADOW_UI_BROWSER } : {}) });
  try {
    for (const viewport of [{ width: 1200, height: 800 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport });
      let authorized = true;
      await page.route("**/api/merchant/shadow-orders?**", async route => {
        if (!authorized) return route.fulfill({ status: 404, body: "{}" });
        const number = Number(new URL(route.request().url()).searchParams.get("page"));
        await route.fulfill({ json: { ok: true, data: { scope: "epay_only", invoiceAvailable: false,
          orders: [{ id: `epay_${number}`, merchantOrderId: `order-${number}`, name: "测试商品", amount: "1.00", status: "paid", createdAt: "2026-01-01T00:00:00Z" }],
          pageInfo: { page: number, totalPages: 2, total: 21, hasNext: number === 1, hasPrevious: number === 2 } } } });
      });
      await page.goto(`${fixtureOrigin}/tests/fixtures/shadow-orders.html`);
      await page.getByRole("button", { name: "读取候选订单" }).click();
      await page.getByText("order-1").waitFor();
      await page.getByRole("button", { name: "下一页" }).click();
      await page.getByText("order-2").waitFor();
      authorized = false;
      await page.getByRole("button", { name: "读取候选订单" }).click();
      await page.getByRole("alert").waitFor();
      assert.equal(await page.getByText("order-2").count(), 0);
      assert.equal(await page.getByRole("button", { name: /开票|支付/ }).count(), 0);
      await page.close();
    }
  } finally { await browser.close(); }
});
