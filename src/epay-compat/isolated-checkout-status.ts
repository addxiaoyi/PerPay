import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { AppDatabase } from "../database/database.ts";
import { readConfirmedOrder } from "./confirmed-order.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { readOrderSigningSecret } from "./merchant-secret.ts";
import { buildEPayReturnUrl } from "./notification.ts";
import { PublicCheckoutRateLimiter } from "../http/public-checkout-rate-limit.ts";
import { readMainCallback, mainReturnUrl } from "./main-callback.ts";

const LIFETIME_MS = 2 * 60 * 60 * 1000;
type Database = Pick<AppDatabase, "read" | "instanceId">;

function signature(key: Uint8Array, instanceId: string, payload: string): Buffer {
  if (key.byteLength !== 32 || !instanceId) throw new Error("invalid checkout signing configuration");
  return createHmac("sha256", key).update(`epay-checkout-status-v1:${instanceId}:${payload}`).digest();
}

export function issueCheckoutToken(key: Uint8Array, instanceId: string, tradeNo: string, merchantId: number, now: number): string {
  if (!/^[a-f0-9]{32}$/.test(tradeNo) || !Number.isSafeInteger(merchantId) || merchantId < 1 || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + LIFETIME_MS)) throw new Error("invalid checkout identity");
  const payload = `${tradeNo}.${merchantId}.${now + LIFETIME_MS}`;
  return `${payload}.${signature(key, instanceId, payload).toString("base64url")}`;
}

export function verifyCheckoutToken(token: string, key: Uint8Array, instanceId: string, now: number): { tradeNo: string; merchantId: number } | null {
  const parts = /^([a-f0-9]{32})\.([1-9]\d{0,15})\.([1-9]\d{0,15})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!parts || !Number.isSafeInteger(now) || now < 0) return null;
  const merchantId = Number(parts[2]), expires = Number(parts[3]);
  if (!Number.isSafeInteger(merchantId) || !Number.isSafeInteger(expires) || expires <= now || expires > now + LIFETIME_MS) return null;
  const received = Buffer.from(parts[4]!, "base64url");
  const expected = signature(key, instanceId, `${parts[1]}.${parts[2]}.${parts[3]}`);
  if (received.length !== expected.length || received.toString("base64url") !== parts[4] || !timingSafeEqual(received, expected)) return null;
  return { tradeNo: parts[1]!, merchantId };
}

// Status is an isolated capability, not a merchant session or payment authority.
export function createIsolatedCheckoutStatus(database: Database, key: Uint8Array, clock: () => number = Date.now, limiter = new PublicCheckoutRateLimiter({ sourceBurst: 1200, sourceRequestsPerSecond: 200 })) {
  const app = new Hono();
  const cipher = new RuntimeSecretCipher(key, database.instanceId());
  app.get("/checkout-status", (context) => {
    context.header("Cache-Control", "no-store");
    if (!limiter.take("unknown")) {
      context.header("Retry-After", "1");
      return context.json({ status: "rate_limited" }, 429);
    }
    const token = context.req.header("x-checkout-token") ?? "";
    const identity = verifyCheckoutToken(token, key, database.instanceId(), clock());
    if (!identity) return context.json({ status: "unavailable" }, 404);
    const status = database.read((db) => {
      const order = readConfirmedOrder(db, identity.tradeNo, identity.merchantId);
      if (order) {
        if (!order.return_url) return { status: "paid" as const };
        try {
          const main = readMainCallback(db, cipher, order);
          if (main) return { status: "paid" as const, returnUrl: mainReturnUrl(main, order.return_url) };
          const secret = readOrderSigningSecret(db, cipher, identity.merchantId, identity.tradeNo);
          const returnUrl = buildEPayReturnUrl({ merchantId: identity.merchantId, tradeNo: order.trade_no, merchantOrderNo: order.out_trade_no, type: order.type_code ?? "", name: order.name, amountCents: Number(order.money_cents), receivedAmountCents: Number(order.real_money_cents), paymentStatus: "CONFIRMED", param: order.param ?? "" }, secret, order.return_url);
          return { status: "paid" as const, returnUrl };
        } catch {
          return { status: "paid" as const, returnAvailable: false };
        }
      }
      const current = db.prepare("SELECT status FROM epay_orders WHERE trade_no=? AND merchant_id=?").get(identity.tradeNo, identity.merchantId);
      return { status: current?.status === "PENDING" ? "pending" as const : "unavailable" as const };
    });
    return context.json(status, status.status === "unavailable" ? 409 : 200);
  });
  return app;
}
