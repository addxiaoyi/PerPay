import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "node:test";
import { isolatedCheckout } from "../src/epay-compat/isolated-checkout.ts";
import { issueCheckoutToken } from "../src/epay-compat/isolated-checkout-status.ts";

it("escapes the item, displays exact cents and restricts the checkout document", async () => {
  const token = issueCheckoutToken(Buffer.alloc(32, 1), "fixture", "a".repeat(32), 1, 100);
  const response = await isolatedCheckout("weixin://wxpay/example", `<img src=x onerror="alert(1)">`, 101, token);
  const html = await response.text();
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /¥ 1\.01/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const style = /<style>([^]*?)<\/style>/.exec(html)?.[1];
  assert.ok(style);
  const hash = createHash("sha256").update(style).digest("base64");
  assert.ok(response.headers.get("content-security-policy")?.includes(`'sha256-${hash}'`));
  await assert.rejects(isolatedCheckout("bad\ncode", "item", 101, token), /invalid/);
  await assert.rejects(isolatedCheckout("weixin://wxpay/example", "item", 1.5, token), /invalid/);
});
