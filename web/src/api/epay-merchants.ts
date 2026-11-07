import { client } from "./generated/client.gen";
import { result } from "./client";

export type MerchantFee = { merchantId: number; name: string; enabled: boolean; feeBps: number; version: number };
export type FeeChange = { sequence: number; occurredAt: number; actor: string; oldFeeBps: number; newFeeBps: number; reason: string };
export type FeePage = { merchants: MerchantFee[]; nextAfter: number | null };
export type HistoryPage = { changes: FeeChange[]; nextBefore: number | null };

export function listMerchantFees(after: number | null, signal?: AbortSignal) {
  const query = after === null ? "" : `?after=${after}`;
  return result(client.get<{ 200: { data: FeePage } }>({ url: `/api/admin/v1/epay/merchants${query}`, signal }));
}

export function merchantFeeHistory(id: number, before: number | null, signal?: AbortSignal) {
  const query = before === null ? "" : `?before=${before}`;
  return result(client.get<{ 200: { data: HistoryPage } }>({ url: `/api/admin/v1/epay/merchants/${id}/fee/history${query}`, signal }));
}

export function updateMerchantFee(merchant: MerchantFee, feeBps: number, reason: string) {
  return result(client.post<{ 200: { data: { merchantId: number; feeBps: number; version: number } } }>({
    url: `/api/admin/v1/epay/merchants/${merchant.merchantId}/fee`,
    headers: { "Content-Type": "application/json" },
    body: { expectedFeeBps: merchant.feeBps, expectedVersion: merchant.version, feeBps, reason },
  }));
}

export function parseFeePercent(value: string): number | null {
  const match = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const basisPoints = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return basisPoints <= 5000 ? basisPoints : null;
}

export function formatFee(bps: number): string {
  return `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, "0")}%`;
}
