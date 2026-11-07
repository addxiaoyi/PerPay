import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { openLiveState, sealLiveState } from "../src/epay-compat/live-state-envelope.ts";
import { readLiveStateArchive, writeLiveStateArchive } from "../src/epay-compat/live-state-archive.ts";

it("reads a large synthetic live state from a paused timer and resumes its process", { timeout: 60000 }, async (context) => {
  const script = `const store = { users: ["fixture"], payment: { orders: [{ id: "fixture-order", cents: 101 }] }, catalog: Array.from({length: 100000}, (_, id) => ({id, text: "x".repeat(500)})) };
let ticks = 0;
setInterval(function save() {
  ticks++;
  if (store.users.length === 0) process.exit(1);
  process.stdout.write(".");
}, 30);
//# sourceURL=isolated-recovery-fixture.js`;
  const child = spawn(process.execPath, ["--inspect=127.0.0.1:0", "-e", script], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let heartbeats = 0;
  child.stdout.on("data", (chunk) => { heartbeats += chunk.length; });
  let socket;
  const pending = new Map();
  let nextId = 0;
  let paused;
  const pause = new Promise((resolve) => { paused = resolve; });
  try {
    let stderr = "";
    const inspectorUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture inspector did not start")), 5000);
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        const match = /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(stderr);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.once("exit", () => { clearTimeout(timer); reject(new Error("fixture exited before inspector startup")); });
    });
    socket = new WebSocket(inspectorUrl);
    await once(socket, "open");
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Debugger.paused") paused(message.params);
      if (message.id === undefined) return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
    await send("Debugger.enable");
    await send("Debugger.setBreakpointByUrl", { url: "isolated-recovery-fixture.js", lineNumber: 3 });
    const event = await pause;
    const pauseStarted = performance.now();
    const frame = event.callFrames[0];
    assert.equal(frame.functionName, "save");
    const snapshot = await send("Debugger.evaluateOnCallFrame", { callFrameId: frame.callFrameId, expression: "JSON.stringify({store,ticks})", returnByValue: true, throwOnSideEffect: true });
    assert.equal(snapshot.exceptionDetails, undefined);
    const captured = JSON.parse(snapshot.result.value);
    assert.deepEqual(captured.store.users, ["fixture"]);
    assert.deepEqual(captured.store.payment.orders, [{ id: "fixture-order", cents: 101 }]);
    assert.equal(captured.store.catalog.length, 100000);
    assert.deepEqual(captured.store.catalog[99999], { id: 99999, text: "x".repeat(500) });
    await send("Debugger.removeBreakpoint", { breakpointId: event.hitBreakpoints[0] });
    await send("Debugger.resume");
    context.diagnostic(`serialized bytes: ${Buffer.byteLength(snapshot.result.value)}; observed paused milliseconds: ${Math.round(performance.now() - pauseStarted)}`);
    const directory = mkdtempSync(join(tmpdir(), "perpay-fixture-state-"));
    const plaintext = Buffer.from(snapshot.result.value);
    try {
      const keys = generateKeyPairSync("rsa", { modulusLength: 3072 });
      const other = generateKeyPairSync("rsa", { modulusLength: 3072 });
      const publicPem = keys.publicKey.export({ type: "spki", format: "pem" });
      const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" });
      const wrongPem = other.privateKey.export({ type: "pkcs8", format: "pem" });
      const fingerprint = createHash("sha256").update(keys.publicKey.export({ type: "spki", format: "der" })).digest("hex");
      const snapshotId = randomBytes(16).toString("hex");
      const sealed = sealLiveState(plaintext, publicPem, snapshotId, fingerprint);
      const path = join(directory, "state.json");
      const { sha256 } = writeLiveStateArchive(path, sealed);
      assert.equal(readFileSync(path).includes(Buffer.from("fixture-order")), false);
      assert.throws(() => writeLiveStateArchive(path, sealed), /already exists/);
      const archive = readLiveStateArchive(path, sha256);
      assert.throws(() => openLiveState(archive, wrongPem, snapshotId), /does not match/);
      const recovered = openLiveState(archive, privatePem, snapshotId);
      try { assert.equal(recovered.equals(plaintext), true); } finally { recovered.fill(0); }
      const altered = { ...archive, ciphertext: `${archive.ciphertext[0] === "A" ? "B" : "A"}${archive.ciphertext.slice(1)}` };
      assert.throws(() => openLiveState(altered, privatePem, snapshotId));
      writeFileSync(path, JSON.stringify(altered));
      assert.throws(() => readLiveStateArchive(path, sha256), /digest mismatch/);
    } finally {
      plaintext.fill(0);
      rmSync(directory, { recursive: true, force: true });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(child.exitCode, null, "fixture did not resume");
    const resumed = await send("Runtime.evaluate", { expression: "ticks", returnByValue: true, throwOnSideEffect: true });
    assert.ok(resumed.result.value > captured.ticks, "fixture event loop did not advance");
    const disconnectPause = new Promise((resolve) => { paused = resolve; });
    await send("Debugger.setBreakpointByUrl", { url: "isolated-recovery-fixture.js", lineNumber: 3 });
    await disconnectPause;
    const beforeDisconnect = heartbeats;
    const closed = once(socket, "close");
    socket.close();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(heartbeats > beforeDisconnect, "fixture remained paused after debugger disconnect");
  } finally {
    socket?.close();
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
  }
});
