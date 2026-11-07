import { randomBytes } from "node:crypto";
import { observeWechatRefund, validateWechatRefundExpectation, type RefundExpectation } from "./wechat-evidence.ts";

const ORIGIN = "https://api.mch.weixin.qq.com";
const MAX_RESPONSE_BYTES = 64 * 1024;

type ExpectedRefund = Omit<RefundExpectation, "now"> & { readonly merchantId: string };

// The caller must obtain the order, refund identity and credentials from trusted server state.
export async function queryWechatRefund(options: {
  readonly expected: ExpectedRefund;
  readonly sign: (message: string) => { serial: string; signature: string };
  readonly transport: typeof fetch;
  readonly clock?: () => number;
}) {
  const { expected } = options;
  if (typeof expected.merchantId !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(expected.merchantId) || typeof expected.refundNo !== "string" || !/^[A-Za-z0-9_|*@-]{1,64}$/.test(expected.refundNo) || typeof options.sign !== "function" || typeof options.transport !== "function") throw new Error("invalid WeChat refund query configuration");
  const clock = options.clock ?? Date.now;
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid WeChat refund query time");
  validateWechatRefundExpectation({ ...expected, now });
  const target = new URL(`/v3/refund/domestic/refunds/${encodeURIComponent(expected.refundNo)}`, ORIGIN);
  const nonce = randomBytes(16).toString("hex");
  const timestamp = String(Math.floor(now / 1000));
  const signed = options.sign(`GET\n${target.pathname}\n${timestamp}\n${nonce}\n\n`);
  if (!signed || typeof signed.serial !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(signed.serial) || typeof signed.signature !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(signed.signature)) throw new Error("invalid WeChat refund request signature");
  const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${expected.merchantId}",nonce_str="${nonce}",signature="${signed.signature}",timestamp="${timestamp}",serial_no="${signed.serial}"`;
  let response: Response;
  try {
    response = await options.transport(target, { method: "GET", headers: { accept: "application/json", authorization }, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000) });
  } catch { throw new Error("WeChat refund query transport failed"); }
  if (response.status !== 200 || !(response.headers.get("content-type") ?? "").toLowerCase().includes("application/json") || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("WeChat refund query response unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("response too large");
      chunks.push(part.value);
    }
  } catch { throw new Error("WeChat refund query response could not be read"); }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const verifiedAt = clock();
  if (!Number.isSafeInteger(verifiedAt) || verifiedAt < now) throw new Error("invalid WeChat refund verification time");
  return observeWechatRefund(Buffer.concat(chunks), response.headers, { ...expected, now: verifiedAt });
}
