import { afterEach, expect, test } from "vitest";

import { adminBasePath, adminMountPath } from "../src/admin-base";
import { adminRoutePathname } from "../src/workspace";

afterEach(() => document.querySelector('meta[name="perpay-admin-base"]')?.remove());

test("uses the server-provided mount for nested administration routes", () => {
  const meta = document.createElement("meta");
  meta.name = "perpay-admin-base";
  meta.content = "/pay/admin/";
  document.head.append(meta);
  expect(adminBasePath()).toBe("/pay/admin/");
  expect(adminMountPath()).toBe("/pay");
  expect(adminRoutePathname("/pay/admin/sites/site-1/orders")).toBe("/sites/site-1/orders");
});

test("rejects malformed mount metadata", () => {
  const meta = document.createElement("meta");
  meta.name = "perpay-admin-base";
  meta.content = "//other.example/admin/";
  document.head.append(meta);
  expect(adminBasePath()).toBe(import.meta.env.BASE_URL);
});
