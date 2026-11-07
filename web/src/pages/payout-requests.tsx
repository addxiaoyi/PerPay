import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { merchantRequest, centsText, dateText, MerchantConsoleError, type ConsoleMerchant } from "@/api/merchant-console";
import { type Payout, type PayoutAccount, type PayoutAccess, payoutKinds, payoutStatuses } from "@/api/payouts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function PayoutRequests({ merchantId, role, session, accounts, payouts }: { merchantId: string; role: ConsoleMerchant["role"]; session: PayoutAccess; accounts: PayoutAccount[]; payouts: Payout[] }) {
  const [selected, setSelected] = useState<Payout | null>(null);
  const usable = accounts.filter(account => account.status === "APPROVED" && session.channels.some(channel => channel.kind === account.kind && channel.enabled));
  return <section className="space-y-5" aria-label="自动提现记录"><h3 className="font-semibold">自动提现</h3>
    {session.canRequest && role !== "member" && usable.length > 0 ? <PayoutForm merchantId={merchantId} accounts={usable} /> : <p role="status" className="text-sm text-muted-foreground">需收款账户审核通过且对应出款通道开放后才能申请自动提现。</p>}
    {payouts.length ? <ul className="divide-y">{payouts.map(payout => <li key={payout.id} className="space-y-2 py-4"><p className="font-medium">¥ {centsText(payout.amountCents)} · {payoutKinds[payout.channel]}</p><p>{payout.returnedCents ? "款项已退回商户余额" : payoutStatuses[payout.status] ?? "等待核对"}</p><p className="break-all text-xs text-muted-foreground">提现单号 {payout.outNo} · {dateText(payout.createdAt)}</p>{payout.returnedAt && <p className="text-sm">退回 ¥ {centsText(payout.returnedCents ?? 0)} · {dateText(payout.returnedAt)}</p>}{payout.providerId && <p className="break-all text-xs">渠道单号 {payout.providerId}</p>}{payout.lastError && <p className="text-sm text-muted-foreground">渠道结果尚未确认，资金继续冻结，系统将查询原单。</p>}{role === "admin" && session.canReview && ["PENDING", "READY"].includes(payout.status) && <Button variant="outline" onClick={() => setSelected(payout)}>审核自动提现</Button>}</li>)}</ul> : <p className="text-sm text-muted-foreground">暂无自动提现记录。</p>}
    {role === "admin" && session.canReview && selected && <PayoutReview key={selected.id} merchantId={merchantId} payout={selected} enabled={session.channels.some(channel => channel.kind === selected.channel && channel.enabled)} close={() => setSelected(null)} />}
  </section>;
}

function PayoutForm({ merchantId, accounts }: { merchantId: string; accounts: PayoutAccount[] }) {
  const [accountId, setAccountId] = useState(accounts[0]!.id), [amount, setAmount] = useState(""), [note, setNote] = useState("");
  const [command, setCommand] = useState<{ requestId: string; accountId: string; amountCents: number; note: string } | null>(null), [validation, setValidation] = useState("");
  const client = useQueryClient();
  const save = useMutation({ retry: false, mutationFn: async (body: NonNullable<typeof command>) => {
    const access = await merchantRequest<PayoutAccess>("payouts/session", { merchantId });
    if (!access.canRequest) throw new Error("自动提现通道尚未开放。");
    return merchantRequest("payouts/requests", { merchantId }, undefined, { token: access.csrfToken, body });
  }, onSuccess: async () => { setCommand(null); setAmount(""); setNote(""); await client.invalidateQueries({ queryKey: ["merchant-console", merchantId] }); },
  onError: error => { if (error instanceof MerchantConsoleError && [400, 401, 403, 404, 409].includes(error.status)) setCommand(null); } });
  function submitPayout(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (command) { save.mutate(command); return; }
    const match = /^(0|[1-9]\d{0,9})(?:\.(\d{1,2}))?$/.exec(amount.trim());
    const amountCents = match ? Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0")) : 0;
    if (!Number.isSafeInteger(amountCents) || amountCents < 1) { setValidation("请填写有效的提现金额，最多两位小数。"); return; }
    const body = { requestId: crypto.randomUUID(), accountId, amountCents, note: note.trim() };
    setValidation(""); setCommand(body); save.mutate(body);
  }
  return <form className="max-w-xl space-y-4 rounded-lg border p-5" onSubmit={submitPayout}><label htmlFor="withdraw-account" className="block text-sm">收款账户</label><Select value={accountId} disabled={command !== null} onValueChange={value => { if (value) setAccountId(value); }}><SelectTrigger id="withdraw-account" className="h-11 w-full"><SelectValue>{accounts.find(account => account.id === accountId)?.label}</SelectValue></SelectTrigger><SelectContent>{accounts.map(account => <SelectItem value={account.id} key={account.id}>{account.label}</SelectItem>)}</SelectContent></Select><label htmlFor="withdraw-amount" className="block text-sm">自动提现金额（元）</label><Input id="withdraw-amount" inputMode="decimal" value={amount} disabled={command !== null} onChange={event => setAmount(event.target.value)} /><label htmlFor="withdraw-note" className="block text-sm">提现备注</label><Input id="withdraw-note" value={note} maxLength={300} disabled={command !== null} onChange={event => setNote(event.target.value)} /><p className="text-sm text-muted-foreground">提交后冻结余额；管理员批准后出款。处理中不重复打款，最终失败后退回可用余额。</p><Button type="submit" disabled={save.isPending}>{save.isPending ? "正在提交…" : command ? "重试原提现申请" : "提交自动提现"}</Button>{validation && <p role="alert">{validation}</p>}{save.isError && <p role="alert">{save.error.message}</p>}{save.isSuccess && <p role="status">提现申请已保存，等待审核。</p>}</form>;
}

function PayoutReview({ merchantId, payout, enabled, close }: { merchantId: string; payout: Payout; enabled: boolean; close: () => void }) {
  const [reference, setReference] = useState(""); const client = useQueryClient();
  const save = useMutation({ retry: false, mutationFn: async (decision: "approve" | "reject") => {
    if (!reference.trim()) throw new Error("请填写审核依据或驳回原因。");
    const access = await merchantRequest<PayoutAccess>("payouts/session", { merchantId });
    if (!access.canReview) throw new Error("需要当前管理员权限。");
    return merchantRequest(`payouts/requests/${payout.id}/review`, { merchantId }, undefined, { token: access.csrfToken, body: { decision, reference: reference.trim() } });
  }, onSuccess: async () => { await client.invalidateQueries({ queryKey: ["merchant-console", merchantId] }); close(); } });
  return <section aria-label="审核自动提现" className="space-y-4 rounded-lg border p-5"><h4 className="font-medium">审核 ¥ {centsText(payout.amountCents)} 的自动提现</h4><p className="text-sm text-muted-foreground">批准后系统将向本申请固定的收款账户打款，请核对账户和金额。</p><label htmlFor="payout-review-reference" className="block text-sm">审核说明</label><Input id="payout-review-reference" maxLength={200} value={reference} onChange={event => setReference(event.target.value)} /><div className="flex flex-wrap gap-2">{payout.status === "PENDING" && <Button disabled={!enabled || save.isPending} onClick={() => save.mutate("approve")}>批准自动打款</Button>}<Button variant="outline" disabled={save.isPending} onClick={() => save.mutate("reject")}>驳回并释放余额</Button><Button variant="ghost" disabled={save.isPending} onClick={close}>取消审核</Button></div>{save.isError && <p role="alert">{save.error.message}</p>}</section>;
}
