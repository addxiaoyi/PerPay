import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

function waitForLine(stream, pattern, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => finish(new Error("timed out waiting for synthetic process")), timeoutMs);
    function finish(error, value) {
      clearTimeout(timer);
      stream.off("data", onData);
      if (error) reject(error); else resolve(value);
    }
    function onData(chunk) {
      text += chunk.toString();
      const match = pattern.exec(text);
      if (match) finish(null, match);
    }
    stream.on("data", onData);
  });
}

it("resumes a synthetic process when its paused inspector controller is killed", { timeout: 20000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "perpay-inspector-crash-"));
  const runner = join(directory, "fixture.mjs");
  writeFileSync(runner, "setInterval(() => {\n  console.log('fixture-tick');\n}, 100);\n");
  const fixture = spawn(process.execPath, ["--inspect=127.0.0.1:0", runner], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let ticks = 0;
  fixture.stdout.on("data", chunk => { ticks += chunk.toString().split("fixture-tick").length - 1; });
  let controller;
  try {
    const inspector = await waitForLine(fixture.stderr, /Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
    const code = `
const socket = new WebSocket(process.argv[1]);
socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'Debugger.enable' })));
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.id === 1) socket.send(JSON.stringify({ id: 2, method: 'Debugger.setBreakpointByUrl', params: { urlRegex: 'fixture\\\\.mjs$', lineNumber: 1 } }));
  if (message.error) { console.error(message.error.message); process.exitCode = 1; socket.close(); }
  if (message.method === 'Debugger.paused') console.log('controller-paused');
});`;
    controller = spawn(process.execPath, ["--input-type=module", "-e", code, inspector[1]], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    await waitForLine(controller.stdout, /controller-paused/);
    await new Promise(resolve => setTimeout(resolve, 250));
    const pausedTicks = ticks;
    const controllerExit = once(controller, "exit");
    controller.kill("SIGKILL");
    await controllerExit;
    const deadline = Date.now() + 5000;
    while (ticks === pausedTicks && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(ticks > pausedTicks, "synthetic process did not resume after controller termination");
    assert.equal(fixture.exitCode, null);
  } finally {
    if (controller && controller.exitCode === null && controller.signalCode === null) {
      const exited = once(controller, "exit");
      controller.kill();
      await exited;
    }
    if (fixture.exitCode === null && fixture.signalCode === null) {
      const exited = once(fixture, "exit");
      fixture.kill();
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
