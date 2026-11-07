import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { merchantRequest, centsText, dateText, MerchantConsoleError, type ConsoleMerchant } from "@/api/merchant-console";
import { ConsolePagination, ConsoleQuery } from "@/components/merchant-console-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Access = { enabled: boolean; canReview: boolean; csrfToken: string };
type Settlement = { automaticPayout?: boolean; id: string; amountCents: number; note: string; status: "PENDING" | "PAID" | "REJECTED"; createdBy: string; createdAt: number; reference: string | null; reviewedBy: string | null; reviewedAt: number | null };
type Command = { requestId: string; amountCents: number; note: string };
const statusLabel = (status: string) => ({ PENDING: "待审核", PAID: "已登记打款", REJECTED: "已驳回" })[status.toUpperCase()] ?? "待核实";

export function MerchantConsoleSettlements({ merchantId, role, requests = true }: { merchantId: string; role: ConsoleMerchant["role"]; requests?: boolean }) {
  const [page, setPage] = useState(1), [historyPage, setHistoryPage] = useState(1), [selected, setSelected] = useState<Settlement | null>(null);
  const access = useQuery({ queryKey: ["merchant-console", merchantId, "settlement-session", role], queryFn: ({ signal }) => merchantRequest<Access>("settlements/session", { merchantId }, signal), retry: false });
  const settlements = useQuery({ queryKey: ["merchant-console", merchantId, "settlements", page], queryFn: ({ signal }) => merchantRequest<{ settlements: Settlement[]; hasNext: boolean }>("settlements", { merchantId, page: String(page) }, signal), retry: false, refetchInterval: 15000 });
  const history = useQuery({ queryKey: ["merchant-console", merchantId, "settlement-history", historyPage], queryFn: ({ signal }) => merchantRequest<{ records: Array<{ id: string; amountCents: number; status: string; createdAt: string }>; hasNext: boolean }>("main-activity", { merchantId, kind: "settlements", page: String(historyPage) }, signal), retry: false });
  const canReview = role === "admin" && access.data?.canReview === true && !access.isError;
  return <section className="space-y-7"><div><h2 className="text-xl font-semibold">提现结算</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">申请后冻结相应余额。管理员完成线下打款后登记凭证；驳回申请会释放冻结金额。</p></div>
    {requests && <ConsoleQuery query={access}>{session => session.enabled ? <SettlementForm merchantId={merchantId} /> : <p role="status" className="text-sm text-muted-foreground">升级期间暂不受理新的提现申请。</p>}</ConsoleQuery>}
    <ConsoleQuery query={settlements}>{value => <><ul className="divide-y border-y">{value.settlements.map(item => <li className="space-y-2 py-5" key={item.id}><div className="flex flex-wrap justify-between gap-3"><div><p className="text-lg font-semibold tabular-nums">¥ {centsText(item.amountCents)}</p><time className="text-xs text-muted-foreground">{dateText(item.createdAt)}</time></div><p className="text-sm">{statusLabel(item.status)}</p></div><p className="break-all text-sm">{item.note || "未填写备注"}</p><p className="break-all text-xs text-muted-foreground">申请编号 {item.id}</p>{item.reference && <p className="break-all text-sm">凭证或审核说明：{item.reference}</p>}{item.reviewedBy && <p className="break-all text-xs text-muted-foreground">审核人 {item.reviewedBy} · {item.reviewedAt ? dateText(item.reviewedAt) : ""}</p>}{item.automaticPayout && <p className="text-sm text-muted-foreground">自动提现请在“收款账户与自动提现”中处理，不能重复登记线下打款。</p>}{canReview && !item.automaticPayout && item.status === "PENDING" && <Button variant="outline" onClick={() => setSelected(item)}>处理结算</Button>}</li>)}</ul>{!value.settlements.length && <p className="py-3 text-sm text-muted-foreground">暂无新系统结算申请。</p>}<ConsolePagination page={page} hasNext={value.hasNext} change={setPage} /></>}</ConsoleQuery>
    {canReview && selected && <SettlementDecision key={selected.id} merchantId={merchantId} settlement={selected} close={() => setSelected(null)} />}
    <div className="border-t pt-6"><h3 className="font-medium">历史结算</h3><ConsoleQuery query={history}>{value => <><ul className="divide-y">{value.records.map(item => <li key={item.id} className="flex flex-wrap justify-between gap-3 py-4 text-sm"><div><p className="break-all">{item.id}</p><time className="text-xs text-muted-foreground">{item.createdAt ? dateText(item.createdAt) : "时间待核对"}</time></div><p>¥ {centsText(item.amountCents)} · {statusLabel(item.status)}</p></li>)}</ul>{!value.records.length && <p className="py-5 text-sm text-muted-foreground">暂无历史结算记录。</p>}<ConsolePagination page={historyPage} hasNext={value.hasNext} change={setHistoryPage} /></>}</ConsoleQuery></div>
  </section>;
}

