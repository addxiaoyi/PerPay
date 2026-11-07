import assert from "node:assert/strict";
import { it } from "node:test";

import { importEPay } from "../src/epay-compat/importer.ts";

it("refuses imports before accessing either database", async () => {
  let accessed = false;
  const database = {
    read: () => { accessed = true; throw new Error("unexpected read"); },
    write: () => { accessed = true; throw new Error("unexpected write"); },
    instanceId: () => "test",
  };
  await assert.rejects(importEPay({ database, masterKey: new Uint8Array(32), instanceId: "test", mysqlUrl: "invalid", sourceName: "test" }), /import is disabled/);
  assert.equal(accessed, false);
});
