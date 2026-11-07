import { Hono } from "hono";
import { z } from "zod";
import type { AppDatabase } from "../database/database.ts";
import { parseStrictJson } from "../http/strict-json.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import type { captureSharedCutoff } from "./shared-cutoff.ts";
import { applySharedPaymentDelta, recordSourceSyncFailure } from "./shared-delta.ts";

type Capture = Awaited<ReturnType<typeof captureSharedCutoff>>;
const PURPOSE = "epay:config:shared-source-delivery";
const MAX_BODY_BYTES = 24 * 1024 * 1024;
const MAX_AGE_MS = 30_000;
const envelopeSchema = z.object({
  version: z.literal(1), nonce: z.string().regex(/^[a-f0-9]{24}$/),
  ciphertext: z.string().min(2).max(MAX_BODY_BYTES).regex(/^(?:[a-f0-9]{2})+$/),
  authenticationTag: z.string().regex(/^[a-f0-9]{32}$/),
}).strict();

export function sealSharedCapture(cipher: RuntimeSecretCipher, capture: Capture, issuedAt: number) {
  const sealed = cipher.encrypt(PURPOSE, 1, JSON.stringify({ version: 1, issuedAt, capture }));
  return { version: 1 as const, nonce: sealed.nonce.toString("hex"), ciphertext: sealed.ciphertext.toString("hex"), authenticationTag: sealed.authenticationTag.toString("hex") };
}

async function readEnvelope(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json" || !request.body) throw new Error("invalid source delivery content type");
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new Error("source delivery exceeds limit");
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new Error("source delivery exceeds limit");
      chunks.push(part.value);
    }
    return parseStrictJson(Buffer.concat(chunks));
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

// Only the running database owner posts financial deltas; collectors never acquire its lease.
export function createSourceSyncRoute(options: {
  database: Pick<AppDatabase, "write" | "instanceId">;
  masterKey: Uint8Array;
  clock?: () => number;
  onError: (code: string) => void;
}) {
  const app = new Hono(), cipher = new RuntimeSecretCipher(options.masterKey, options.database.instanceId());
  const clock = options.clock ?? Date.now;
  app.post("/internal/source-sync", async context => {
    context.header("Cache-Control", "no-store");
    let packet: { version: number; issuedAt: number; capture: Capture };
    const now = clock();
    try {
      const envelope = envelopeSchema.parse(await readEnvelope(context.req.raw));
      const plain = cipher.decrypt(PURPOSE, 1, { cipherVersion: 1, nonce: Buffer.from(envelope.nonce, "hex"), ciphertext: Buffer.from(envelope.ciphertext, "hex"), authenticationTag: Buffer.from(envelope.authenticationTag, "hex") });
      try { packet = parseStrictJson(plain) as typeof packet; } finally { plain.fill(0); }
      if (!packet || packet.version !== 1 || !Number.isSafeInteger(packet.issuedAt) || packet.issuedAt > now || now - packet.issuedAt > MAX_AGE_MS) throw new Error("source delivery is stale");
      const capture = packet.capture, cutoff = Date.parse(capture?.cutoff);
      if (!capture || capture.version !== 1 || capture.sharedCutoff !== true || !Number.isSafeInteger(cutoff) || cutoff > now || now - cutoff > MAX_AGE_MS ||
        !Number.isSafeInteger(capture.lockedAt) || !Number.isSafeInteger(capture.lockCompletedAt) || capture.lockedAt > cutoff || capture.lockCompletedAt < cutoff || capture.lockCompletedAt > now || capture.lockCompletedAt - capture.lockedAt > 10_000) throw new Error("source capture window differs");
    } catch { return context.json({ ok: false, error: "source_delivery_rejected" }, 403); }
    try {
      const report = applySharedPaymentDelta(options.database, cipher, packet.capture, now);
      return context.json({ ok: true, data: report });
    } catch {
      recordSourceSyncFailure(options.database, now);
      options.onError("epay_source_sync_failed");
      return context.json({ ok: false, error: "source_sync_failed" }, 503);
    }
  });
  return app;
}
