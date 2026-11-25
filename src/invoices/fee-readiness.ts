import type { DatabaseSync } from "node:sqlite";
import { readConfirmedOrder } from "../epay-compat/confirmed-order.ts";
import { readFeeQueueState } from "./fee-queue.ts";

const SCAN_LIMIT = 200;
export function feeReadinessPreview(sql: DatabaseSync, merchantId: number, now: number) {
  const rows = sql.prepare(`SELECT o.trade_no,coalesce(a.fee_cents,w.fee_cents,b.fee_cents) fee_cents
    FROM epay_orders o LEFT JOIN epay_alipay_confirmations a ON a.trade_no=o.trade_no
    LEFT JOIN epay_wechat_confirmations w ON w.trade_no=o.trade_no
    LEFT JOIN epay_balance_confirmations b ON b.trade_no=o.trade_no
    WHERE o.merchant_id=? AND o.status='PAID' AND coalesce(a.fee_cents,w.fee_cents,b.fee_cents)>0
      AND NOT EXISTS(SELECT 1 FROM epay_fee_invoice_requests r WHERE r.trade_no=o.trade_no)
      AND NOT EXISTS(SELECT 1 FROM epay_native_refunds r WHERE r.trade_no=o.trade_no AND r.status NOT IN ('REJECTED','CLOSED'))
      AND NOT EXISTS(SELECT 1 FROM epay_balance_refunds r WHERE r.trade_no=o.trade_no)
    ORDER BY o.paid_at DESC,o.trade_no LIMIT ?`).all(merchantId, SCAN_LIMIT + 1);
  let amount = 0n, pendingCount = 0, deferredCount = 0, unverifiedCount = 0;
  const preview: { tradeNo: string; amountCents: number; nextAt: number }[] = [];
  for (const row of rows.slice(0, SCAN_LIMIT)) {
    const tradeNo = String(row.trade_no);
    if (!readConfirmedOrder(sql, tradeNo, merchantId)) { unverifiedCount++; continue; }
    const fee = Number(row.fee_cents);
    if (!Number.isSafeInteger(fee) || fee < 1) throw new Error("invoices/fee-readiness: recorded fee is invalid");
    const state = readFeeQueueState(sql, tradeNo), nextAt = state?.nextAt ?? 0;
    amount += BigInt(fee); pendingCount++;
    if (nextAt > now) deferredCount++;
    if (preview.length < 10) preview.push({ tradeNo, amountCents: fee, nextAt });
  }
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("invoices/fee-readiness: fee total exceeds safe integer range");
  return { pendingCount, pendingAmountCents: Number(amount), deferredCount, unverifiedCount, preview, scanLimit: SCAN_LIMIT, hasMore: rows.length > SCAN_LIMIT };
}
