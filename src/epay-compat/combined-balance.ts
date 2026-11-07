import type { DatabaseSync } from "node:sqlite";
import type { RuntimeSecretCipher } from "../settings/crypto.ts";
import { auditLegacyDashboardBalance } from "./legacy-balance-audit.ts";
import { projectMerchantLedgerBalance } from "./ledger-balance.ts";
import { readMainPaymentArchive } from "./main-payment-archive.ts";
import { readEncryptedMainOrder } from "./main-order-source.ts";

type MainPayment = {
  merchants: Array<{ id: string; apiId: string; feeRate: number }>;
  orders: Array<{ id: string; merchantId: string; merchantOrderId: string; amountCents: number; status: string; createdAt: string }>;
};

export function projectCombinedMerchantBalance(db: DatabaseSync, cipher: RuntimeSecretCipher, merchantId: number) {
  const ledger = projectMerchantLedgerBalance(db, cipher, merchantId);
  const raw = readMainPaymentArchive(db, cipher);
  if (!raw) throw new Error("combined balance archive is unavailable");
  const payment = JSON.parse(raw) as MainPayment;
  if (!Array.isArray(payment.orders)) throw new Error("combined balance order archive is unavailable");
  const binding = db.prepare("SELECT main_merchant_id,main_api_id FROM epay_merchant_bindings WHERE epay_merchant_id=?").get(merchantId);
  const merchant = payment.merchants.find(row => row.id === binding?.main_merchant_id && row.apiId === binding.main_api_id);
  if (!merchant) throw new Error("combined balance merchant is absent from archive");
  const imported = db.prepare(`SELECT order_count,(SELECT count(*) FROM epay_main_order_sources) AS actual
    FROM epay_main_order_import_runs WHERE singleton_key=1`).get();
  if (!imported || Number(imported.order_count) !== payment.orders.length || Number(imported.actual) !== payment.orders.length) throw new Error("combined balance order archive is incomplete");
  const mainOrders = payment.orders.filter(order => order.merchantId === merchant.id).map(order => {
    if (readEncryptedMainOrder(db, cipher, order.id) !== JSON.stringify(order)) throw new Error("combined balance order source differs");
    return { id: order.id, merchantOrderId: order.merchantOrderId, amountCents: order.amountCents, status: order.status, createdAt: Date.parse(order.createdAt) };
  });
  // New verified payments already appear in the ledger. Only legacy orders add
  // a historical projection, using the retained import fee rather than today's fee.
  const gatewayOrders = db.prepare(`SELECT trade_no tradeNo,out_trade_no merchantOrderId,money_cents amountCents,
    get_money_cents receivedCents,paid_at paidAt,created_at createdAt,status FROM epay_orders o WHERE merchant_id=?
    AND NOT EXISTS(SELECT 1 FROM epay_alipay_intents i WHERE i.trade_no=o.trade_no)
    AND NOT EXISTS(SELECT 1 FROM epay_wechat_intents i WHERE i.trade_no=o.trade_no)`).all(merchantId).map(order => ({
      tradeNo: String(order.tradeNo), merchantOrderId: String(order.merchantOrderId), amountCents: Number(order.amountCents),
      receivedCents: order.receivedCents === null ? null : Number(order.receivedCents), paidAt: order.paidAt === null ? null : Number(order.paidAt),
      createdAt: Number(order.createdAt), status: String(order.status),
    }));
  const applications = db.prepare(`SELECT application_id id,fee_cents feeCents,status
    FROM epay_invoice_applications WHERE merchant_id=?`).all(merchantId).map(invoice => ({ id: String(invoice.id), feeCents: Number(invoice.feeCents), status: String(invoice.status) }));
  const basisPoints = merchant.feeRate * 10000;
  if (!Number.isFinite(basisPoints) || Math.abs(basisPoints - Math.round(basisPoints)) > 1e-8) throw new Error("combined balance archived fee precision is invalid");
  const audit = auditLegacyDashboardBalance({ mainAvailableCents: ledger.availableCents, mainFrozenCents: ledger.frozenCents, feeBps: Math.round(basisPoints), mainOrders, gatewayOrders, invoiceApplications: applications });
  if (audit.issues.windowBoundaryAmbiguous || audit.issues.duplicateMainOrderNumbers || audit.issues.matchedOrderDifferences || audit.issues.roundingDifferences || audit.legacyAvailableCents !== audit.fullAvailableCents) throw new Error("legacy balance requires reconciliation before projection");
  return {
    availableCents: audit.fullAvailableCents, frozenCents: ledger.frozenCents,
    components: { ledgerCents: ledger.availableCents, gatewayNetCents: audit.gatewayNetCents, invoiceFeesCents: audit.invoiceFeesCents },
    historicalFeeBps: Math.round(basisPoints), scope: "shadow_combined_projection" as const, financiallyReconciled: false as const,
  };
}
