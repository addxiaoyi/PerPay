import assert from "node:assert/strict";
import { it } from "node:test";
import { capturePausedStore } from "../src/epay-compat/live-state-capture.ts";

it("captures a paused store and removes the breakpoint before resuming", async () => {
  const calls: string[] = [];
  const store = await capturePausedStore(async (method, params) => {
    calls.push(method);
    if (method === "Debugger.evaluateOnCallFrame") {
      assert.equal(params?.expression, "JSON.stringify(store)");
      assert.equal(params?.throwOnSideEffect, true);
      return { result: { value: '{"users":[]}' } };
    }
    return {};
  }, "frame", "breakpoint");
  assert.equal(store.toString(), '{"users":[]}');
  assert.deepEqual(calls, ["Debugger.evaluateOnCallFrame", "Debugger.removeBreakpoint", "Debugger.resume"]);
  store.fill(0);
});

it("always attempts resume when serialization or breakpoint removal fails", async () => {
  for (const fail of ["Debugger.evaluateOnCallFrame", "Debugger.removeBreakpoint"]) {
    const calls: string[] = [];
    await assert.rejects(capturePausedStore(async method => {
      calls.push(method);
      if (method === fail) throw new Error("fixture failure");
      return { result: { value: "{}" } };
    }, "frame", "breakpoint"), /capture or inspector cleanup failed/);
    assert.equal(calls.at(-1), "Debugger.resume");
  }
});

it("rejects invalid results and reports a failed resume", async () => {
  await assert.rejects(capturePausedStore(async method => { if (method === "Debugger.evaluateOnCallFrame") throw undefined; return {}; }, "frame", "breakpoint"), /capture or inspector cleanup failed/);
  await assert.rejects(capturePausedStore(async method => method === "Debugger.evaluateOnCallFrame" ? { exceptionDetails: {} } : {}, "frame", "breakpoint"), /capture or inspector cleanup failed/);
  await assert.rejects(capturePausedStore(async method => {
    if (method === "Debugger.resume") throw new Error("resume failed");
    return { result: { value: "{}" } };
  }, "frame", "breakpoint"), /capture or inspector cleanup failed/);
});

it("times out unresponsive commands while still attempting resume", async () => {
  for (const hung of ["Debugger.evaluateOnCallFrame", "Debugger.removeBreakpoint", "Debugger.resume"]) {
    const calls: string[] = [];
    await assert.rejects(capturePausedStore(async method => {
      calls.push(method);
      if (method === hung) return new Promise(() => {});
      return { result: { value: "{}" } };
    }, "frame", "breakpoint", { captureTimeoutMs: 10, cleanupTimeoutMs: 10 }), /capture or inspector cleanup failed/);
    assert.equal(calls.at(-1), "Debugger.resume");
  }
});
