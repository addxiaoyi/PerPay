export type PayoutKind = "bank" | "alipay" | "wechat";
export type PayoutAccess = { canBind: boolean; canReview: boolean; canRequest: boolean; csrfToken: string; channels: Array<{ kind: PayoutKind; enabled: boolean; maxSingleCents: number | null; reason: string | null }> };
export type PayoutAccount = { id: string; kind: PayoutKind; label: string; status: "PENDING" | "APPROVED" | "REJECTED" | "REVOKED"; createdAt: number; reviewedBy: string | null; reviewReference: string | null };
export type Payout = { id: string; accountId: string; channel: PayoutKind; outNo: string; amountCents: number; status: string; providerId: string | null; attempts: number; createdAt: number; updatedAt: number; approvedBy: string | null; approvalReference: string | null; lastError: string | null };
export const payoutKinds: Record<PayoutKind, string> = { bank: "银行卡", alipay: "支付宝", wechat: "微信零钱" };
export const payoutStatuses: Record<string, string> = { PENDING: "待审核", READY: "等待出款", UNKNOWN: "正在核对渠道结果", PROCESSING: "渠道处理中", WAIT_USER_CONFIRM: "等待微信确认收款", SUCCEEDED: "已打款", FAILED: "出款失败，余额已退回", REJECTED: "已驳回，余额已退回" };
export const accountStatuses = { PENDING: "待审核", APPROVED: "已审核", REJECTED: "已拒绝", REVOKED: "已停用" };
