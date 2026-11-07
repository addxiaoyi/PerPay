import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";

const origin = process.env.EPAY_SHADOW_UI_FIXTURE_ORIGIN;

test("renders and clears merchant history on revoked access", { skip: !origin }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.EPAY_SHADOW_UI_BROWSER ? { executablePath: process.env.EPAY_SHADOW_UI_BROWSER } : {}) });
  try {
    for (const viewport of [{ width: 1200, height: 800 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport });
      let authorized = true;
      await page.route("**/api/merchant/shadow-activity?**", async route => {
        if (!authorized) return route.fulfill({ status: 404, body: "{}" });
        const query = new URL(route.request().url()).searchParams;
        const kind = query.get("kind"), number = Number(query.get("page"));
        const row = kind === "callbacks" ? { id: `callback-${number}`, orderId: `order-${number}`, status: "queued", createdAt: "2026-01-01T00:00:00Z" } : { id: `settlement-${number}`, amountCents: 1234, status: "paid", createdAt: "2026-01-01T00:00:00Z" };
        return route.fulfill({ json: { ok: true, data: { kind, records: [row], page: number, reconciled: false, hasNext: number === 1 } } });
      });
      await page.goto(`${origin}/tests/fixtures/shadow-activity.html`);
      await page.getByText("settlement-1").waitFor();
      await page.getByRole("button", { name: "回调" }).click();
      await page.getByText("order-1").waitFor();
      await page.getByRole("button", { name: "下一页" }).click();
      await page.getByText("order-2").waitFor();
      authorized = false;
      await page.getByRole("button", { name: "结算" }).click();
      await page.getByRole("alert").waitFor();
      assert.equal(await page.getByText("order-2").count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      await page.screenshot();
      await page.close();
    }
  } finally { await browser.close(); }
});
