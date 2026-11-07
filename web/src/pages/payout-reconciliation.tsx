import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { merchantRequest, dateText } from "@/api/merchant-console";
import type { PayoutAccess } from "@/api/payouts";
import { ConsoleQuery } from "@/components/merchant-console-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Run = { id: string; day: string; finishedAt: number | null; checked: number; issues: number; status: string };
export function PayoutReconciliation({ merchantId, canRun }: { merchantId: string; canRun: boolean }) {
  const [day, setDay] = useState(() => new Date(Date.now() + 8 * 3600000 - 86400000).toISOString().slice(0, 10));
  const client = useQueryClient(), key = ["merchant-console", merchantId, "payout-reconciliation"];
  const reports = useQuery({ queryKey: key, queryFn: ({ signal }) => merchantRequest<{ runs: Run[] }>("payouts/reconciliations", { merchantId }, signal), retry: false });
  const run = useMutation({ retry: false, mutationFn: async () => {
    const access = await merchantRequest<PayoutAccess>("payouts/session", { merchantId });
    if (!access.canReconcile) throw new Error("当前无法启动渠道核对。");
    return merchantRequest("payouts/reconciliations", { merchantId }, undefined, { token: access.csrfToken, body: { day } });
  }, onSettled: async () => { await client.invalidateQueries({ queryKey: ["merchant-console", merchantId] }); } });
  function reconcile(event: FormEvent<HTMLFormElement>) { event.preventDefault(); run.mutate(); }
  return <section className="space-y-4" aria-label="提现日终核对"><h3 className="font-semibold">提现日终核对</h3><p className="text-sm text-muted-foreground">按北京时间核对已提交的提现。渠道完整资金账单仍需另行核验；查单一致不代表账单已对平。</p>
    {canRun && <form className="flex flex-wrap items-end gap-3" onSubmit={reconcile}><div><label htmlFor="payout-day" className="block text-sm">核对日期</label><Input id="payout-day" type="date" value={day} onChange={event => setDay(event.target.value)} /></div><Button type="submit" disabled={run.isPending}>{run.isPending ? "正在核对…" : "核对渠道出款"}</Button></form>}
    {run.isError && <p role="alert">{run.error.message}</p>}<ConsoleQuery query={reports}>{value => value.runs.length ? <ul className="divide-y">{value.runs.map(report => <li className="space-y-1 py-3 text-sm" key={report.id}><p>{report.day} · 本商户 {report.checked} 笔 · {report.issues ? `${report.issues} 笔待处理` : report.status === "RUNNING" ? "核对中" : "查单一致"}</p><p className="text-muted-foreground">{report.finishedAt ? dateText(report.finishedAt) : "尚未完成"} · 待核对渠道资金账单</p></li>)}</ul> : <p className="text-sm text-muted-foreground">暂无本商户的提现核对记录。</p>}</ConsoleQuery>
  </section>;
}
