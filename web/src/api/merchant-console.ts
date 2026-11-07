import { adminMountPath } from "../admin-base";
import { merchantSessionFetch } from "./merchant-session";

export type ConsoleMerchant = { merchantId: string; epayMerchantId: number; name: string; role: "admin" | "owner" | "member"; feeBps: number; version: number };
export type ConsoleSession = { merchantId: string; role: ConsoleMerchant["role"]; canAdminister: boolean; csrfToken: string | null; expiresAt: number };
export type ConsoleOrder = { id: string; merchantOrderId: string; amountCents: number; status: string; createdAt: string; source: "main_site" | "epay" };
export type LedgerEntry = { id: string; type: string; availableDeltaCents: number; frozenDeltaCents: number; occurredAt: number; source: string };
export type Invoice = { id: string; tradeNo: string; title: string; amountCents: number; status: string; createdAt: number };
export type ConsoleBalance = { merchantId: string; availableCents: number; frozenCents: number; version: number | null; migrationBaselineVerified: boolean };

export class MerchantConsoleError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code === "member_change_rejected" ? "成员授权未完成，请核对账户 ID；商户所有者无需重复添加。" : code === "invalid_member_change" ? "请填写有效的 StarMC 账户 ID。" : code === "insufficient_balance" ? "可用余额不足，无法扣减该金额。" : code === "balance_unavailable" ? "余额正在核对，暂时无法调整。" : code === "invalid_balance_adjustment" ? "请填写有效金额和调整原因。" : status === 401 ? "登录已失效，请重新登录。" : status === 403 || status === 404 ? "当前账户没有此商户的访问权限。" : status === 409 ? "记录已被其他管理员修改，请刷新后重试。" : "暂时无法读取，请稍后重试。");
  }
}
const financialErrors: Record<string, string> = {
  refund_forbidden: "没有权限处理该退款，请刷新登录状态。", refund_invalid: "请检查订单号、退款金额和原因。",
  refund_insufficient_balance: "商户可用余额不足，申请仍保留待处理。", refund_conflict: "订单不支持本次退款或申请已处理，请刷新记录核对。",
  refund_maintenance: "升级期间暂不处理新退款。", refund_unavailable: "退款服务暂时不可用，请稍后查看原申请。",
  settlement_invalid: "请填写有效的结算金额、备注和打款凭证。", settlement_insufficient_balance: "可用余额不足，请刷新后核对。",
  settlement_conflict: "结算申请已处理或请求与原申请不一致。", settlement_maintenance: "暂不受理新的结算操作。",
  settlement_unavailable: "结算结果暂未确认，请查看原申请后重试。",
  payout_invalid: "请核对收款人、账户资料、金额和审核说明。",
  payout_unavailable: "自动打款通道尚未验收开放，或原请求结果待核对。请查看记录后重试。",
  payout_insufficient: "可用余额不足，请刷新后核对。",
  payout_conflict: "收款账户或提现状态已变化，或金额超过限额，请刷新记录后核对。",
  merchant_key_conflict: "密钥版本已变化，请刷新后核对。", merchant_key_invalid: "换钥请求无效，请刷新后重试。",
  merchant_key_unavailable: "换钥结果暂未确认，请使用原请求重试。",
  merchant_creation_conflict: "账户已有商户、资料不一致或创建未确认，请核对原申请后重试。",
  merchant_creation_pending: "商户创建结果未确认，请使用原申请重试。",
  callback_retry_conflict: "通知正在投递、刚刚重试或不属于当前商户，请刷新记录。", callback_retry_unavailable: "重试结果尚未确认，请查看原订单记录。",
  merchant_profile_invalid: "资料无效或暂未保存，请核对商户名称和 HTTPS 回调地址。",
  merchant_status_invalid: "商户状态未修改，请检查权限与当前记录。",
};

export async function merchantRequest<T>(path: string, params: Record<string, string> = {}, signal?: AbortSignal, mutation?: { token: string; body: unknown }): Promise<T> {
  const query = new URLSearchParams(params);
  const response = await merchantSessionFetch(`${adminMountPath()}/api/merchant/epay/${path}${query.size ? `?${query}` : ""}`, {
    credentials: "same-origin", cache: "no-store", redirect: "error", ...(signal ? { signal } : {}),
    ...(mutation ? { method: "POST", headers: { "content-type": "application/json", "x-csrf-token": mutation.token }, body: JSON.stringify(mutation.body) } : {}),
  });
  const body = await response.json() as { ok?: boolean; data?: T; error?: string; code?: string };
  if (!response.ok || body.ok !== true || !body.data) {
    const failure = new MerchantConsoleError(response.status, body.code ?? body.error ?? "invalid_response");
    if (body.code && financialErrors[body.code]) failure.message = financialErrors[body.code]!;
    throw failure;
  }
  const scoped = body.data as { merchantId?: unknown };
  if (params.merchantId && typeof scoped.merchantId === "string" && scoped.merchantId !== params.merchantId) throw new MerchantConsoleError(503, "merchant_mismatch");
  return body.data;
}

export const centsText = (cents: number) => (cents / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const dateText = (value: number | string) => new Date(value).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
export function paymentLabel(value: string): string {
  const refunds: Record<string, string> = { refund_hold: "退款冻结", refund_paid: "退款完成", refund_released: "退款冻结解除", partial_refund: "部分退款" };
  if (refunds[value.toLowerCase()]) return refunds[value.toLowerCase()]!;
  if (value.toLowerCase() === "legacy_synchronization") return "旧支付记录同步";
  const labels: Record<string, string> = { pending: "待处理", pending_payment: "待支付", pending_sync: "等待同步", paid: "已支付", closed: "已关闭", refunded: "已退款", refund_processing: "退款处理中", frozen: "已冻结", issued: "已开票", failed: "失败", success: "已送达", succeeded: "已完成", payment_paid: "订单收款", manual_adjustment: "管理员余额调整", payment_manual_adjustment: "管理员余额调整", settlement_freeze: "提现冻结", settlement_paid: "提现完成", refund: "订单退款" };
  return labels[value.toLowerCase()] ?? "待核实";
}
