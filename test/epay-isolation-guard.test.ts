import assert from "node:assert/strict";
import { it } from "node:test";
import { requireIsolatedMysql } from "./epay-isolation-guard.ts";

it("requires an explicit opt-in and the expected local test database", () => {
  const fixture = "mysql://reader:fixture@127.0.0.1:3307/epay_fixture";
  assert.doesNotThrow(() => requireIsolatedMysql(fixture, "epay_fixture", "1"));
  assert.throws(() => requireIsolatedMysql(fixture, "epay_fixture", undefined), /opt-in/);
  assert.throws(() => requireIsolatedMysql("mysql://reader:fixture@127.0.0.1:3307/production", "epay_fixture", "1"), /database name/);
  assert.throws(() => requireIsolatedMysql("mysql://reader:fixture@production.example/epay_fixture", "epay_fixture", "1"), /local isolated/);
  assert.throws(() => requireIsolatedMysql(fixture, "epay_restore", "1"), /database name/);
});
