import type { AppDatabase } from "../database/database.ts";
import type { DatabaseSync } from "node:sqlite";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { readMerchantSecret } from "./merchant-secret.ts";
import { validateEPayOrder, type EPayOrderRequest } from "./order-request.ts";

// This resolves only explicitly provisioned bindings; it does not create orders.
export function createAuthenticatedOrderValidator(database: Pick<AppDatabase, "read" | "instanceId">, masterKey: Uint8Array) {
  const cipher = new RuntimeSecretCipher(masterKey, database.instanceId());
  return (params: Readonly<Record<string, string>>, mode: "page" | "api") => database.read((db) => validateBoundOrder(db, cipher, params, mode));
}

export function withAuthenticatedOrder<T>(database: Pick<AppDatabase, "write" | "instanceId">, masterKey: Uint8Array, params: Readonly<Record<string, string>>, mode: "page" | "api", operation: (db: DatabaseSync, order: EPayOrderRequest) => T): T {
  const cipher = new RuntimeSecretCipher(masterKey, database.instanceId());
  return database.write((db) => {
    if (!db.isTransaction) throw new Error("order authentication requires a database transaction");
    const order = validateBoundOrder(db, cipher, params, mode);
    const value = operation(db, order);
    if (value !== null && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function") throw new Error("order transaction must be synchronous");
    return value;
  });
}

function validateBoundOrder(db: DatabaseSync, cipher: RuntimeSecretCipher, params: Readonly<Record<string, string>>, mode: "page" | "api"): EPayOrderRequest {
    if (!/^[1-9]\d{0,14}$/.test(params.pid ?? "")) throw new Error("merchant authentication failed");
    const merchantId = Number(params.pid);
    if (!Number.isSafeInteger(merchantId)) throw new Error("merchant authentication failed");
    const binding = db.prepare(`SELECT b.client_id FROM epay_site_bindings b
      JOIN epay_merchant_accounts m ON m.merchant_id=b.merchant_id AND m.enabled=1
      JOIN sites s ON s.client_id=b.client_id AND s.deleted_at IS NULL AND json_extract(s.configuration,'$.accepting_orders')=1
      JOIN api_client_config c ON c.client_id=s.client_id AND c.enabled=1
      WHERE b.merchant_id=?`).get(merchantId) as { client_id: string } | undefined;
    if (!binding) throw new Error("merchant authentication failed");
    let signingKey: string;
    try { signingKey = readMerchantSecret(db, cipher, merchantId); } catch { throw new Error("merchant authentication failed"); }
    return validateEPayOrder(params, { merchantId, enabled: true, signingKey, siteClientId: binding.client_id }, mode);
}
