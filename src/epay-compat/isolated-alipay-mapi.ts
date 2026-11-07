import type { KeyObject } from "node:crypto";
import { Hono } from "hono";
import type { AppDatabase } from "../database/database.ts";
import type { V3Transport } from "../infrastructure/alipay/types.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { withAuthenticatedOrder } from "./authenticated-order.ts";
import { createExactAlipayOrder, exactAlipayFingerprint } from "./exact-alipay-order.ts";
import { submitIsolatedAlipayPrecreate } from "./isolated-alipay-client.ts";
import { readEPayParams } from "./shadow-gateway.ts";
import { isolatedCheckout } from "./isolated-checkout.ts";
import { issueCheckoutToken } from "./isolated-checkout-status.ts";
import { expirationMinutes, orderAcceptsPayment } from "./order-expiration.ts";

const QR_LIFETIME_MS = 2 * 60 * 60 * 1000;
type Database = Pick<AppDatabase, "read" | "write" | "instanceId">;

// Transport injection keeps provider writes outside unit tests.
export function createIsolatedAlipayMAPI(options: { database: Database; masterKey: Uint8Array; privateKey: KeyObject | string; notifyUrl: string; transport: V3Transport; appCertSn?: string; alipayRootCertSn?: string; clock?: () => number }) {
  const app = new Hono();
  app.on(["GET", "POST"], ["/mapi.php", "/submit.php"], async (context) => {
    context.header("Cache-Control", "no-store");
    const mode = context.req.path === "/submit.php" ? "page" : "api";
    let params: Record<string, string>;
    let tradeNo: string;
    try {
      const url = new URL(context.req.url);
      if (context.req.url.length > 16_384 || (context.req.method === "POST" && url.search)) throw new Error("invalid request target");
      params = await readEPayParams(context.req.raw);
      tradeNo = createExactAlipayOrder(options.database, options.masterKey, params, mode, (options.clock ?? Date.now)()).tradeNo;
    } catch {
      return context.json({ code: -1, msg: "invalid or unavailable order", isolated: true }, 400);
    }
    let submitted: boolean;
    try {
      const now = (options.clock ?? Date.now)();
      const cipher = new RuntimeSecretCipher(options.masterKey, options.database.instanceId());
      submitted = options.database.read((db) => {
        const row = db.prepare("SELECT status,created_at FROM epay_orders WHERE trade_no=?").get(tradeNo) as { status: string; created_at: number | bigint } | undefined;
        if (!row || row.status !== "PENDING" || !orderAcceptsPayment(row.created_at, now, expirationMinutes(db, cipher))) throw new Error("order unavailable");
        return !!db.prepare("SELECT 1 FROM epay_alipay_submissions WHERE trade_no=?").get(tradeNo);
      });
    } catch {
      return context.json({ code: -1, msg: "order unavailable", isolated: true }, 409);
    }
    if (!submitted) {
      try { await submitIsolatedAlipayPrecreate({ ...options, tradeNo }); }
      catch { /* Read the durable submission state before responding. */ }
    }
    try {
      const now = (options.clock ?? Date.now)();
      if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid clock");
      const cipher = new RuntimeSecretCipher(options.masterKey, options.database.instanceId());
      const result = withAuthenticatedOrder(options.database, options.masterKey, params, mode, (db, order) => {
        const row = db.prepare(`SELECT o.status,o.created_at,r.client_id,q.request_fingerprint,s.state,s.started_at,p.nonce,p.ciphertext,p.authentication_tag
          FROM epay_orders o JOIN epay_alipay_orders r ON r.trade_no=o.trade_no
          JOIN epay_alipay_requests q ON q.trade_no=o.trade_no
          LEFT JOIN epay_alipay_submissions s ON s.trade_no=o.trade_no
          LEFT JOIN epay_alipay_prepay p ON p.trade_no=s.trade_no AND p.attempt_id=s.attempt_id
          WHERE o.trade_no=? AND o.merchant_id=? AND o.out_trade_no=? AND o.type_code=? AND o.money_cents=? AND o.name=?
            AND o.notify_url=? AND o.return_url IS ? AND o.param IS ? AND o.device=?`).get(tradeNo, order.merchantId, order.merchantOrderNo, order.type, order.amountCents, order.name, order.notifyUrl, order.returnUrl || null, order.param || null, order.device) as { status: string; created_at: number | bigint; client_id: string; request_fingerprint: string; state: string | null; started_at: number | bigint | null; nonce: Uint8Array | null; ciphertext: Uint8Array | null; authentication_tag: Uint8Array | null } | undefined;
        if (!row || row.client_id !== order.siteClientId || row.request_fingerprint !== exactAlipayFingerprint(order)) throw new Error("order identity changed");
        if (row.status !== "PENDING" || !orderAcceptsPayment(row.created_at, now, expirationMinutes(db, cipher))) return { status: "unavailable" as const };
        if (row.state === null) return { status: "unavailable" as const };
        if (row.state !== "UNCERTAIN" || !row.nonce || !row.ciphertext || !row.authentication_tag || row.started_at === null) return { status: "pending" as const };
        const started = Number(row.started_at);
        if (!Number.isSafeInteger(started) || started > now || now - started >= QR_LIFETIME_MS) return { status: "unavailable" as const };
        const plain = cipher.decrypt(`epay:config:alipay-prepay:${tradeNo}`, 1, { cipherVersion: 1, nonce: Buffer.from(row.nonce), ciphertext: Buffer.from(row.ciphertext), authenticationTag: Buffer.from(row.authentication_tag) });
        try { return { status: "ready" as const, qrCode: plain.toString("utf8"), name: order.name, amountCents: order.amountCents, merchantId: order.merchantId }; } finally { plain.fill(0); }
      });
      if (result.status === "ready") return mode === "page" ? await isolatedCheckout(result.qrCode, result.name, result.amountCents, issueCheckoutToken(options.masterKey, options.database.instanceId(), tradeNo, result.merchantId, now)) : context.json({ code: 1, trade_no: tradeNo, qrcode: result.qrCode, isolated: true });
      if (result.status === "pending") return context.json({ code: 0, trade_no: tradeNo, msg: "submission requires reconciliation", isolated: true }, 202);
      return context.json({ code: -1, msg: "order unavailable", isolated: true }, 409);
    } catch {
      return context.json({ code: -1, msg: "invalid or unavailable order", isolated: true }, 400);
    }
  });
  return app;
}
