import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { AppDatabase } from "../database/database.ts";
import { authorizeMerchant, MerchantAccessError } from "./merchant-access.ts";

export type MerchantMutationOptions = {
  database: Pick<AppDatabase, "read" | "instanceId">; masterKey: Uint8Array;
  identityOrigin: string; publicOrigin: string; identityFetch?: typeof fetch | undefined; clock?: (() => number) | undefined;
};
const TTL_MS = 10 * 60 * 1000;
export function merchantMutationAuth(options: MerchantMutationOptions, purpose: "settlement" | "merchant-key" | "merchant-management" | "callback-retry" | "merchant-profile" | "payout") {
  const key = Buffer.from(hkdfSync("sha256", options.masterKey, options.database.instanceId(), `perpay:${purpose}-csrf:v1`, 32));
  const clock = options.clock ?? Date.now;
  const sign = (cookie: string, merchantId: string, userId: string, expiry: number) => createHmac("sha256", key).update(JSON.stringify([cookie, merchantId, userId, expiry])).digest("base64url");
  const authenticate = async (request: Request, write: boolean) => {
    const query = new URL(request.url).searchParams, ids = query.getAll("merchantId"), allowed = write ? ["merchantId"] : ["merchantId", "page"];
    if (ids.length !== 1 || !ids[0] || ids[0].length > 128 || [...query.keys()].some(name => !allowed.includes(name) || query.getAll(name).length !== 1)) throw new MerchantAccessError("forbidden");
    const cookie = request.headers.get("cookie") ?? "";
    const access = await authorizeMerchant({ database: options.database, origin: options.identityOrigin, cookie, merchantId: ids[0], ...(options.identityFetch ? { fetch: options.identityFetch } : {}) });
    if (!access.userId) throw new MerchantAccessError("forbidden");
    if (write) {
      if (request.headers.get("origin") !== options.publicOrigin || request.headers.get("sec-fetch-site") === "cross-site") throw new MerchantAccessError("forbidden");
      const token = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(request.headers.get("x-csrf-token") ?? "");
      const expiry = Number(token?.[1]), now = clock();
      if (!token || !Number.isSafeInteger(now) || expiry <= now || expiry - now > TTL_MS || !timingSafeEqual(Buffer.from(token[2]!), Buffer.from(sign(cookie, access.merchantId, access.userId, expiry)))) throw new MerchantAccessError("forbidden");
    }
    return { access, cookie };
  };
  return { authenticate, issue: (cookie: string, access: Awaited<ReturnType<typeof authorizeMerchant>>) => {
    if (!access.userId) throw new MerchantAccessError("forbidden");
    const expiry = clock() + TTL_MS;
    if (!Number.isSafeInteger(expiry)) throw new Error("invalid merchant session expiry");
    return `${expiry}.${sign(cookie, access.merchantId, access.userId, expiry)}`;
  } };
}
