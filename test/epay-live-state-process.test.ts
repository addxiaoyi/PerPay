import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, readlinkSync } from "node:fs";
import { it } from "node:test";
import { verifyLiveStateProcess } from "../src/epay-compat/live-state-process.ts";

it("pins a Linux fixture process and rejects mismatched identities", { skip: process.platform !== "linux" }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  try {
    const pid = child.pid;
    assert.ok(pid);
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const ticks = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19];
    assert.ok(ticks);
    const identity = { pid, startTicks: ticks, executable: readlinkSync(`/proc/${pid}/exe`), uid: process.getuid!(), args: [process.execPath, "-e", "setInterval(() => {}, 1000)"] };
    assert.doesNotThrow(() => verifyLiveStateProcess(identity));
    assert.throws(() => verifyLiveStateProcess({ ...identity, startTicks: `${ticks}0` }), /identity mismatch/);
    assert.throws(() => verifyLiveStateProcess({ ...identity, uid: identity.uid + 1 }), /identity mismatch/);
    assert.throws(() => verifyLiveStateProcess({ ...identity, args: [process.execPath] }), /identity mismatch/);
    assert.throws(() => verifyLiveStateProcess({ ...identity, executable: "/" }), /identity mismatch/);
    assert.throws(() => verifyLiveStateProcess({ ...identity, pid: 0 }), /invalid expected/);
  } finally {
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
  }
});
