import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { pathToFileURL } from "node:url";
import { archiveVerifiedInspector } from "../src/epay-compat/live-state-controller.ts";
import { connectLiveStateInspector } from "../src/epay-compat/live-state-inspector.ts";
import { readLiveStateArchive } from "../src/epay-compat/live-state-archive.ts";
import { openLiveState } from "../src/epay-compat/live-state-envelope.ts";

it("captures a live synthetic process through the verified controller", { skip: process.platform !== "linux", timeout: 20000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "perpay-live-controller-"));
  const runner = join(directory, "fixture.mjs");
  const source = "const store = { users: ['fixture'] };\nsetInterval(() => {\n  console.log('tick', store.users.length);\n}, 100);\n";
  writeFileSync(runner, source);
  const args = ["--inspect=127.0.0.1:0", runner];
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  let ticks = 0;
  child.stdout.on("data", chunk => { ticks += chunk.toString().split("tick").length - 1; });
  try {
    const [stderr] = await once(child.stderr, "data");
    const match = /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(stderr.toString());
    assert.ok(match);
    await once(child.stdout, "data");
    const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
    const startTicks = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19];
    const target = { pid: child.pid, startTicks, executable: readlinkSync(`/proc/${child.pid}/exe`), uid: process.getuid(), args: [process.execPath, ...args] };
    const keys = generateKeyPairSync("rsa", { modulusLength: 3072 });
    const recipientPem = keys.publicKey.export({ type: "spki", format: "pem" });
    const recipientFingerprint = createHash("sha256").update(keys.publicKey.export({ type: "spki", format: "der" })).digest("hex");
    const snapshotId = "b".repeat(32), archivePath = join(directory, "snapshot.json");
    const sourceUrl = pathToFileURL(runner).href;
    await assert.rejects(connectLiveStateInspector(target, match[1].replace("127.0.0.1", "localhost"), sourceUrl), /invalid inspector endpoint/);
    await assert.rejects(connectLiveStateInspector({ ...target, startTicks: `${startTicks}0` }, match[1], sourceUrl), /identity mismatch/);
    const ownStat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
    const ownCmdline = readFileSync(`/proc/${process.pid}/cmdline`);
    const ownIdentity = { pid: process.pid, startTicks: ownStat.slice(ownStat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19], executable: readlinkSync(`/proc/${process.pid}/exe`), uid: process.getuid(), args: ownCmdline.subarray(0, -1).toString("utf8").split("\0") };
    await assert.rejects(connectLiveStateInspector(ownIdentity, match[1], sourceUrl), /not owned by target/);
    const receipt = await archiveVerifiedInspector({
      target, sourceUrl, sourceSha256: createHash("sha256").update(source).digest("hex"), lineNumber: 2,
      recipientPem, recipientFingerprint, snapshotId, archivePath,
      connect: () => connectLiveStateInspector(target, match[1], sourceUrl),
    });
    const state = openLiveState(readLiveStateArchive(archivePath, receipt.sha256), keys.privateKey.export({ type: "pkcs8", format: "pem" }), snapshotId);
    try { assert.deepEqual(JSON.parse(state.toString()), { users: ["fixture"] }); } finally { state.fill(0); }
    const previous = ticks;
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.ok(ticks > previous, "fixture did not resume");
    const timeoutPath = join(directory, "timeout.json");
    let pausedBeforeTimeout = false;
    await assert.rejects(archiveVerifiedInspector({
      target, sourceUrl, sourceSha256: createHash("sha256").update(source).digest("hex"), lineNumber: 2,
      recipientPem, recipientFingerprint, snapshotId, archivePath: timeoutPath, pauseTimeoutMs: 300,
      connect: async () => {
        const inspector = await connectLiveStateInspector(target, match[1], sourceUrl);
        return { ...inspector, waitForPause: async () => {
          const pause = await inspector.waitForPause();
          pausedBeforeTimeout = true;
          await new Promise(resolve => setTimeout(resolve, 500));
          return pause;
        } };
      },
    }), /timed out/);
    assert.equal(pausedBeforeTimeout, true, "fixture did not pause before timeout");
    const afterTimeout = ticks;
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.ok(ticks > afterTimeout, "fixture did not resume after capture timeout");
    const finalInspector = await connectLiveStateInspector(target, match[1], sourceUrl);
    await finalInspector.send("Runtime.evaluate", { expression: "setImmediate(() => process.getBuiltinModule('node:inspector').close()); void 0" });
    await finalInspector.close();
    const afterDisconnect = ticks;
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.ok(ticks > afterDisconnect, "fixture did not resume after inspector shutdown");
    await assert.rejects(connectLiveStateInspector(target, match[1], sourceUrl), /inspector listener is unavailable/);
  } finally {
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    rmSync(directory, { recursive: true, force: true });
  }
});
