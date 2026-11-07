import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";

const origin = process.env.EPAY_SHADOW_UI_FIXTURE_ORIGIN;
test("candidate combined orders clear stale data on revocation and merchant switch", { skip: !origin }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.EPAY_SHADOW_UI_BROWSER ? { executablePath: process.env.EPAY_SHADOW_UI_BROWSER } : {}) });
  try {
    for (const viewport of [{ width: 1200, height: 800 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport });
      let authorized = true;
      await page.route("**/api/merchant/shadow-combined-orders?**", async route => {
        if (!authorized) return route.fulfill({ status: 404, body: "{}" });
        const query = new URL(route.request().url()).searchParams, number = Number(query.get("page"));
        await route.fulfill({ json: { ok: true, data: { merchantId: query.get("merchantId"), page: number, pageSize: 20, hasNext: number === 1, scope: "unreconciled_sources", deduplicated: false, reconciled: false,
          orders: [{ id: `id-${number}`, merchantOrderId: `order-${number}`, amountCents: 100, status: "paid", createdAt: "2026-01-01T00:00:00Z", source: number === 1 ? "main_site" : "epay" }] } } });
      });
      await page.goto(`${origin}/tests/fixtures/shadow-combined-orders.html`);
      await page.getByRole("button", { name: "读取候选订单" }).click();
      await page.getByText("order-1").waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await page.getByRole("button", { name: "下一页" }).click();
      await page.getByText("order-2").waitFor();
      authorized = false;
      await page.getByRole("button", { name: "读取候选订单" }).click();
      await page.getByRole("alert").waitFor();
      assert.equal(await page.getByText("order-2").count(), 0);
      authorized = true;
      await page.getByRole("button", { name: "读取候选订单" }).click();
      await page.getByText("order-1").waitFor();
      await page.getByRole("button", { name: "Switch merchant" }).click();
      assert.equal(await page.getByText("order-1").count(), 0);
      assert.equal(await page.getByRole("button", { name: /开票|支付/ }).count(), 0);
      await page.close();
    }
  } finally { await browser.close(); }
});
