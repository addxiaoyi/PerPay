import { Hono } from "hono";
import type { AppDatabase } from "../database/database.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { projectMerchantLedgerBalance } from "./ledger-balance.ts";
import { projectCombinedMerchantBalance } from "./combined-balance.ts";
import { authorizeMerchant, MerchantAccessError } from "./merchant-access.ts";
import { verifyWechatMasterKeyGuard } from "./wechat-master-key.ts";

const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;
const MAX_LEDGER_ROWS = 2000;

// The bounded shadow endpoint is not an authoritative balance service.
export function createShadowBalanceWorkspace(options: { database: Pick<AppDatabase, "read" | "instanceId">; masterKey: Uint8Array; identityOrigin: string; identityFetch?: typeof fetch }) {
  const app = new Hono();
  for (const path of ["/shadow-ledger-balance", "/shadow-combined-balance"]) app.get(path, async context => {
    context.header("Cache-Control", "no-store");
    const query = new URL(context.req.url).searchParams;
    const ids = query.getAll("merchantId");
    if (ids.length !== 1 || [...query.keys()].some(key => key !== "merchantId")) return context.json({ ok: false, error: "invalid_query" }, 400);
    try {
      const access = await authorizeMerchant({ origin: options.identityOrigin, cookie: context.req.header("cookie") ?? "", merchantId: ids[0]!, database: options.database, ...(options.identityFetch ? { fetch: options.identityFetch } : {}) });
      const cipher = new RuntimeSecretCipher(options.masterKey, options.database.instanceId());
      const balance = options.database.read(db => {
        if (db.isTransaction) throw new Error("nested shadow balance transaction");
        db.exec("BEGIN");
        try {
          const binding = db.prepare(`SELECT 1 FROM epay_merchant_bindings b JOIN epay_merchant_accounts m ON m.merchant_id=b.epay_merchant_id
            WHERE b.main_merchant_id=? AND b.main_api_id=? AND b.epay_merchant_id=? AND m.enabled=1`).get(access.merchantId, access.mainApiId, access.epayMerchantId);
          if (!binding) throw new MerchantAccessError("invalid_binding");
          verifyWechatMasterKeyGuard(db, cipher);
          const limits = db.prepare(`SELECT (SELECT length(ciphertext) FROM epay_main_payment_archive WHERE singleton_key=1) AS bytes,
            (SELECT count(*) FROM epay_balance_ledger) AS entries,
            (SELECT count(*) FROM epay_orders) AS orders,
            (SELECT count(*) FROM epay_main_order_sources) AS mainOrders,
            (SELECT count(*) FROM epay_invoice_applications) AS invoices,
            (SELECT count(*) FROM epay_callback_jobs) AS jobs`).get();
          if (!limits || limits.bytes === null || Number(limits.bytes) > MAX_ARCHIVE_BYTES || [limits.entries, limits.orders, limits.jobs, limits.mainOrders, limits.invoices].some(value => Number(value) > MAX_LEDGER_ROWS)) throw new Error("shadow balance exceeds resource limits");
          const projectBalance = path === "/shadow-combined-balance" ? projectCombinedMerchantBalance : projectMerchantLedgerBalance;
          const projection = projectBalance(db, cipher, access.epayMerchantId);
          db.exec("COMMIT");
          return projection;
        } catch (error) {
          if (db.isTransaction) db.exec("ROLLBACK");
          throw error;
        }
      });
      return context.json({ ok: true, data: { merchantId: access.merchantId, ...balance } });
    } catch (error) {
      if (error instanceof MerchantAccessError) {
        if (error.code === "unauthenticated") return context.json({ ok: false, error: "unauthenticated" }, 401);
        if (error.code === "forbidden" || error.code === "invalid_binding") return context.json({ ok: false, error: "merchant_not_found" }, 404);
      }
      return context.json({ ok: false, error: "service_unavailable" }, 503);
    }
  });
  return app;
}
