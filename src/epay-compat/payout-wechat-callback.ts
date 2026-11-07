import { Hono } from "hono";
import { readBoundedBody } from "./main-order-auth.ts";
import type { WechatPayoutService } from "./payout-wechat.ts";

export function createWechatPayoutCallback(service: WechatPayoutService) {
  return new Hono().post("/notify", async context => {
    context.header("Cache-Control", "no-store");
    try {
      const bytes = await readBoundedBody(context.req.raw.body, 65536);
      service.notify(bytes, context.req.raw.headers);
      return context.body(null, 204);
    } catch { return context.json({ code: "FAIL", message: "授权通知未通过核验，请重试。" }, 400); }
  });
}
