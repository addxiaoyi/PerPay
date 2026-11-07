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

it("captures and restores a 50 MB synthetic live store without stopping its fixture", { skip: process.platform !== "linux", timeout: 90000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "perpay-large-live-"));
  const runner = join(directory, "fixture.mjs");
  const bytes = 50_000_000;
  const source = `const store = { payload: 'x'.repeat(${bytes}) };\nsetInterval(() => {\n  console.log('tick', Date.now(), store.payload.length);\n}, 100);\n`;
  writeFileSync(runner, source);
  const args = ["--inspect=127.0.0.1:0", runner];
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk.toString(); });
  try {
    const [stderr] = await once(child.stderr, "data");
    const match = /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(stderr.toString());
    assert.ok(match);
    if (!output) await once(child.stdout, "data");
    const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
    const target = { pid: child.pid, startTicks: stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19], executable: readlinkSync(`/proc/${child.pid}/exe`), uid: process.getuid(), args: [process.execPath, ...args] };
    const keys = generateKeyPairSync("rsa", { modulusLength: 3072 });
    const recipientPem = keys.publicKey.export({ type: "spki", format: "pem" });
    const recipientFingerprint = createHash("sha256").update(keys.publicKey.export({ type: "spki", format: "der" })).digest("hex");
    const snapshotId = "c".repeat(32), archivePath = join(directory, "snapshot.json"), sourceUrl = pathToFileURL(runner).href;
    const started = Date.now();
    const receipt = await archiveVerifiedInspector({ target, sourceUrl, sourceSha256: createHash("sha256").update(source).digest("hex"), lineNumber: 2, recipientPem, recipientFingerprint, snapshotId, archivePath,
      connect: () => connectLiveStateInspector(target, match[1], sourceUrl) });
    const elapsed = Date.now() - started;
    const state = openLiveState(readLiveStateArchive(archivePath, receipt.sha256), keys.privateKey.export({ type: "pkcs8", format: "pem" }), snapshotId);
    try { assert.equal(JSON.parse(state.toString()).payload.length, bytes); } finally { state.fill(0); }
    const previous = output.length;
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.ok(output.length > previous, "fixture did not resume");
    const times = [...output.matchAll(/tick (\d+) /g)].map(item => Number(item[1]));
    const maxGap = Math.max(...times.slice(1).map((time, index) => time - times[index]));
    t.diagnostic(`synthetic capture and archive ${elapsed} ms; observed tick gap ${maxGap} ms`);
  } finally {
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    rmSync(directory, { recursive: true, force: true });
  }
});
