import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { archiveVerifiedInspector, type LiveStateInspector } from "../src/epay-compat/live-state-controller.ts";
import { readLiveStateArchive } from "../src/epay-compat/live-state-archive.ts";
import { openLiveState } from "../src/epay-compat/live-state-envelope.ts";

it("captures a verified session and cleans up rejected or timed-out sessions", { skip: process.platform !== "linux", timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "perpay-controller-"));
  const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const startTicks = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19]!;
  const cmdline = readFileSync(`/proc/${process.pid}/cmdline`);
  const target = { pid: process.pid, startTicks, executable: readlinkSync(`/proc/${process.pid}/exe`), uid: process.getuid!(), args: cmdline.subarray(0, -1).toString("utf8").split("\0") };
  const keys = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const recipientPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const recipientFingerprint = createHash("sha256").update(keys.publicKey.export({ type: "spki", format: "der" })).digest("hex");
  const source = "fixture source\n", sourceUrl = "file:///fixture/persist.js", sourceSha256 = createHash("sha256").update(source).digest("hex");
  const snapshotId = "a".repeat(32);
  try {
    for (const mode of ["success", "source", "location", "pause", "timeout"] as const) {
      const calls: string[] = [];
      const inspector: LiveStateInspector = {
        scripts: () => [{ scriptId: "1", url: sourceUrl }],
        send: async method => {
          calls.push(method);
          if (method === "Debugger.getScriptSource") return { scriptSource: mode === "source" ? "other" : source };
          if (method === "Debugger.setBreakpointByUrl") return { breakpointId: "bp", locations: [{ scriptId: mode === "location" ? "2" : "1", lineNumber: 4 }] };
          if (method === "Debugger.evaluateOnCallFrame") return { result: { value: '{"users":["fixture"]}' } };
          return {};
        },
        waitForPause: async () => mode === "timeout" ? new Promise(() => {}) : { hitBreakpoints: [mode === "pause" ? "other" : "bp"], callFrames: [{ callFrameId: "frame", location: { scriptId: "1" } }] },
        close: async () => { calls.push("close"); },
      };
      const archivePath = join(directory, `${mode}.json`);
      const options = { target, connect: async () => inspector, sourceUrl, sourceSha256, lineNumber: 4, recipientPem, recipientFingerprint, snapshotId, archivePath, pauseTimeoutMs: 10 };
      if (mode === "success") {
        const receipt = await archiveVerifiedInspector(options);
        const state = openLiveState(readLiveStateArchive(archivePath, receipt.sha256), keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), snapshotId);
        try { assert.equal(state.toString(), '{"users":["fixture"]}'); } finally { state.fill(0); }
      } else {
        await assert.rejects(archiveVerifiedInspector(options));
        assert.equal(existsSync(archivePath), false);
        if (mode !== "source") assert.ok(calls.includes("Debugger.removeBreakpoint"));
        if (mode === "pause") assert.ok(calls.includes("Debugger.resume"));
      }
      assert.equal(calls.at(-1), "close");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