function SettlementForm({ merchantId }: { merchantId: string }) {
  const [amount, setAmount] = useState(""), [note, setNote] = useState(""), [pending, setPending] = useState<Command | null>(null), [validation, setValidation] = useState("");
  const client = useQueryClient();
  const save = useMutation({ retry: false, mutationFn: async (command: Command) => {
    const session = await merchantRequest<Access>("settlements/session", { merchantId });
    if (!session.enabled) throw new MerchantConsoleError(503, "settlement_maintenance");
    return merchantRequest<Settlement>("settlements", { merchantId }, undefined, { token: session.csrfToken, body: command });
  }, onSuccess: async () => { setPending(null); setAmount(""); setNote(""); await client.invalidateQueries({ queryKey: ["merchant-console", merchantId] }); },
  onError: error => { if (error instanceof MerchantConsoleError && [400, 409].includes(error.status)) setPending(null); } });
  function submitSettlement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) { save.mutate(pending); return; }
    const parsed = /^(0|[1-9]\d{0,9})(?:\.(\d{1,2}))?$/.exec(amount.trim());
    const amountCents = parsed ? Number(parsed[1]) * 100 + Number((parsed[2] ?? "").padEnd(2, "0")) : 0;
    if (!Number.isSafeInteger(amountCents) || amountCents < 1) { setValidation("请输入有效的提现金额，最多两位小数。"); return; }
    const command = { requestId: crypto.randomUUID(), amountCents, note: note.trim() };
    setPending(command); setValidation(""); save.mutate(command);
  }
  return <form className="max-w-xl space-y-4 rounded-lg border p-5" onSubmit={submitSettlement}><h3 className="font-medium">申请提现</h3><div className="space-y-2"><label htmlFor="settlement-amount" className="text-sm">提现金额（元）</label><Input id="settlement-amount" inputMode="decimal" value={amount} disabled={pending !== null} maxLength={13} onChange={event => setAmount(event.target.value)} /></div><div className="space-y-2"><label htmlFor="settlement-note" className="text-sm">备注</label><Textarea id="settlement-note" value={note} maxLength={300} disabled={pending !== null} onChange={event => setNote(event.target.value)} /></div><Button type="submit" disabled={save.isPending}>{save.isPending ? "正在提交…" : pending ? "重试本次提现" : "提交提现申请"}</Button>{validation && <p role="alert" className="text-sm text-destructive">{validation}</p>}{save.isError && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}{save.isSuccess && <p role="status" className="text-sm">申请已保存，相应余额已冻结。</p>}</form>;
}

function SettlementDecision({ merchantId, settlement, close }: { merchantId: string; settlement: Settlement; close: () => void }) {
  const [reference, setReference] = useState(""), [validation, setValidation] = useState("");
  const client = useQueryClient();
  const save = useMutation({ retry: false, mutationFn: async (decision: "paid" | "rejected") => {
    const session = await merchantRequest<Access>("settlements/session", { merchantId });
    if (!session.canReview) throw new MerchantConsoleError(403, "forbidden");
    return merchantRequest<Settlement>(`settlements/${settlement.id}/decision`, { merchantId }, undefined, { token: session.csrfToken, body: { decision, reference: reference.trim() } });
  }, onSuccess: async () => { await client.invalidateQueries({ queryKey: ["merchant-console", merchantId] }); close(); } });
  function recordPayout() { if (!reference.trim()) { setValidation("请先填写已完成打款的凭证。"); return; } setValidation(""); save.mutate("paid"); }
  function reject() { setValidation(""); save.mutate("rejected"); }
  return <section className="space-y-4 rounded-lg border p-5" aria-label="审核结算"><h3 className="font-medium">处理 ¥ {centsText(settlement.amountCents)} 的提现</h3><p className="text-sm text-muted-foreground">确认已通过线下渠道完成打款后，再登记凭证。此操作仅更新账本，不会自动转账。</p><label htmlFor="settlement-reference" className="block text-sm">打款凭证或驳回说明</label><Textarea id="settlement-reference" maxLength={200} value={reference} disabled={save.isPending} onChange={event => setReference(event.target.value)} /><div className="flex flex-wrap gap-3"><Button disabled={save.isPending} onClick={recordPayout}>登记打款完成</Button><Button variant="outline" disabled={save.isPending} onClick={reject}>驳回并释放余额</Button><Button variant="ghost" disabled={save.isPending} onClick={close}>取消</Button></div>{validation && <p role="alert" className="text-sm text-destructive">{validation}</p>}{save.isError && <p role="alert" className="text-sm text-destructive">{save.error.message}</p>}</section>;
}
