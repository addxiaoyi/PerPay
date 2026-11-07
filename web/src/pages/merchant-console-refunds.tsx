import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { merchantRequest, centsText, dateText, MerchantConsoleError } from "@/api/merchant-console";
import { ConsolePagination, ConsoleQuery } from "@/components/merchant-console-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Session = { enabled: boolean; canApprove: boolean; csrfToken: string };
type Refund = { refundNo: string; tradeNo: string; amountCents: number; debitCents: number; status: string; reason: string; createdAt: number; requestedBy: string; approvedBy: string | null };
type Command = { requestId: string; tradeNo: string; amountCents: number; reason: string };
const statuses: Record<string, string> = { REQUESTED: "待管理员审批", READY: "等待渠道处理", PROCESSING: "渠道处理中", UNKNOWN: "正在核实渠道结果", SUCCEEDED: "退款成功", REJECTED: "申请已拒绝", CLOSED: "渠道已关闭，冻结已释放" };

export function MerchantConsoleRefunds({ merchantId, administration = true, requests = true }: { merchantId: string; administration?: boolean; requests?: boolean }) {
  const [page, setPage] = useState(1), client = useQueryClient();
  const session = useQuery({ queryKey: ["merchant-console", merchantId, "refund-session"], queryFn: ({ signal }) => merchantRequest<Session>("refunds/session", { merchantId }, signal), retry: false });
  const refunds = useQuery({ queryKey: ["merchant-console", merchantId, "refunds", page], queryFn: ({ signal }) => merchantRequest<{ refunds: Refund[]; hasNext: boolean }>("refunds", { merchantId, page: String(page) }, signal), retry: false, refetchInterval: 15000 });
  const decision = useMutation({ retry: false, mutationFn: async ({ refundNo, action }: { refundNo: string; action: "approve" | "reject" }) => {
    const access = await merchantRequest<Session>("refunds/session", { merchantId });
    if (!access.enabled || !access.canApprove) throw new MerchantConsoleError(403, "refund_forbidden");
    return merchantRequest<Refund>(`refunds/${refundNo}/${action}`, { merchantId }, undefined, { token: access.csrfToken, body: {} });
  }, onSuccess: async () => { await client.invalidateQueries({ queryKey: ["merchant-console", merchantId] }); } });
  return <section className="space-y-6"><div><h2 className="text-xl font-semibold">退款</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">新网关已确认收款的订单可申请退款。管理员批准后冻结商户余额，待渠道确认结果后结算；旧订单继续由原支付系统处理。</p></div>
    {requests && <ConsoleQuery query={session}>{access => access.enabled ? <RefundForm merchantId={merchantId} /> : <p role="status" className="text-sm text-muted-foreground">升级期间可查看退款记录，暂不接受新申请。</p>}</ConsoleQuery>}
    {decision.isError && <p role="alert" className="text-sm text-destructive">{decision.error.message}</p>}
    <ConsoleQuery query={refunds}>{value => <><ul className="divide-y border-y">{value.refunds.map(refund => <li key={refund.refundNo} className="space-y-3 py-5"><div className="flex flex-wrap justify-between gap-3"><div><p className="break-all font-medium">{refund.tradeNo}</p><p className="mt-1 text-xs text-muted-foreground">{dateText(refund.createdAt)}</p></div><div className="text-right"><p className="text-lg font-semibold tabular-nums">¥ {centsText(refund.amountCents)}</p><p className="text-sm">{statuses[refund.status] ?? "待核实"}</p></div></div><p className="break-all text-sm">{refund.reason}</p><p className="break-all text-xs text-muted-foreground">退款单号 {refund.refundNo}</p>{administration && refund.status === "REQUESTED" && session.data?.canApprove && <div className="flex flex-wrap items-center gap-3"><span className="text-xs text-muted-foreground">批准后冻结 ¥ {centsText(refund.debitCents)}</span><Button disabled={decision.isPending} onClick={() => decision.mutate({ refundNo: refund.refundNo, action: "approve" })}>批准原路退款</Button><Button variant="outline" disabled={decision.isPending} onClick={() => decision.mutate({ refundNo: refund.refundNo, action: "reject" })}>拒绝申请</Button></div>}</li>)}</ul>{!value.refunds.length && <p className="py-5 text-sm text-muted-foreground">暂无新网关退款申请。</p>}<ConsolePagination page={page} hasNext={value.hasNext} change={setPage} /></>}</ConsoleQuery>
  </section>;
}

function RefundForm({ merchantId }: { merchantId: string }) {
  const [tradeNo, setTradeNo] = useState(""), [amount, setAmount] = useState(""), [reason, setReason] = useState("");
  const [pending, setPending] = useState<Command | null>(null), [validation, setValidation] = useState("");
  const client = useQueryClient();
  const save = useMutation({ retry: false, mutationFn: async (command: Command) => {
    const access = await merchantRequest<Session>("refunds/session", { merchantId });
    if (!access.enabled) throw new MerchantConsoleError(503, "refund_maintenance");
    return merchantRequest<Refund>("refunds", { merchantId }, undefined, { token: access.csrfToken, body: command });
  }, onSuccess: async () => { setPending(null); setTradeNo(""); setAmount(""); setReason(""); await client.invalidateQueries({ queryKey: ["merchant-console", merchantId] }); } });
  function submitRefund(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) { save.mutate(pending); return; }
    const money = /^(0|[1-9]\d{0,9})(?:\.(\d{1,2}))?$/.exec(amount.trim());
    const cents = money ? Number(money[1]) * 100 + Number((money[2] ?? "").padEnd(2, "0")) : 0;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tradeNo.trim()) || !Number.isSafeInteger(cents) || cents < 1 || !reason.trim()) { setValidation("请填写平台订单号、有效退款金额和原因。"); return; }
    const command = { requestId: crypto.randomUUID(), tradeNo: tradeNo.trim(), amountCents: cents, reason: reason.trim() };
    setValidation(""); setPending(command); save.mutate(command);
  }
  return <form onSubmit={submitRefund} className="max-w-xl space-y-4 rounded-lg border p-5"><h3 className="font-medium">申请退款</h3><div className="space-y-2"><label htmlFor="refund-order" className="text-sm">平台订单号</label><Input id="refund-order" value={tradeNo} maxLength={64} disabled={pending !== null} onChange={event => setTradeNo(event.target.value)} /></div><div className="space-y-2"><label htmlFor="refund-amount" className="text-sm">退款金额（元）</label><Input id="refund-amount" inputMode="decimal" value={amount} maxLength={13} disabled={pending !== null} onChange={event => setAmount(event.target.value)} /></div><div className="space-y-2"><label htmlFor="refund-reason" className="text-sm">退款原因</label><Textarea id="refund-reason" value={reason} maxLength={300} disabled={pending !== null} onChange={event => setReason(event.target.value)} /></div><Button type="submit" disabled={save.isPending}>{save.isPending ? "正在提交…" : pending ? "重试本次申请" : "提交退款申请"}</Button>{validation && <p role="alert" className="text-sm text-destructive">{validation}</p>}{save.isError && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}{save.isSuccess && <p role="status" className="text-sm">申请已保存，等待管理员审批。</p>}</form>;
}
