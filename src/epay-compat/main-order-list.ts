import { Hono } from "hono";
import type { AppDatabase } from "../database/database.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { authorizeMerchant, MerchantAccessError } from "./merchant-access.ts";
import { readCurrentMainPayment } from "./main-delta-store.ts";
import { readMainOrder } from "./main-order-view.ts";
import { resolveDefaultMerchant } from "./default-merchant.ts";

type Options = { database: Pick<AppDatabase, "read" | "instanceId">; masterKey: Uint8Array; identityOrigin: string; send?: typeof fetch | undefined; clock?: (() => number) | undefined };
export function createMainOrderList(options: Options) {
  const app = new Hono();
  app.get("/orders", async context => {
    const query = new URL(context.req.url).searchParams;
    const allowed = new Set(["merchantId", "status", "page", "pageSize", "search"]);
    if ([...query.keys()].some(key => !allowed.has(key) || query.getAll(key).length !== 1)) return context.json({ ok: false, error: "invalid_query" }, 400);
    const page = query.get("page") ?? "1", size = query.get("pageSize") ?? "50", search = query.get("search") ?? "";
    if (!/^[1-9]\d{0,4}$/.test(page) || !/^[1-9]\d{0,2}$/.test(size) || Number(size) > 100 || search.length > 128) return context.json({ ok: false, error: "invalid_query" }, 400);
    const cookie = context.req.header("cookie") ?? "";
    if (!cookie || cookie.length > 8192) throw new MerchantAccessError("unauthenticated");
    let merchantId = query.get("merchantId");
    if (!merchantId) {
      merchantId = await resolveDefaultMerchant({ database: options.database, identityOrigin: options.identityOrigin, cookie, send: options.send });
    }
    const access = await authorizeMerchant({ database: options.database, origin: options.identityOrigin, cookie, merchantId, ...(options.send ? { fetch: options.send } : {}) });
    const orders = options.database.read(sql => {
      if (!sql.prepare("SELECT 1 FROM epay_merchant_bindings b JOIN epay_merchant_accounts m ON m.merchant_id=b.epay_merchant_id WHERE b.main_merchant_id=? AND b.main_api_id=? AND b.epay_merchant_id=? AND m.enabled=1").get(merchantId, access.mainApiId, access.epayMerchantId)) throw new MerchantAccessError("invalid_binding");
      const source = readCurrentMainPayment(sql, new RuntimeSecretCipher(options.masterKey, options.database.instanceId())).payment;
      const fields = ["id", "merchantOrderId", "merchantId", "channel", "name", "subject", "amountCents", "platformFeeCents", "merchantNetCents", "status", "tradeNo", "expiresAt", "createdAt", "paidAt", "refundStatus"];
      const historical = source.orders.filter(row => row.merchantId === merchantId).map(row => Object.fromEntries(fields.map(key => [key, row[key] ?? null])));
      const current = sql.prepare("SELECT order_id FROM epay_main_native_orders WHERE merchant_id=? AND main_merchant_id=?").all(access.epayMerchantId, merchantId)
        .map(row => readMainOrder(options, String(row.order_id), access.epayMerchantId, (options.clock ?? Date.now)()));
      return [...historical, ...current].filter(row => (!query.get("status") || row.status === query.get("status")) && (!search || String(row.merchantOrderId).includes(search) || String(row.id).includes(search)))
        .sort((left, right) => Date.parse(String(right.createdAt)) - Date.parse(String(left.createdAt)) || String(left.id).localeCompare(String(right.id)));
    });
    const offset = (Number(page) - 1) * Number(size);
    return context.json({ ok: true, orders: orders.slice(offset, offset + Number(size)), hasNext: orders.length > offset + Number(size), total: orders.length });
  });
  return app;
}
