import type { KeyLike } from "node:crypto";
import { parseStrictJson } from "../http/strict-json.ts";
import type { RawV3Response, SignedV3Request } from "../infrastructure/alipay/types.ts";
import { signV3Request, verifyV3Response, type V3SignerOptions } from "../infrastructure/alipay/v3.ts";

const PRECREATE_PATH = "/v3/alipay/trade/precreate";
const MAX_AMOUNT_CENTS = 10_000_000_000;

export function validateAlipayPrecreateOrder(input: { tradeNo: string; amountCents: number; subject: string }): void {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(input.tradeNo) || !Number.isSafeInteger(input.amountCents) || input.amountCents < 1 || input.amountCents > MAX_AMOUNT_CENTS || !input.subject.trim() || [...input.subject].length > 256 || /[\x00-\x1f\x7f\/=&]/.test(input.subject)) throw new Error("invalid Alipay precreate order");
}

export function validateAlipayNotifyUrl(value: string): void {
  let notify: URL;
  try { notify = new URL(value); } catch { throw new Error("invalid Alipay notification URL"); }
  if (notify.protocol !== "https:" || !notify.hostname || notify.username || notify.password || notify.hash || value.length > 255 || /[\x00-\x20\x7f]/.test(value)) throw new Error("invalid Alipay notification URL");
}

export function buildAlipayPrecreate(input: { tradeNo: string; amountCents: number; subject: string; notifyUrl: string; sellerId?: string }, signer: V3SignerOptions): SignedV3Request {
  validateAlipayPrecreateOrder(input);
  validateAlipayNotifyUrl(input.notifyUrl);
  if (input.sellerId !== undefined && !/^[A-Za-z0-9_]{1,128}$/.test(input.sellerId)) throw new Error("invalid Alipay seller identity");
  const totalAmount = `${Math.floor(input.amountCents / 100)}.${String(input.amountCents % 100).padStart(2, "0")}`;
  return signV3Request({ method: "POST", path: PRECREATE_PATH, body: JSON.stringify({ out_trade_no: input.tradeNo, total_amount: totalAmount, subject: input.subject, notify_url: input.notifyUrl, ...(input.sellerId ? { seller_id: input.sellerId } : {}) }) }, signer);
}

// A signed precreate response supplies a QR code, never evidence of payment.
export function verifyAlipayPrecreate(response: RawV3Response, input: { tradeNo: string; platformKey: KeyLike | string; expectedCertSn?: string }): { tradeNo: string; qrCode: string } {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(input.tradeNo) || response.status !== 200) throw new Error("Alipay precreate requires reconciliation");
  const verified = verifyV3Response(response, input.platformKey, { expectedAlipayCertSn: input.expectedCertSn });
  const parsed = parseStrictJson(verified.bodyBytes);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid Alipay precreate response");
  const record = parsed as Record<string, unknown>;
  if (record.out_trade_no !== input.tradeNo || typeof record.qr_code !== "string" || record.qr_code.length > 1024 || /[\x00-\x20\x7f]/.test(record.qr_code)) throw new Error("Alipay precreate response does not match the order");
  let qr: URL;
  try { qr = new URL(record.qr_code); } catch { throw new Error("invalid Alipay QR code"); }
  if (qr.protocol !== "https:" || qr.hostname !== "qr.alipay.com" || qr.port || qr.username || qr.password || qr.hash) throw new Error("invalid Alipay QR code");
  return { tradeNo: input.tradeNo, qrCode: record.qr_code };
}
