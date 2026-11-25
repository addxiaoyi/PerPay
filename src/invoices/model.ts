import { z } from "zod";
import type { AppDatabase } from "../database/database.ts";
import type { authorizeMerchant } from "../epay-compat/merchant-access.ts";

const printable = (limit: number) => z.string().trim().min(1).max(limit).regex(/^[^\x00-\x1f\x7f]+$/);
const taxId = z.string().trim().regex(/^[A-Z0-9]{15,20}$/);

export const invoiceProfileInput = z.object({
  expectedVersion: z.number().int().safe().nonnegative(),
  provider: z.enum(["wechat", "fa-piao"]).optional(),
  subMchId: z.string().regex(/^\d{1,32}$/),
  sellerName: printable(120), sellerTaxId: taxId,
  billingPersonId: z.union([printable(64), z.literal("")]),
  itemName: printable(90), taxCode: z.string().regex(/^\d{19}$/),
  taxRateBps: z.number().int().refine(value => [0, 100, 150, 300, 500, 600, 900, 1000, 1100, 1300, 1600, 1700].includes(value)), enabled: z.boolean(),
}).strict().refine(value => value.provider === "fa-piao" || /^\d{6,32}$/.test(value.subMchId), { message: "invalid WeChat invoice merchant", path: ["subMchId"] })
  .refine(value => !value.enabled || value.billingPersonId !== "", { message: "enabled invoicing requires a billing person", path: ["billingPersonId"] });

export const invoiceRequestInput = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/),
  tradeNo: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  buyerType: z.enum(["INDIVIDUAL", "ORGANIZATION"]),
  title: printable(160), taxId: z.union([taxId, z.literal("")]),
  email: z.string().trim().max(254).email().refine(value => Buffer.byteLength(value, "utf8") <= 214, "invoice email exceeds the encryption limit"),
}).strict().refine(value => value.buyerType === "ORGANIZATION" ? value.taxId !== "" : value.taxId === "", { message: "organization buyers require a tax ID; individual buyers must leave it empty", path: ["taxId"] });

export type InvoiceProfile = Omit<z.infer<typeof invoiceProfileInput>, "expectedVersion" | "enabled">;
export type StoredInvoiceProfile = InvoiceProfile & {
  enabled: boolean; authorized: boolean; authorizationCheckedAt: number; version: number;
};
export type InvoiceAccess = Awaited<ReturnType<typeof authorizeMerchant>>;
export type InvoiceDatabase = Pick<AppDatabase, "read" | "write">;
export type InvoiceIssue = {
  kind?: "platform-fee";
  requestNo: string; applicationNo: string; merchantId: number; tradeNo: string; amountCents: number;
  paymentType: "wxpay" | "alipay" | "balance"; providerTradeNo: string;
  invoiceNo?: string;
  profile: InvoiceProfile; buyer: { type: "INDIVIDUAL" | "ORGANIZATION"; title: string; taxId: string; email: string };
};
export type InvoiceStatus = "UNKNOWN" | "PROCESSING" | "ISSUED" | "FAILED" | "REVERSING" | "REVERSED";
export type InvoiceObservation = {
  status: InvoiceStatus; invoiceNo?: string | undefined; cardOpenid?: string | undefined; errorCode?: string | undefined;
  reversalFailed?: true | undefined;
};
export type InvoiceAuthorization = { authorized: boolean; subMchId: string; billingPersonIds: string[]; reason?: string };
export interface InvoiceProvider {
  readonly kind?: "wechat" | "fa-piao";
  readonly issuanceEnabled?: boolean;
  readonly platformFees?: { profile: InvoiceProfile; enabled: boolean; validUntil: number };
  authorize(profile: InvoiceProfile): Promise<InvoiceAuthorization>;
  checkStatus?(profile: InvoiceProfile): Promise<InvoiceAuthorization>;
  issue(request: InvoiceIssue): Promise<InvoiceObservation>;
  query(request: InvoiceIssue, signal?: AbortSignal): Promise<InvoiceObservation>;
  reviewInvoice?(request: InvoiceIssue, invoiceNo: string): Promise<InvoiceObservation>;
  download(request: InvoiceIssue): Promise<{ downloadUrl: string; expiresAt?: number }>;
  invite(profile: InvoiceProfile): Promise<{ url: string; miniProgramAppId?: string; miniProgramPath?: string }>;
}
export type PublicInvoice = {
  kind?: "platform-fee";
  id: string; requestNo: string; applicationNo: string; attempt: number; requestId: string; tradeNo: string; amountCents: number;
  title: string; status: InvoiceStatus; invoiceNo: string | null;
  errorCode: string | null; createdAt: number; updatedAt: number;
};
export class InvoiceError extends Error {
  readonly code: string;
  readonly status: 400 | 403 | 404 | 409 | 503;
  constructor(code: string, status: 400 | 403 | 404 | 409 | 503, message: string) { super(message); this.code = code; this.status = status; }
}

export function invoiceTime(now: number): number {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid invoice clock");
  return now;
}

export function verifiedAuthorization(profile: InvoiceProfile, authorization: InvoiceAuthorization): boolean {
  return authorization.authorized === true && authorization.subMchId === profile.subMchId && Array.isArray(authorization.billingPersonIds) && authorization.billingPersonIds.includes(profile.billingPersonId);
}

export function parseInvoiceObservation(input: unknown): InvoiceObservation {
  const observation = z.object({
    status: z.enum(["UNKNOWN", "PROCESSING", "ISSUED", "FAILED", "REVERSING", "REVERSED"]),
    invoiceNo: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
    cardOpenid: printable(128).optional(),
    reversalFailed: z.literal(true).optional(),
    errorCode: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional(),
  }).strict().parse(input);
  if (observation.status === "ISSUED" && !observation.invoiceNo) throw new Error("issued invoice has no invoice number");
  if (observation.reversalFailed && observation.status !== "ISSUED") throw new Error("failed red cancellation requires an issued blue invoice");
  if (!["ISSUED", "REVERSING", "REVERSED"].includes(observation.status) && (observation.invoiceNo || observation.cardOpenid)) throw new Error("unissued invoice includes final invoice details");
  return observation;
}

export function invoiceHttpsUrl(value: string): string {
  const url = new URL(value);
  if (value.length > 4096 || url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("invalid invoice HTTPS URL");
  return url.href;
}
