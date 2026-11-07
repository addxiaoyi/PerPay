import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "node:test";
import { verifyLoadedLiveStateSource } from "../src/epay-compat/live-state-source.ts";

it("accepts only a uniquely identified loaded source with the expected digest", async () => {
  const source = "const store = {};\n";
  const digest = createHash("sha256").update(source).digest("hex");
  const url = "file:///fixture/persist.js";
  const scripts = [{ scriptId: "42", url }];
  const send = async (method: string, params?: Record<string, unknown>) => {
    assert.equal(method, "Debugger.getScriptSource");
    assert.deepEqual(params, { scriptId: "42" });
    return { scriptSource: source };
  };
  assert.equal(await verifyLoadedLiveStateSource(send, scripts, url, digest), "42");
  await assert.rejects(verifyLoadedLiveStateSource(send, scripts, url, "0".repeat(64)), /does not match/);
  await assert.rejects(verifyLoadedLiveStateSource(send, [...scripts, ...scripts], url, digest), /ambiguous/);
  await assert.rejects(verifyLoadedLiveStateSource(send, [], url, digest), /missing/);
  await assert.rejects(verifyLoadedLiveStateSource(send, [{ scriptId: "x", url }], url, digest), /ambiguous/);
  await assert.rejects(verifyLoadedLiveStateSource(send, scripts, "http://example.test/persist.js", digest), /invalid expected/);
  await assert.rejects(verifyLoadedLiveStateSource(async () => ({}), scripts, url, digest), /invalid debugger source/);
});
