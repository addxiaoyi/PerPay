import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { it } from "node:test";
import { readMainMemorySnapshot } from "../src/epay-compat/main-snapshot-client.ts";

it("accepts only the fresh authenticated memory snapshot for its request nonce", async () => {
  const secret = Buffer.alloc(32, 7), now = 1_800_000_000_000;
  let mode = "valid";
  const send: typeof fetch = async (request, init) => {
    const target = new URL(String(request)), headers = new Headers(init?.headers);
    assert.equal(target.origin, "http://127.0.0.1:8787");
    const nonce = headers.get("x-perpay-snapshot-nonce"), time = headers.get("x-perpay-snapshot-time");
    assert.equal(headers.get("x-perpay-snapshot-auth"), createHmac("sha256", secret).update(`GET\n${target.pathname}\n${nonce}\n${time}`).digest("hex"));
    const raw = JSON.stringify({ version: 1, nonce: mode === "nonce" ? "b".repeat(32) : nonce, capturedAt: new Date(mode === "stale" ? now - 6000 : now).toISOString(), payment: { orders: [{ id: "private-order" }], merchants: [] } });
    const signature = createHmac("sha256", secret).update(raw).digest("hex");
    return new Response(mode === "tampered" ? raw.replace("private-order", "forged-order") : raw, { headers: { "content-type": "application/json", "x-perpay-snapshot-signature": signature } });
  };
  const options = { origin: "http://127.0.0.1:8787", secret, send, clock: () => now };
  const snapshot = await readMainMemorySnapshot(options);
  assert.equal(snapshot.capturedAt, new Date(now).toISOString());
  assert.deepEqual(snapshot.payment, { orders: [{ id: "private-order" }], merchants: [] });
  for (mode of ["tampered", "nonce", "stale"]) await assert.rejects(readMainMemorySnapshot(options));
  await assert.rejects(readMainMemorySnapshot({ ...options, origin: "https://other.example" }));
  assert.deepEqual(secret, Buffer.alloc(32, 7));
});
