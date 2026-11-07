import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import { createApp } from "../src/http/app.ts";
import { createConfiguredHttpServices, HTTP_TEST_ADMIN_PASSWORD } from "./http-fixture.ts";

it("serves admin HTML, health and login below an explicit base path", async () => {
  const directory = mkdtempSync(join(tmpdir(), "perpay-base-path-"));
  const services = await createConfiguredHttpServices({
    directory,
    apiSecret: null,
    collectionCodePayload: "https://qr.alipay.com/fkx-test-code-base-path",
    environment: { PERPAY_BASE_PATH: "/pay" },
  });
  const app = createApp({
    config: services.config,
    database: services.database,
    identity: services.identity,
    settings: services.settings,
    orders: services.orders,
    startedAt: new Date(0),
  });

  try {
    const root = await app.request("/pay/");
    assert.equal(root.status, 308);
    assert.equal(root.headers.get("location"), "/pay/admin/");

    const health = await app.request("/pay/healthz");
    assert.equal(health.status, 200);

    const admin = await app.request("/pay/admin/");
    assert.equal(admin.status, 200);
    const html = await admin.text();
    assert.match(html, /\/pay\/admin\/assets\//);
    assert.match(html, /name="perpay-admin-base" content="\/pay\/admin\/"/);

    const gateway = createApp({ config: services.config, database: services.database, identity: services.identity, settings: services.settings,
      orders: services.orders, startedAt: new Date(0), merchantWorkspace: { identityOrigin: "http://127.0.0.1:8787" } });
    for (const mode of ["admin", "merchant"]) {
      for (const path of ["", "orders", "invoices"]) {
        const portal = await gateway.request(`/pay/${mode}/${path}`);
        assert.equal(portal.status, 200);
        const document = await portal.text();
        assert.ok(document.includes(`name="perpay-portal" content="${mode}"`));
        assert.ok(document.includes(`name="perpay-router-base" content="/pay/${mode}/"`));
        assert.match(document, /\/pay\/admin\/assets\//);
      }
    }

    const login = await app.request("/pay/api/admin/v1/session/login", {
      method: "POST",
      headers: {
        origin: services.config.publicOrigin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ password: HTTP_TEST_ADMIN_PASSWORD }),
    });
    assert.equal(login.status, 200);
    const setCookie = login.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /Path=\/pay/);
    assert.doesNotMatch(setCookie, /__Host-perpay_/);
  } finally {
    services.database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
