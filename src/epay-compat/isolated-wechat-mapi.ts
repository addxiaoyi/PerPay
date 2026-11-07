import { Hono } from "hono";
import type { AppDatabase } from "../database/database.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { withAuthenticatedOrder } from "./authenticated-order.ts";
import { createExactWechatOrder, exactWechatFingerprint } from "./exact-wechat-order.ts";
import { readEPayParams } from "./shadow-gateway.ts";
import { verifyWechatMasterKeyGuard } from "./wechat-master-key.ts";
import { submitWechatNative } from "./wechat-native-client.ts";
import { isolatedCheckout } from "./isolated-checkout.ts";
import { issueCheckoutToken } from "./isolated-checkout-status.ts";
import { expirationMinutes, orderAcceptsPayment } from "./order-expiration.ts";

const CODE_LIFETIME_MS = 2 * 60 * 60 * 1000;
type Database = Pick<AppDatabase, "read" | "write" | "instanceId">;

// This adapter has no automatic production mount and must use isolated credentials and transport in tests.
export function createIsolatedWechatMAPI(options: {
  database: Database;
  masterKey: Uint8Array;
  credentialId: string;
  signingKeyId: string;
  notifyUrl: string;
  transport: typeof fetch;
  clock?: () => number;
}) {
  const app = new Hono();
  app.on(["GET", "POST"], ["/mapi.php", "/submit.php"], async (context) => {
    context.header("Cache-Control", "no-store");
    const mode = context.req.path === "/submit.php" ? "page" : "api";
    let params: Record<string, string>;
    let tradeNo: string;
    try {
      const url = new URL(context.req.url);
      if (context.req.url.length > 16_384 || (context.req.method === "POST" && url.search !== "")) throw new Error("invalid request target");
      params = await readEPayParams(context.req.raw);
      tradeNo = createExactWechatOrder(options.database, options.masterKey, params, mode, options.credentialId, (options.clock ?? Date.now)()).tradeNo;
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
        return !!db.prepare("SELECT 1 FROM epay_wechat_submissions WHERE trade_no=?").get(tradeNo);
      });
    } catch {
      return context.json({ code: -1, msg: "order unavailable", isolated: true }, 409);
    }
    if (!submitted) {
      try { await submitWechatNative({ ...options, tradeNo }); }
      catch { /* The reservation or provider outcome is resolved by the read below. */ }
    }
    try {
      const now = (options.clock ?? Date.now)();
      if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid clock");
      const cipher = new RuntimeSecretCipher(options.masterKey, options.database.instanceId());
      const codeUrl = withAuthenticatedOrder(options.database, options.masterKey, params, mode, (db, request) => {
        verifyWechatMasterKeyGuard(db, cipher);
        const row = db.prepare(`SELECT o.status,o.created_at,r.request_fingerprint,p.nonce,p.ciphertext,p.authentication_tag,s.state,s.started_at
          FROM epay_orders o JOIN epay_exact_order_requests r ON r.trade_no=o.trade_no
          LEFT JOIN epay_wechat_submissions s ON s.trade_no=o.trade_no
          LEFT JOIN epay_wechat_prepay_results p ON p.trade_no=s.trade_no AND p.attempt_id=s.attempt_id
          WHERE o.trade_no=? AND o.merchant_id=? AND o.out_trade_no=?`).get(tradeNo, request.merchantId, request.merchantOrderNo) as { status: string; created_at: number | bigint; request_fingerprint: string; nonce: Uint8Array | null; ciphertext: Uint8Array | null; authentication_tag: Uint8Array | null; state: string | null; started_at: bigint | number | null } | undefined;
        if (!row || row.request_fingerprint !== exactWechatFingerprint(request)) throw new Error("order identity changed");
        if (row.status !== "PENDING" || !orderAcceptsPayment(row.created_at, now, expirationMinutes(db, cipher))) return { status: "unavailable" as const };
        if (row.state === null) return { status: "unavailable" as const };
        if (row.state !== "UNCERTAIN" || !row.nonce || !row.ciphertext || !row.authentication_tag || row.started_at === null) return { status: "pending" as const };
        const started = Number(row.started_at);
        if (!Number.isSafeInteger(started) || started > now || now - started >= CODE_LIFETIME_MS) return { status: "unavailable" as const };
        const plain = cipher.decrypt(`epay:config:wechat-prepay:${tradeNo}`, 1, { cipherVersion: 1, nonce: Buffer.from(row.nonce), ciphertext: Buffer.from(row.ciphertext), authenticationTag: Buffer.from(row.authentication_tag) });
        try { return { status: "ready" as const, codeUrl: plain.toString("utf8"), name: request.name, amountCents: request.amountCents, merchantId: request.merchantId }; } finally { plain.fill(0); }
      });
      if (codeUrl.status === "ready") return mode === "page" ? await isolatedCheckout(codeUrl.codeUrl, codeUrl.name, codeUrl.amountCents, issueCheckoutToken(options.masterKey, options.database.instanceId(), tradeNo, codeUrl.merchantId, now)) : context.json({ code: 1, trade_no: tradeNo, qrcode: codeUrl.codeUrl, isolated: true });
      if (codeUrl.status === "pending") return context.json({ code: 0, trade_no: tradeNo, msg: "submission requires reconciliation", isolated: true }, 202);
      return context.json({ code: -1, msg: "order unavailable", isolated: true }, 409);
    } catch {
      return context.json({ code: -1, msg: "invalid or unavailable order", isolated: true }, 400);
    }
  });
  return app;
}
