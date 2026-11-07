import { randomBytes } from "node:crypto";
import { parseStrictJson } from "../http/strict-json.ts";
import { observeWechatQuery, verifyWechatQueryEvidence } from "./wechat-evidence.ts";

const ORIGIN = "https://api.mch.weixin.qq.com";
const MAX_RESPONSE_BYTES = 64 * 1024;

// All identities, keys and the transport must be supplied by trusted server state.
export async function queryWechatOrderReadonly(options: {
  readonly expected: { readonly appId: string; readonly merchantId: string; readonly tradeNo: string; readonly providerTradeNo: string; readonly amountCents: number; readonly platformKey: string; readonly platformKeyId: string };
  readonly sign: (message: string) => { serial: string; signature: string };
  readonly transport: typeof fetch;
  readonly clock?: () => number;
}) {
  const { expected } = options;
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(expected.merchantId) || !/^[A-Za-z0-9_-]{1,64}$/.test(expected.tradeNo) || !/^[A-Za-z0-9_-]{1,128}$/.test(expected.providerTradeNo) || !expected.appId || !expected.platformKey || !expected.platformKeyId || !Number.isSafeInteger(expected.amountCents) || expected.amountCents < 1 || typeof options.sign !== "function" || typeof options.transport !== "function") throw new Error("invalid WeChat order query configuration");
  const clock = options.clock ?? Date.now;
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid WeChat query time");
  const target = new URL(`/v3/pay/transactions/out-trade-no/${expected.tradeNo}`, ORIGIN);
  target.searchParams.set("mchid", expected.merchantId);
  const nonce = randomBytes(16).toString("hex"), timestamp = String(Math.floor(now / 1000));
  const signed = options.sign(`GET\n${target.pathname}${target.search}\n${timestamp}\n${nonce}\n\n`);
  if (!signed || !/^[A-Za-z0-9_-]{1,128}$/.test(signed.serial) || !/^[A-Za-z0-9+/]+={0,2}$/.test(signed.signature)) throw new Error("invalid WeChat request signature");
  const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${expected.merchantId}",nonce_str="${nonce}",signature="${signed.signature}",timestamp="${timestamp}",serial_no="${signed.serial}"`;
  let response: Response;
  try { response = await options.transport(target, { method: "GET", headers: { accept: "application/json", authorization }, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000) }); }
  catch { throw new Error("WeChat order query transport failed"); }
  if (response.status !== 200 || !(response.headers.get("content-type") ?? "").toLowerCase().includes("application/json") || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("WeChat order query response unavailable");
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("response too large");
      chunks.push(part.value);
    }
  } catch { throw new Error("WeChat order query response could not be read"); }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const verifiedAt = clock();
  if (!Number.isSafeInteger(verifiedAt) || verifiedAt < now) throw new Error("invalid WeChat verification time");
  const body = Buffer.concat(chunks), verification = { ...expected, now: verifiedAt };
  const observation = observeWechatQuery(body, response.headers, verification);
  if (observation.state === "SUCCESS" && verifyWechatQueryEvidence(body, response.headers, verification).providerTradeNo !== expected.providerTradeNo) throw new Error("WeChat transaction identity mismatch");
  if (observation.state === "REFUND") {
    const transaction = parseStrictJson(body) as Record<string, unknown>;
    if (transaction.transaction_id !== expected.providerTradeNo) throw new Error("WeChat transaction identity mismatch");
  }
  return observation;
}
