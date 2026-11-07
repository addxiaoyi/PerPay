import assert from "node:assert/strict";
import { it } from "node:test";
import { verifyAuditPermissions } from "../src/epay-compat/audit-permissions.ts";

const usage = "GRANT USAGE ON *.* TO `epay_audit`@`localhost`";
const select = "GRANT SELECT ON `epay_starmc`.* TO `epay_audit`@`localhost`";

it("accepts only the expected select-only isolated identity", () => {
  assert.doesNotThrow(() => verifyAuditPermissions("epay_audit@localhost", "NONE", [select, usage]));
  for (const grants of [[usage], [usage, usage], [usage, select, "GRANT DELETE ON `epay_starmc`.* TO `epay_audit`@`localhost`"], [usage, select.replace("SELECT", "SELECT, INSERT")], [usage, select + " WITH GRANT OPTION"]]) {
    assert.throws(() => verifyAuditPermissions("epay_audit@localhost", "NONE", grants), /unexpected privileges/);
  }
  assert.throws(() => verifyAuditPermissions("root@localhost", "NONE", [usage, select]), /unexpected privileges/);
  assert.throws(() => verifyAuditPermissions("epay_audit@localhost", "`admin`@`%`", [usage, select]), /unexpected privileges/);
});
