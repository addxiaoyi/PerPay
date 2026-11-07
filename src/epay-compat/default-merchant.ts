import type { AppDatabase } from "../database/database.ts";
import { authorizeMerchant, MerchantAccessError } from "./merchant-access.ts";

export async function resolveDefaultMerchant(options: {
  database: Pick<AppDatabase, "read">; identityOrigin: string; cookie: string; send?: typeof fetch | undefined;
}) {
  if (!options.cookie || options.cookie.length > 8192) throw new MerchantAccessError("unauthenticated");
  const candidates = options.database.read(sql => sql.prepare(`SELECT b.main_merchant_id FROM epay_merchant_bindings b
    JOIN epay_merchant_accounts m ON m.merchant_id=b.epay_merchant_id WHERE m.enabled=1 ORDER BY m.merchant_id LIMIT 101`).all());
  if (candidates.length > 100) throw new MerchantAccessError("unavailable");
  const available: string[] = [];
  for (const row of candidates) {
    try {
      const access = await authorizeMerchant({ database: options.database, origin: options.identityOrigin, cookie: options.cookie,
        merchantId: String(row.main_merchant_id), ...(options.send ? { fetch: options.send } : {}) });
      available.push(access.merchantId);
      if (available.length > 1) throw new MerchantAccessError("forbidden");
    } catch (error) {
      if (!(error instanceof MerchantAccessError) || error.code !== "forbidden" || available.length > 1) throw error;
    }
  }
  if (available.length !== 1) throw new MerchantAccessError("forbidden");
  return available[0]!;
}
