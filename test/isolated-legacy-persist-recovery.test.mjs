import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

it("reads a conflicting legacy module store without replacing the disk state", { timeout: 30000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "perpay-legacy-persist-"));
  const diskPath = join(directory, "store.json");
  const modulePath = join(directory, "persist.mjs");
  const diskState = JSON.stringify({ users: ["disk"], payment: { orders: [] } });
  const moduleSource = `import { readFileSync, writeFileSync } from 'node:fs';
const file = process.argv[2];
let store = JSON.parse(readFileSync(file, 'utf8'));
let dirty = false;
let scheduled = null;
function writeStoreFile() { writeFileSync(file, JSON.stringify(store)); }
function scheduleSave() {
  dirty = true;
  if (scheduled) return;
  scheduled = setTimeout(() => {
    scheduled = null;
    if (!dirty) return;
    dirty = false;
    try {
      if (true) {
        process.stdout.write('conflict\\n');
        dirty = false;
        return;
      }
      writeStoreFile();
    } catch (error) { process.stderr.write(String(error)); }
  }, 20);
}
store.users.push('memory');
store.payment.orders.push({ id: 'synthetic-order', cents: 101 });
setInterval(scheduleSave, 40);
`;
  writeFileSync(diskPath, diskState, { mode: 0o600 });
  writeFileSync(modulePath, moduleSource, { mode: 0o600 });
  const child = spawn(process.execPath, ["--inspect=127.0.0.1:0", modulePath, diskPath], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let socket;
  let lines = 0;
  child.stdout.on("data", chunk => { lines += chunk.toString().split("\n").length - 1; });
  try {
    const inspectorUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("fixture inspector did not start")), 5000);
      let stderr = "";
      child.stderr.on("data", chunk => {
        stderr += chunk.toString();
        const match = /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/.exec(stderr);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`fixture exited: ${code}`)); });
    });
    socket = new WebSocket(inspectorUrl);
    await once(socket, "open");
    const pending = new Map();
    let id = 0;
    let onPause;
    const paused = new Promise(resolve => { onPause = resolve; });
    socket.addEventListener("message", event => {
      const message = JSON.parse(event.data);
      if (message.method === "Debugger.paused") onPause(message.params);
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
    const lineNumber = moduleSource.split("\n").findIndex(line => line.includes("process.stdout.write('conflict"));
    assert.ok(lineNumber >= 0);
    await send("Debugger.setBreakpointByUrl", { urlRegex: "persist\\.mjs$", lineNumber });
    const event = await paused;
    const frame = event.callFrames[0];
    const snapshot = await send("Debugger.evaluateOnCallFrame", {
      callFrameId: frame.callFrameId, expression: "JSON.stringify(store)", returnByValue: true, throwOnSideEffect: true,
    });
    assert.equal(snapshot.exceptionDetails, undefined);
    assert.deepEqual(JSON.parse(snapshot.result.value), {
      users: ["disk", "memory"], payment: { orders: [{ id: "synthetic-order", cents: 101 }] },
    });
    assert.equal(readFileSync(diskPath, "utf8"), diskState);
    const beforeDisconnect = lines;
    const closed = once(socket, "close");
    socket.close();
    await closed;
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.ok(lines > beforeDisconnect, "fixture did not resume after debugger disconnected");
    assert.equal(readFileSync(diskPath, "utf8"), diskState);
  } finally {
    socket?.close();
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    rmSync(directory, { recursive: true, force: true });
  }
});
