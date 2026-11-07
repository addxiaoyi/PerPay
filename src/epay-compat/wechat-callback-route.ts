import { Hono } from "hono";
import type { AppDatabase } from "../database/database.ts";
import { confirmRegisteredWechatNotification } from "./wechat-credentials.ts";

const MAX_BODY_BYTES = 1024 * 1024;

// Intentionally unmounted until provider identity and ingress ownership are verified.
export function createWechatCallbackRoute(database: Pick<AppDatabase, "write" | "instanceId">, masterKey: Uint8Array, clock: () => number = Date.now) {
  const app = new Hono();
  app.post("/notify", async (context) => {
    const failure = () => context.json({ code: "FAIL", message: "notification rejected" }, 400);
    const contentType = (context.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    const length = context.req.header("content-length");
    if (contentType !== "application/json" || (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) || !context.req.raw.body) return failure();
    const reader = context.req.raw.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > MAX_BODY_BYTES) throw new Error("notification too large");
        chunks.push(part.value);
      }
      confirmRegisteredWechatNotification(database, masterKey, Buffer.concat(chunks), context.req.raw.headers, clock());
      return context.body(null, 204);
    } catch {
      return failure();
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  });
  return app;
}
