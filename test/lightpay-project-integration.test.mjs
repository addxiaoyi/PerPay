import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const candidate = process.env.LIGHTPAY_CANDIDATE ?? resolve(here, "fixtures/lightpay-project.php");
const hasPhp = spawnSync("php", ["-v"], { stdio: "ignore" }).status === 0;

test("bridge rejects another merchant without altering the stored order", { skip: !hasPhp }, async () => {
  const root = await mkdtemp(join(tmpdir(), "lightpay-test-"));
  const servers = [];
  try {
    await cp(join(here, "fixtures/lightpay-bridge"), root, { recursive: true });
    await mkdir(join(root, "api"));
    await cp(candidate, join(root, "api/project.php"));
    await writeFile(join(root, "secret"), "test-only-bridge");
    const db = new DatabaseSync(join(root, "orders.sqlite"));
    db.exec("CREATE TABLE orders (id TEXT PRIMARY KEY, amount TEXT NOT NULL, sponsor_name TEXT, merchant_id TEXT, callback_url TEXT, signing_secret TEXT, return_url TEXT, status TEXT, created_at TEXT)");
    const id = "01234567-0123-0123-0123-0123456789ab";
    const legacyId = "11234567-0123-0123-0123-0123456789ab";
    db.prepare("INSERT INTO orders (id, amount, merchant_id, status) VALUES (?, ?, ?, ?)").run(id, "1.23", "merchant-a", "pending");
    db.prepare("INSERT INTO orders (id, amount, merchant_id, status) VALUES (?, ?, ?, ?)").run(legacyId, "1.23", null, "pending");
    db.close();
    async function startServer() {
      const reservation = createServer();
      await new Promise((ok, fail) => { reservation.once("error", fail); reservation.listen(0, "127.0.0.1", ok); });
      const port = reservation.address().port;
      await new Promise((ok, fail) => reservation.close((error) => error ? fail(error) : ok()));
      const server = spawn("php", ["-S", `127.0.0.1:${port}`, "-t", root], { stdio: "ignore" });
      servers.push(server);
      for (let attempt = 0; attempt < 50; attempt++) {
        if (server.exitCode !== null) throw new Error("PHP test server exited before becoming ready");
        try { await fetch(`http://127.0.0.1:${port}/`); return port; } catch { await new Promise((ok) => setTimeout(ok, 50)); }
      }
      throw new Error("PHP test server did not become ready");
    }
    const port = await startServer();
    const secondPort = await startServer();
    async function request(merchantId, amount = "1.23", orderId = id, token = "test-only-bridge", targetPort = port) {
      const response = await fetch(`http://127.0.0.1:${targetPort}/api/project.php`, { method: "POST", headers: { "content-type": "application/json", "x-internal-bridge": token }, body: JSON.stringify({ orderId, merchantId, amount }) });
      return { status: response.status, body: await response.json() };
    }
    assert.equal((await request("merchant-a")).status, 201);
    assert.deepEqual(await request("merchant-b"), { status: 409, body: { ok: false, error: "order_merchant_mismatch" } });
    assert.deepEqual(await request("merchant-a", "1.24"), { status: 409, body: { ok: false, error: "order_amount_mismatch" } });
    assert.deepEqual(await request("merchant-a", "1.23", legacyId), { status: 409, body: { ok: false, error: "order_merchant_mismatch" } });
    assert.deepEqual(await request("merchant-a", "1.23", id, "wrong"), { status: 401, body: { ok: false, error: "bridge_unauthorized" } });
    const check = new DatabaseSync(join(root, "orders.sqlite"), { readOnly: true });
    try { assert.deepEqual({ ...check.prepare("SELECT merchant_id, amount FROM orders WHERE id = ?").get(id) }, { merchant_id: "merchant-a", amount: "1.23" }); } finally { check.close(); }
    for (let index = 0; index < 20; index++) {
      const raceId = randomUUID();
      const attempts = await Promise.all([request("merchant-a", "1.23", raceId), request("merchant-b", "1.23", raceId, "test-only-bridge", secondPort)]);
      const checkRace = new DatabaseSync(join(root, "orders.sqlite"), { readOnly: true });
      let owner;
      try { owner = checkRace.prepare("SELECT merchant_id FROM orders WHERE id = ?").get(raceId)?.merchant_id; } finally { checkRace.close(); }
      assert.ok(owner === "merchant-a" || owner === "merchant-b");
      assert.equal(attempts[owner === "merchant-a" ? 0 : 1].status, 201);
      assert.notEqual(attempts[owner === "merchant-a" ? 1 : 0].status, 201, "different merchant must not receive a payment response");
      assert.equal((await request(owner === "merchant-a" ? "merchant-b" : "merchant-a", "1.23", raceId)).status, 409);
    }
    for (let index = 0; index < 50; index++) {
      const raceId = randomUUID();
      const attempts = await Promise.all([request("merchant-a", "1.23", raceId), request("merchant-a", "1.23", raceId, "test-only-bridge", secondPort)]);
      assert.deepEqual(attempts.map((attempt) => attempt.status), [201, 201], "same-merchant concurrent retries should both succeed");
      const checkRace = new DatabaseSync(join(root, "orders.sqlite"), { readOnly: true });
      try {
        assert.equal(checkRace.prepare("SELECT count(*) AS count FROM orders WHERE id = ? AND merchant_id = ? AND amount = ?").get(raceId, "merchant-a", "1.23").count, 1);
      } finally { checkRace.close(); }
    }
  } finally {
    await Promise.all(servers.map(async (server) => {
      if (server.exitCode !== null || server.signalCode !== null) return;
      server.kill();
      await new Promise((ok) => server.once("exit", ok));
    }));
    await rm(root, { recursive: true, force: true });
  }
});
