import type { AppDatabase } from "../database/database.ts";
import { confirmWechatPayment } from "./confirm-wechat.ts";
import { resolveWechatTradeNo, type WechatCredential } from "./wechat-evidence.ts";

// This entry point is intentionally unmounted until trusted credential lifecycle is implemented.
export function confirmWechatNotification(
  database: Pick<AppDatabase, "write" | "instanceId">,
  masterKey: Uint8Array,
  credentials: readonly WechatCredential[],
  rawBody: Uint8Array,
  headers: Headers,
  now: number,
) {
  const tradeNo = resolveWechatTradeNo(rawBody, headers, credentials, now);
  return confirmWechatPayment(database, masterKey, tradeNo, rawBody, headers, now);
}
