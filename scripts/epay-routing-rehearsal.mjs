import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

if (process.env.EPAY_ROUTING_REHEARSAL !== "1" || statfsSync("/dev/shm").type !== 0x01021994) throw new Error("explicit tmpfs routing rehearsal is required");
const nginx = "/usr/bin/nginx";
const directory = mkdtempSync("/dev/shm/perpay-routing-");
mkdirSync(join(directory, "logs"));
const config = join(directory, "nginx.conf");
const pid = join(directory, "nginx.pid");
const servers = [];
let master;
let stderr = "";

async function listen(owner) {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ owner, path: request.url, method: request.method }));
  });
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return server.address().port;
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function render(port, oldPort, newPort, mode) {
  const submit = mode === "cutover" ? `proxy_pass http://127.0.0.1:${newPort}/submit.php;` : "return 503;";
  const mapi = mode === "cutover" ? `proxy_pass http://127.0.0.1:${newPort}/mapi.php;` : "return 503;";
  return `pid ${pid}; error_log ${directory}/error.log notice; daemon off;
events { worker_connections 64; }
http { lua_package_path "/www/server/free_waf/?.lua;;"; access_log off; server { listen 127.0.0.1:${port};
  location = /pay/submit.php { ${submit} }
  location = /pay/mapi.php { ${mapi} }
  location = /pay/perpay/v1/alipay/notify { proxy_pass http://127.0.0.1:${newPort}/alipay/notify; }
  location = /pay/perpay/v1/wechat/notify { proxy_pass http://127.0.0.1:${newPort}/wechat/notify; }
  location ^~ /pay/perpay/v1/ { return 404; }
  location ^~ /pay/ { proxy_pass http://127.0.0.1:${oldPort}; }
} }
`;
}

async function expectRoute(port, path, status, owner, upstreamPath = path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body: "synthetic", signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, status, path);
  if (owner) assert.deepEqual(await response.json(), { owner, path: upstreamPath, method: "POST" });
}

try {
  const oldPort = await listen("legacy-fixture"), newPort = await listen("perpay-fixture"), port = await unusedPort();
  const install = mode => {
    writeFileSync(config, render(port, oldPort, newPort, mode), { mode: 0o600 });
    execFileSync(nginx, ["-t", "-p", `${directory}/`, "-c", config], { stdio: "pipe" });
  };
  install("maintenance");
  master = spawn(nginx, ["-p", `${directory}/`, "-c", config], { stdio: ["ignore", "ignore", "pipe"] });
  master.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (master.exitCode !== null) throw new Error(`isolated nginx exited before readiness: ${stderr} ${existsSync(join(directory, "error.log")) ? readFileSync(join(directory, "error.log"), "utf8").slice(-2000) : "no error log"}`);
    try { await expectRoute(port, "/pay/submit.php", 503); ready = true; break; } catch { await delay(50); }
  }
  if (!ready) throw new Error("isolated nginx did not become ready");
  const callbacks = async () => {
    await expectRoute(port, "/pay/api/pay/alipay/notify", 200, "legacy-fixture");
    await expectRoute(port, "/pay/api/pay/wechat/notify", 200, "legacy-fixture");
    await expectRoute(port, "/pay/notify.php", 200, "legacy-fixture");
    await expectRoute(port, "/pay/perpay/v1/alipay/notify", 200, "perpay-fixture", "/alipay/notify");
    await expectRoute(port, "/pay/perpay/v1/wechat/notify", 200, "perpay-fixture", "/wechat/notify");
    await expectRoute(port, "/pay/perpay/v1/mapi.php", 404);
    await expectRoute(port, "/pay/perpay/v1/submit.php", 404);
  };
  await expectRoute(port, "/pay/mapi.php", 503);
  await callbacks();
  for (const mode of ["cutover", "rollback"]) {
    install(mode);
    execFileSync(nginx, ["-p", `${directory}/`, "-c", config, "-s", "reload"], { stdio: "pipe" });
    const expected = mode === "cutover" ? 200 : 503;
    let switched = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { await expectRoute(port, "/pay/submit.php", expected, mode === "cutover" ? "perpay-fixture" : undefined, "/submit.php"); switched = true; break; } catch { await delay(50); }
    }
    if (!switched) throw new Error(`isolated nginx ${mode} failed`);
    await expectRoute(port, "/pay/mapi.php", expected, mode === "cutover" ? "perpay-fixture" : undefined, "/mapi.php");
    await callbacks();
  }
  console.log(JSON.stringify({ maintenance: true, cutover: true, rollback: true, oldCallbacksPreserved: true, newCallbacksPreserved: true, syntheticOnly: true, productionChanged: false }));
} finally {
  if (master && master.exitCode === null) {
    const exited = new Promise(resolve => master.once("exit", resolve));
    master.kill("SIGTERM");
    await exited;
  }
  await Promise.all(servers.map(server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  rmSync(directory, { recursive: true, force: true });
}
