import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { pathToFileURL } from "node:url";
import { openLiveState, sealLiveState } from "../src/epay-compat/live-state-envelope.ts";
import { readLiveStateArchive, writeLiveStateArchive } from "../src/epay-compat/live-state-archive.ts";
import { capturePausedStore } from "../src/epay-compat/live-state-capture.ts";
import { verifyLiveStateProcess } from "../src/epay-compat/live-state-process.ts";
import { verifyLoadedLiveStateSource } from "../src/epay-compat/live-state-source.ts";
import { archivePausedSession, preflightLiveStateCapture } from "../src/epay-compat/live-state-session.ts";

const fixturePath = process.env.EPAY_DEPLOYED_PERSIST_FIXTURE;
const expectedHash = process.env.EPAY_DEPLOYED_PERSIST_SHA256;
const attachRunning = process.env.EPAY_INSPECTOR_ATTACH === "1";

it("recovers synthetic in-memory state from a verified deployed persistence module", {
  skip: !fixturePath || !expectedHash || (attachRunning && process.platform === "win32"),
  timeout: 30000,
}, async context => {
  assert.match(expectedHash, /^[a-f0-9]{64}$/);
  const source = readFileSync(fixturePath);
  assert.equal(createHash("sha256").update(source).digest("hex"), expectedHash);
  const lines = source.toString("utf8").split("\n");
  const lineNumber = lines.findIndex(line => line.includes("store.json modified externally, skipping save"));
  assert.ok(lineNumber >= 0, "the verified module no longer has the expected conflict branch");

  const directory = mkdtempSync(join(tmpdir(), "perpay-deployed-persist-"));
  const diskPath = join(directory, "store.json");
  const modulePath = join(directory, "persist.js");
  const diskState = JSON.stringify({ users: ["fixture-disk"], payment: { orders: [] } });
  writeFileSync(join(directory, "package.json"), '{"type":"module"}', { mode: 0o600 });
  writeFileSync(join(directory, "config.js"), "export const config = { dataDir: process.env.FIXTURE_DIR, databaseUrl: null };\n", { mode: 0o600 });
  writeFileSync(modulePath, source, { mode: 0o600 });
  writeFileSync(diskPath, diskState, { mode: 0o600 });
  const runner = `import { utimesSync } from 'node:fs';
import { loadStore, scheduleSave } from './persist.js';
const store = loadStore();
store.users.push('fixture-memory');
store.payment.orders.push({ id: 'fixture-order', cents: 101 });
store.catalog = Array.from({ length: 100000 }, (_, id) => ({ id, text: 'x'.repeat(500) }));
const future = new Date(Date.now() + 60000);
utimesSync(process.env.FIXTURE_DIR + '/store.json', future, future);
setInterval(scheduleSave, 350);
`;
  writeFileSync(join(directory, "runner.js"), runner, { mode: 0o600 });
  const keys = generateKeyPairSync("rsa", { modulusLength: 3072 });
  const publicPem = keys.publicKey.export({ type: "spki", format: "pem" });
  const fingerprint = createHash("sha256").update(keys.publicKey.export({ type: "spki", format: "der" })).digest("hex");
  const snapshotId = randomBytes(16).toString("hex");
  const encryptedPath = join(directory, "state.json");
  preflightLiveStateCapture({ recipientPem: publicPem, recipientFingerprint: fingerprint, snapshotId, archivePath: encryptedPath });
  const env = { FIXTURE_DIR: directory };
  for (const name of ["PATH", "SystemRoot", "TEMP", "TMP"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  const inspectOption = attachRunning ? "--inspect-port=127.0.0.1:0" : "--inspect=127.0.0.1:0";
  const child = spawn(process.execPath, [inspectOption, join(directory, "runner.js")], {
    env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let socket;
  let conflicts = 0;
  let resolveRunning;
  let processIdentity;
  const running = new Promise(resolve => { resolveRunning = resolve; });
  child.stdout.on("data", chunk => { conflicts += chunk.toString().split("\n").length - 1; resolveRunning(); });
  try {
    const inspectorReady = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("fixture inspector did not start")), 5000);
      let stderr = "";
      child.stderr.on("data", chunk => {
        stderr += chunk.toString();
        const match = /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(stderr);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
      child.once("exit", code => { clearTimeout(timeout); reject(new Error(`fixture exited: ${code}`)); });
    });
    if (attachRunning) {
      await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error("fixture did not start")), 4000).unref())]);
      const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
      const startTicks = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19];
      processIdentity = { pid: child.pid, startTicks, executable: process.execPath, uid: process.getuid(), args: [process.execPath, inspectOption, join(directory, "runner.js")] };
      verifyLiveStateProcess(processIdentity);
      assert.equal(child.kill("SIGUSR1"), true, "fixture inspector signal failed");
    }
    const inspectorUrl = await inspectorReady;
    if (processIdentity) verifyLiveStateProcess(processIdentity);
    socket = new WebSocket(inspectorUrl);
    await once(socket, "open");
    const pending = new Map();
    const scripts = [];
    let id = 0;
    let onPause;
    const paused = new Promise(resolve => { onPause = resolve; });
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.method === "Debugger.paused") onPause(message.params);
      if (message.method === "Debugger.scriptParsed") scripts.push({ scriptId: message.params.scriptId, url: message.params.url });
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const requestId = ++id;
      pending.set(requestId, { resolve, reject });
      socket.send(JSON.stringify({ id: requestId, method, params }));
    });
    await send("Debugger.enable");
    const moduleUrl = pathToFileURL(modulePath).href;
    if (attachRunning) await verifyLoadedLiveStateSource(send, scripts, moduleUrl, expectedHash);
    await send("Debugger.setBreakpointByUrl", { url: moduleUrl, lineNumber });
    const event = await Promise.race([
      paused,
      new Promise((_, reject) => setTimeout(() => reject(new Error("fixture conflict breakpoint did not fire")), 5000).unref()),
    ]);
    const pausedAt = performance.now();
    const plaintext = await capturePausedStore(send, event.callFrames[0].callFrameId, event.hitBreakpoints[0]);
    const state = JSON.parse(plaintext.toString("utf8"));
    assert.deepEqual(state.users, ["fixture-disk", "fixture-memory"]);
    assert.deepEqual(state.payment.orders, [{ id: "fixture-order", cents: 101 }]);
    assert.equal(state.catalog.length, 100000);
    assert.equal(state.catalog[99999].text.length, 500);
    assert.equal(readFileSync(diskPath, "utf8"), diskState);
    context.diagnostic(`synthetic bytes: ${plaintext.byteLength}; observed paused milliseconds: ${Math.round(performance.now() - pausedAt)}`);

    // Access the already-loaded module without installing a debugger breakpoint.
    const directStarted = performance.now();
    const direct = await send("Runtime.evaluate", {
      expression: `import(${JSON.stringify(pathToFileURL(modulePath).href)}).then(m => JSON.stringify(m.getStore()))`,
      awaitPromise: true,
      returnByValue: true,
    });
    assert.match(direct.exceptionDetails?.exception?.description ?? "", /dynamic import callback was not specified/i);
    context.diagnostic(`synthetic direct import rejected in milliseconds: ${Math.round(performance.now() - directStarted)}`);

    try {
      const wrong = generateKeyPairSync("rsa", { modulusLength: 3072 });
      const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" });
      const wrongPem = wrong.privateKey.export({ type: "pkcs8", format: "pem" });
      const sealed = sealLiveState(plaintext, publicPem, snapshotId, fingerprint);
      const { sha256 } = writeLiveStateArchive(encryptedPath, sealed);
      const bytes = readFileSync(encryptedPath);
      assert.equal(bytes.includes(Buffer.from("fixture-order")), false);
      assert.throws(() => writeLiveStateArchive(encryptedPath, sealed), /already exists/);
      const archive = readLiveStateArchive(encryptedPath, sha256);
      assert.throws(() => openLiveState(archive, wrongPem, snapshotId), /does not match/);
      const recovered = openLiveState(archive, privatePem, snapshotId);
      try { assert.equal(recovered.equals(plaintext), true); } finally { recovered.fill(0); }
      const altered = { ...archive, ciphertext: `${archive.ciphertext[0] === "A" ? "B" : "A"}${archive.ciphertext.slice(1)}` };
      assert.throws(() => openLiveState(altered, privatePem, snapshotId));
      writeFileSync(encryptedPath, JSON.stringify(altered));
      assert.throws(() => readLiveStateArchive(encryptedPath, sha256), /digest mismatch/);
    } finally { plaintext.fill(0); }
    const before = conflicts;
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.ok(conflicts > before, "fixture did not resume after snapshot");
    assert.equal(readFileSync(diskPath, "utf8"), diskState);
    if (!attachRunning) {
      const nextPause = new Promise(resolve => { onPause = resolve; });
      await send("Debugger.setBreakpointByUrl", { url: moduleUrl, lineNumber });
      await Promise.race([
        nextPause,
        new Promise((_, reject) => setTimeout(() => reject(new Error("fixture did not pause for disconnect test")), 5000).unref()),
      ]);
      let disconnected = false;
      await assert.rejects(archivePausedSession({
        send: async () => new Promise(() => {}),
        close: async () => {
          const closed = once(socket, "close");
          socket.close();
          await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("fixture inspector did not disconnect")), 1000).unref())]);
          disconnected = true;
        },
        frameId: "fixture-frame", breakpointId: "fixture-breakpoint", captureTimeoutMs: 20, cleanupTimeoutMs: 20,
        recipientPem: "unused", recipientFingerprint: "unused", snapshotId: "unused", archivePath: join(directory, "should-not-exist.json"),
      }), /live state session failed/);
      assert.equal(disconnected, true);
      assert.equal(existsSync(join(directory, "should-not-exist.json")), false);
      const afterDisconnect = conflicts;
      await new Promise(resolve => setTimeout(resolve, 800));
      assert.ok(conflicts > afterDisconnect, "fixture did not resume after debugger disconnected while paused");
      assert.equal(readFileSync(diskPath, "utf8"), diskState);
    }
    if (attachRunning) {
      const closed = once(socket, "close");
      await send("Runtime.evaluate", { expression: "setTimeout(() => process._debugEnd(), 0); true", returnByValue: true });
      await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("fixture inspector did not close")), 5000).unref())]);
      const inspectorPort = new URL(inspectorUrl).port;
      await assert.rejects(fetch(`http://127.0.0.1:${inspectorPort}/json/version`, { signal: AbortSignal.timeout(1000) }));
      const resumed = conflicts;
      await new Promise(resolve => setTimeout(resolve, 800));
      assert.ok(conflicts > resumed, "fixture did not resume after inspector shutdown");
    }
  } finally {
    socket?.close();
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    rmSync(directory, { recursive: true, force: true });
  }
});
