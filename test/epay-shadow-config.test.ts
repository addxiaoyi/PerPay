import assert from "node:assert/strict";
import { it } from "node:test";
import { loadConfig } from "../src/config.ts";

it("requires explicit loopback-only shadow server and identity configuration", () => {
  const env = { PERPAY_MASTER_KEY: "12".repeat(32) };
  assert.equal(loadConfig(env).merchantShadowIdentityOrigin, undefined);
  assert.equal(loadConfig(env).merchantShadowMainOrders, false);
  assert.equal(loadConfig(env).merchantShadowBalance, false);
  assert.throws(() => loadConfig({ ...env, PERPAY_EPAY_SHADOW_BALANCE: "true" }), /requires a shadow identity origin/);
  assert.throws(() => loadConfig({ ...env, PERPAY_EPAY_SHADOW_MAIN_ORDERS: "true" }), /require a shadow identity origin/);
  assert.throws(() => loadConfig({ ...env, PERPAY_EPAY_SHADOW_IDENTITY_ORIGIN: "http://127.0.0.1:8787" }), /shadow requires loopback/);
  assert.throws(() => loadConfig({ ...env, PERPAY_HOST: "127.0.0.1", PERPAY_EPAY_SHADOW_IDENTITY_ORIGIN: "https://example.test" }), /shadow requires loopback/);
  assert.throws(() => loadConfig({ ...env, PERPAY_HOST: "127.0.0.1", PERPAY_EPAY_SHADOW_IDENTITY_ORIGIN: "http://127.0.0.1:8787/path" }), /shadow requires loopback/);
  assert.equal(loadConfig({ ...env, PERPAY_HOST: "127.0.0.1", PERPAY_EPAY_SHADOW_IDENTITY_ORIGIN: "http://127.0.0.1:8787" }).merchantShadowIdentityOrigin, "http://127.0.0.1:8787");
  assert.equal(loadConfig({ ...env, PERPAY_HOST: "127.0.0.1", PERPAY_EPAY_SHADOW_IDENTITY_ORIGIN: "http://127.0.0.1:8787", PERPAY_EPAY_SHADOW_MAIN_ORDERS: "true" }).merchantShadowMainOrders, true);
  assert.equal(loadConfig({ ...env, PERPAY_HOST: "127.0.0.1", PERPAY_EPAY_SHADOW_IDENTITY_ORIGIN: "http://127.0.0.1:8787", PERPAY_EPAY_SHADOW_BALANCE: "true" }).merchantShadowBalance, true);
});
