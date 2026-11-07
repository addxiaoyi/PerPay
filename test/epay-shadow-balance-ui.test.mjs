import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "@playwright/test";

const origin = process.env.EPAY_SHADOW_UI_FIXTURE_ORIGIN;
test("candidate balance clears on merchant switch and failed authorization", { skip: !origin }, async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.EPAY_SHADOW_UI_BROWSER ? { executablePath: process.env.EPAY_SHADOW_UI_BROWSER } : {}) });
  try {
    for (const viewport of [{ width: 1200, height: 800 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport });
      let authorized = true;
      let delay = false;
      await page.route("**/api/merchant/shadow-balance?**", async route => {
        const id = new URL(route.request().url()).searchParams.get("merchantId");
        if (!authorized) return route.fulfill({ status: 404, body: "{}" });
        if (delay) await new Promise(resolve => setTimeout(resolve, 300));
        await route.fulfill({ json: { ok: true, data: { merchantId: id, availableCents: id === "first" ? 12345 : 678, frozenCents: 0, scope: "shadow_ledger_projection", financiallyReconciled: false } } }).catch(() => {});
      });
      await page.goto(`${origin}/tests/fixtures/shadow-balance.html`);
      await page.getByRole("button", { name: "读取候选余额" }).click();
      await page.getByText("¥123.45").waitFor();
      await page.getByRole("button", { name: "Switch merchant" }).click();
      assert.equal(await page.getByText("¥123.45").count(), 0);
      await page.getByRole("button", { name: "读取候选余额" }).click();
      await page.getByText("¥6.78").waitFor();
      authorized = false;
      await page.getByRole("button", { name: "读取候选余额" }).click();
      await page.getByRole("alert").waitFor();
      assert.equal(await page.getByText("¥6.78").count(), 0);
      assert.equal(await page.getByText("候选账本余额 · 未对账").count(), 1);
      authorized = true;
      delay = true;
      await page.getByRole("button", { name: "读取候选余额" }).click();
      await page.getByRole("button", { name: "Switch merchant" }).click();
      await page.waitForTimeout(400);
      assert.equal(await page.getByText("¥6.78").count(), 0);
      assert.equal(await page.getByText("¥123.45").count(), 0);
      await page.getByRole("button", { name: "读取候选余额" }).click();
      await page.getByText("¥123.45").waitFor();
      await page.close();
    }
  } finally { await browser.close(); }
});
