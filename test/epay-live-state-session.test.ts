import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { readLiveStateArchive } from "../src/epay-compat/live-state-archive.ts";
import { openLiveState } from "../src/epay-compat/live-state-envelope.ts";
import { archivePausedSession, preflightLiveStateCapture } from "../src/epay-compat/live-state-session.ts";

it("validates the recipient and target before a debugger is attached", () => {
  const dir = mkdtempSync(join(tmpdir(), "perpay-session-preflight-"));
  try {
    const keys = generateKeyPairSync("rsa", { modulusLength: 3072 });
    const recipientPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const recipientFingerprint = createHash("sha256").update(keys.publicKey.export({ type: "spki", format: "der" })).digest("hex");
    const options = { recipientPem, recipientFingerprint, snapshotId: "a".repeat(32), archivePath: join(dir, "snapshot.json") };
    assert.doesNotThrow(() => preflightLiveStateCapture(options));
    assert.equal(existsSync(options.archivePath), false);
    assert.throws(() => preflightLiveStateCapture({ ...options, recipientFingerprint: "0".repeat(64) }), /fingerprint mismatch/);
    assert.throws(() => preflightLiveStateCapture({ ...options, snapshotId: "bad" }), /invalid recovery snapshot/);
    assert.throws(() => preflightLiveStateCapture({ ...options, archivePath: "relative.json" }), /path/);
    writeFileSync(options.archivePath, "existing");
    assert.throws(() => preflightLiveStateCapture(options), /already exists/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("disconnects before publishing an encrypted recoverable snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perpay-session-"));
  try {
    const keys = generateKeyPairSync("rsa", { modulusLength: 3072 });
    const recipientPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const recipientFingerprint = createHash("sha256").update(keys.publicKey.export({ type: "spki", format: "der" })).digest("hex");
    const archivePath = join(dir, "snapshot.json");
    const snapshotId = "a".repeat(32);
    let disconnected = false;
    const receipt = await archivePausedSession({
      send: async method => method === "Debugger.evaluateOnCallFrame" ? { result: { value: '{"users":["fixture"]}' } } : {},
      close: async () => { assert.equal(existsSync(archivePath), false); disconnected = true; },
      frameId: "frame", breakpointId: "breakpoint", recipientPem, recipientFingerprint, snapshotId, archivePath,
    });
    assert.equal(disconnected, true);
    const restored = openLiveState(readLiveStateArchive(archivePath, receipt.sha256), keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), snapshotId);
    try { assert.equal(restored.toString(), '{"users":["fixture"]}'); } finally { restored.fill(0); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("disconnects on capture errors and refuses to publish on disconnect errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "perpay-session-"));
  try {
    for (const failure of ["capture", "close", "empty-close"]) {
      const archivePath = join(dir, `${failure}.json`);
      let closed = false;
      await assert.rejects(archivePausedSession({
        send: async method => {
          if (method === "Debugger.evaluateOnCallFrame" && failure === "capture") throw new Error("fixture capture error");
          return { result: { value: "{}" } };
        },
        close: async () => { closed = true; if (failure === "close") throw new Error("fixture disconnect error"); if (failure === "empty-close") throw undefined; },
        frameId: "frame", breakpointId: "breakpoint", recipientPem: "unused", recipientFingerprint: "unused", snapshotId: "unused", archivePath,
      }), /live state session failed/);
      assert.equal(closed, true);
      assert.equal(existsSync(archivePath), false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
