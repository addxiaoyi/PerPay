import { Hono } from "hono";
import type { AppDatabase } from "../database/database.ts";
import { createExactWechatOrder } from "./exact-wechat-order.ts";
import { readEPayParams } from "./shadow-gateway.ts";

// This endpoint creates an intent only; it must not be exposed as a payment gateway.
export function createIsolatedOrderRoute(options: {
  database: Pick<AppDatabase, "write" | "instanceId">;
  masterKey: Uint8Array;
  credentialId: string;
  clock?: () => number;
}) {
  const app = new Hono();
  app.on(["GET", "POST"], ["/submit.php", "/mapi.php"], async (context) => {
    context.header("Cache-Control", "no-store");
    try {
      const url = new URL(context.req.url);
      if (context.req.url.length > 16_384 || (context.req.method === "POST" && url.search !== "")) throw new Error("invalid request target");
      const params = await readEPayParams(context.req.raw);
      const mode = context.req.path === "/mapi.php" ? "api" : "page";
      const order = createExactWechatOrder(options.database, options.masterKey, params, mode, options.credentialId, (options.clock ?? Date.now)());
      return context.json({ code: 0, trade_no: order.tradeNo, created: order.created, isolated: true, payable: false }, 202);
    } catch {
      return context.json({ code: -1, message: "invalid or unavailable order", isolated: true }, 400);
    }
  });
  return app;
}
