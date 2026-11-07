import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { parseStrictJson } from "../http/strict-json.ts";

const SNAPSHOT_PATH = "/api/internal/payment/migration-snapshot";
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const SNAPSHOT_WINDOW_MS = 5000;

export async function readMainMemorySnapshot(options: { origin: string; secret: Uint8Array; send?: typeof fetch; clock?: () => number }) {
  const origin = new URL(options.origin);
  if (origin.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(origin.hostname) || origin.pathname !== "/" || origin.username || origin.password || origin.search || origin.hash || options.secret.length !== 32) throw new Error("invalid main snapshot source");
  const clock = options.clock ?? Date.now;
  const startedAt = clock(), nonce = randomBytes(16).toString("hex");
  if (!Number.isSafeInteger(startedAt) || startedAt < 0) throw new Error("invalid main snapshot clock");
  const auth = createHmac("sha256", options.secret).update(`GET\n${SNAPSHOT_PATH}\n${nonce}\n${startedAt}`).digest("hex");
  const response = await (options.send ?? fetch)(new URL(SNAPSHOT_PATH, origin), {
    method: "GET", headers: { accept: "application/json", "x-perpay-snapshot-nonce": nonce, "x-perpay-snapshot-time": String(startedAt), "x-perpay-snapshot-auth": auth },
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(SNAPSHOT_WINDOW_MS),
  });
  if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("application/json") || !response.body) throw new Error("main snapshot is unavailable");
  const signature = response.headers.get("x-perpay-snapshot-signature");
  if (!signature || !/^[a-f0-9]{64}$/.test(signature)) throw new Error("main snapshot signature is missing");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_SNAPSHOT_BYTES) throw new Error("main snapshot exceeds limit");
      chunks.push(part.value);
    }
    const raw = Buffer.concat(chunks);
    if (!timingSafeEqual(createHmac("sha256", options.secret).update(raw).digest(), Buffer.from(signature, "hex"))) throw new Error("main snapshot signature differs");
    const parsed = parseStrictJson(raw) as { version?: unknown; nonce?: unknown; capturedAt?: unknown; payment?: unknown };
    const endedAt = clock();
    const captured = typeof parsed?.capturedAt === "string" ? Date.parse(parsed.capturedAt) : NaN;
    if (parsed.version !== 1 || parsed.nonce !== nonce || !Number.isSafeInteger(captured) || captured < startedAt || captured > endedAt || endedAt - startedAt > SNAPSHOT_WINDOW_MS || !parsed.payment || typeof parsed.payment !== "object" || Array.isArray(parsed.payment)) throw new Error("main snapshot identity or time differs");
    return { payment: parsed.payment, capturedAt: parsed.capturedAt as string, responseSha256: createHash("sha256").update(raw).digest("hex") };
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
