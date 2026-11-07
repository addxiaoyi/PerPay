import { Hono } from "hono";
import type { AppDatabase } from "../database/database.ts";
import { confirmAlipayPayment } from "./confirm-alipay.ts";
import { confirmIsolatedAlipay } from "./isolated-alipay-confirmation.ts";

const MAX_CALLBACK_BYTES = 32 * 1024;

// Deliberately not mounted until channel ownership and the ledger are reconciled.
export function createAlipayCallbackRoute(database: Pick<AppDatabase, "write">, clock: () => number = Date.now) {
  return callbackRoute((params) => confirmAlipayPayment(database, params, clock()));
}

export function createIsolatedAlipayCallbackRoute(database: Pick<AppDatabase, "write">, clock: () => number = Date.now) {
  return callbackRoute((params) => confirmIsolatedAlipay(database, params, clock()));
}

function callbackRoute(confirm: (params: Readonly<Record<string, string>>) => unknown) {
  const app = new Hono();
  app.post("/notify", async (context) => {
    const contentType = (context.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (contentType !== "application/x-www-form-urlencoded") return context.text("failure", 400);
    try {
      const params = await readCallback(context.req.raw);
      confirm(params);
      return context.text("success", 200);
    } catch {
      return context.text("failure", 400);
    }
  });
  return app;
}

async function readCallback(request: Request): Promise<Record<string, string>> {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_CALLBACK_BYTES)) throw new Error("invalid callback length");
  if (!request.body) throw new Error("empty callback");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let lengthRead = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      lengthRead += chunk.value.byteLength;
      if (lengthRead > MAX_CALLBACK_BYTES) throw new Error("callback too large");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))) {
    if (Object.hasOwn(fields, key)) throw new Error("duplicate callback field");
    fields[key] = value;
  }
  return fields;
}
