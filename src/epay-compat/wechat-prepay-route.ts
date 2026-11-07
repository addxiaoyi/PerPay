import { Hono } from "hono";
import type { AppDatabase } from "../database/database.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { authorizeMerchant, MerchantAccessError } from "./merchant-access.ts";
import { verifyWechatMasterKeyGuard } from "./wechat-master-key.ts";

const CODE_LIFETIME_MS = 2 * 60 * 60 * 1000;

// The caller must separately protect production ingress; this route is not mounted by default.
export function createWechatPrepayRoute(options: {
  database: Pick<AppDatabase, "read" | "instanceId">;
  masterKey: Uint8Array;
  identityOrigin: string;
  identityFetch?: typeof fetch;
  clock?: () => number;
}) {
  const app = new Hono();
  app.get("/orders/:tradeNo/wechat-code", async (context) => {
    context.header("Cache-Control", "no-store");
    const query = new URL(context.req.url).searchParams;
    const ids = query.getAll("merchantId"), tradeNo = context.req.param("tradeNo");
    if (ids.length !== 1 || [...query.keys()].some((key) => key !== "merchantId") || !/^[a-f0-9]{32}$/.test(tradeNo)) return context.json({ ok: false, error: "invalid_query" }, 400);
    try {
      const access = await authorizeMerchant({ origin: options.identityOrigin, cookie: context.req.header("cookie") ?? "", merchantId: ids[0]!, database: options.database, ...(options.identityFetch ? { fetch: options.identityFetch } : {}) });
      const now = (options.clock ?? Date.now)();
      if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid clock");
      const cipher = new RuntimeSecretCipher(options.masterKey, options.database.instanceId());
      const codeUrl = options.database.read((db) => {
        verifyWechatMasterKeyGuard(db, cipher);
        const row = db.prepare(`SELECT p.nonce,p.ciphertext,p.authentication_tag,s.started_at FROM epay_wechat_prepay_results p
          JOIN epay_wechat_submissions s ON s.trade_no=p.trade_no AND s.attempt_id=p.attempt_id
          JOIN epay_orders o ON o.trade_no=p.trade_no
          JOIN epay_merchant_bindings b ON b.epay_merchant_id=o.merchant_id
          JOIN epay_merchant_accounts m ON m.merchant_id=o.merchant_id AND m.enabled=1
          WHERE p.trade_no=? AND b.main_merchant_id=? AND o.merchant_id=? AND b.main_api_id=? AND o.status='PENDING' AND s.state='UNCERTAIN'`).get(tradeNo, access.merchantId, access.epayMerchantId, access.mainApiId) as { nonce: Uint8Array; ciphertext: Uint8Array; authentication_tag: Uint8Array; started_at: bigint | number } | undefined;
        if (!row) return null;
        const started = Number(row.started_at);
        if (!Number.isSafeInteger(started) || started > now || now - started >= CODE_LIFETIME_MS) return null;
        const plain = cipher.decrypt(`epay:config:wechat-prepay:${tradeNo}`, 1, { cipherVersion: 1, nonce: Buffer.from(row.nonce), ciphertext: Buffer.from(row.ciphertext), authenticationTag: Buffer.from(row.authentication_tag) });
        try { return plain.toString("utf8"); } finally { plain.fill(0); }
      });
      if (codeUrl === null) return context.json({ ok: false, error: "not_found" }, 404);
      return context.json({ ok: true, data: { tradeNo, codeUrl } });
    } catch (error) {
      if (error instanceof MerchantAccessError) {
        if (error.code === "unauthenticated") return context.json({ ok: false, error: "unauthenticated" }, 401);
        if (error.code === "forbidden" || error.code === "invalid_binding") return context.json({ ok: false, error: "not_found" }, 404);
      }
      return context.json({ ok: false, error: "service_unavailable" }, 503);
    }
  });
  return app;
}
