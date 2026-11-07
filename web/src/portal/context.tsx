import { createContext, useContext } from "react";
import type { ConsoleMerchant } from "@/api/merchant-console";
export type PortalContextValue = { mode: "admin" | "merchant"; merchants: ConsoleMerchant[]; selected: ConsoleMerchant; enabled: boolean; isAdmin: boolean; collectionChannels?: string[] };
export const PortalContext = createContext<PortalContextValue | null>(null);
export function usePortal() { const value = useContext(PortalContext); if (!value) throw new Error("payment portal context missing"); return value; }
export type PortalMerchant = { merchantId: string | null; epayMerchantId: number; name: string; enabled: boolean; feeBps: number; availableCents: number | null; frozenCents: number | null; reconciled: boolean };
export type PortalOverview = {
  observedAt: number; days: number; today: { amountCents: number; confirmed: number }; periodCents: number; pending: number;
  trend: Array<{ date: string; amountCents: number; confirmed: number; created: number }>;
  tasks: { callbacks: number; refunds: number; settlements: number }; missingPaidAt: number; merchants: PortalMerchant[];
  balances: { availableCents: number; frozenCents: number }; statisticsScope: "epay";
};
export type PortalRecord = { id: string; merchantId: string | null; merchantName: string; epayMerchantId: number; source: string; status: string; createdAt: number; amountCents: number | null; name: string; orderId?: string; merchantOrderId?: string; attempts?: number; frozenDeltaCents?: number };
export function portalParams(context: PortalContextValue, scoped = false) {
  return { merchantId: context.selected.merchantId, scope: context.mode === "admin" && !scoped ? "admin" : "merchant" };
}
export const portalLabels: Record<string, string> = { overview: "总览", merchants: "商户管理", orders: "全部订单", notifications: "全部通知", ledger: "余额账本", refunds: "退款审批", settlements: "提现审批", system: "运行状态", tasks: "待处理", collect: "创建收款", invoices: "历史发票", fee: "费率管理", keys: "API 接入", profile: "商户资料", members: "成员权限", enrollment: "新增商户", management: "启停管理", adjustments: "余额调整" };
export function recordStatus(value: string) {
  const labels: Record<string, string> = { pending: "待处理", pending_payment: "待支付", pending_sync: "等待同步", paid: "已支付", closed: "已关闭", refunded: "已退款", partial_refund: "部分退款", refund_processing: "退款处理中", frozen: "已冻结", failed: "失败", success: "已送达", succeeded: "已完成", leased: "投递中", requested: "待审批", ready: "等待处理", processing: "处理中", unknown: "待核实", rejected: "已驳回", posted: "已入账" };
  return labels[value.toLowerCase()] ?? "待核实";
}
