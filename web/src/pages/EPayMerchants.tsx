import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { ApiError } from "@/api/client";
import { formatFee, listMerchantFees, merchantFeeHistory, parseFeePercent, updateMerchantFee, type MerchantFee } from "@/api/epay-merchants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PageHeading } from "@/components/page-heading";

export default function EPayMerchants() {
  const [pages, setPages] = useState<Array<number | null>>([null]);
  const [selected, setSelected] = useState<MerchantFee | null>(null);
  const [fee, setFee] = useState("");
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState("");
  const [historyPages, setHistoryPages] = useState<Array<number | null>>([null]);
  const queryClient = useQueryClient();
  const cursor = pages.at(-1) ?? null;
  const merchants = useQuery({ queryKey: ["epay-merchants", cursor], queryFn: ({ signal }) => listMerchantFees(cursor, signal), retry: false });
  const before = historyPages.at(-1) ?? null;
  const history = useQuery({ queryKey: ["epay-fee-history", selected?.merchantId, before], queryFn: ({ signal }) => merchantFeeHistory(selected!.merchantId, before, signal), enabled: selected !== null, retry: false });
  const changed = useMutation({
    retry: false,
    mutationFn: ({ merchant, feeBps, note }: { merchant: MerchantFee; feeBps: number; note: string }) => updateMerchantFee(merchant, feeBps, note),
    onSuccess: async ({ data }) => {
      await queryClient.invalidateQueries({ queryKey: ["epay-merchants"] });
      await queryClient.invalidateQueries({ queryKey: ["epay-fee-history", data.merchantId] });
      setSelected(current => current?.merchantId === data.merchantId ? { ...current, feeBps: data.feeBps, version: data.version } : current);
      setFee((data.feeBps / 100).toFixed(2));
      setReason("");
      setNotice("费率已更新，仅对新订单生效。");
    },
  });
  function selectMerchant(merchant: MerchantFee) {
    if (changed.isPending) return;
    setSelected(merchant);
    setFee((merchant.feeBps / 100).toFixed(2));
    setReason("");
    setNotice("");
    setHistoryPages([null]);
    changed.reset();
  }
  function submitFee(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const bps = parseFeePercent(fee);
    if (!selected || bps === null || bps === selected.feeBps || !reason.trim() || reason.trim().length > 512 || changed.isPending) return;
    setNotice("");
    changed.mutate({ merchant: selected, feeBps: bps, note: reason.trim() });
  }
  const bps = parseFeePercent(fee);
  const valid = selected && bps !== null && bps !== selected.feeBps && reason.trim().length > 0 && reason.trim().length <= 512;
  return <div className="space-y-6">
    <PageHeading title="商户费率" />
    <p className="text-sm text-amber-700 dark:text-amber-400" role="status">候选环境数据尚未完成财务对账。</p>
    {merchants.isPending ? <p role="status" className="text-sm text-muted-foreground">正在加载商户…</p> : merchants.isError ? <div role="alert" className="flex flex-wrap items-center gap-3 text-sm"><AlertCircle className="size-4" />商户列表暂时不可用。<Button variant="outline" size="sm" onClick={() => void merchants.refetch()}><RefreshCw className="size-4" />重试</Button></div> : <>
      <div className="overflow-x-auto border-y">
        <table className="w-full text-left text-sm">
          <thead className="text-muted-foreground"><tr className="border-b"><th className="px-1 py-3 font-medium sm:px-3">商户</th><th className="px-1 py-3 font-medium sm:px-3">状态</th><th className="px-1 py-3 font-medium sm:px-3">费率</th><th className="px-1 py-3 font-medium sm:px-3"><span className="sr-only">操作</span></th></tr></thead>
          <tbody>{merchants.data.data.merchants.map(merchant => <tr key={merchant.merchantId} className="border-b last:border-0"><td className="max-w-40 px-1 py-3 sm:px-3"><div className="break-all font-medium">{merchant.name}</div><div className="break-all text-xs text-muted-foreground">ID {merchant.merchantId}</div></td><td className="whitespace-nowrap px-1 py-3 sm:px-3">{merchant.enabled ? "启用" : "停用"}</td><td className="whitespace-nowrap px-1 py-3 tabular-nums sm:px-3">{formatFee(merchant.feeBps)}</td><td className="px-1 py-3 text-right sm:px-3"><Button variant="outline" size="sm" disabled={changed.isPending} onClick={() => selectMerchant(merchant)}>管理费率</Button></td></tr>)}</tbody>
        </table>
        {merchants.data.data.merchants.length === 0 && <p className="p-4 text-sm text-muted-foreground">暂无商户</p>}
      </div>
      <div className="flex items-center justify-end gap-2"><Button variant="outline" size="icon" aria-label="上一页" disabled={pages.length === 1 || changed.isPending} onClick={() => { setSelected(null); setPages(value => value.slice(0, -1)); }}><ChevronLeft className="size-4" /></Button><Button variant="outline" size="icon" aria-label="下一页" disabled={merchants.data.data.nextAfter === null || changed.isPending} onClick={() => { setSelected(null); setPages(value => [...value, merchants.data.data.nextAfter]); }}><ChevronRight className="size-4" /></Button></div>
    </>}
    {selected && <section className="space-y-5 border-t pt-5" aria-labelledby="fee-editor-title">
      <div><h2 id="fee-editor-title" className="text-base font-semibold">{selected.name}</h2><p className="text-sm text-muted-foreground">当前费率 {formatFee(selected.feeBps)}</p></div>
      <form className="max-w-xl space-y-4" onSubmit={submitFee}>
        <div className="space-y-1.5"><label className="text-sm font-medium" htmlFor="fee-percent">新费率（%）</label><Input id="fee-percent" inputMode="decimal" value={fee} onChange={event => setFee(event.target.value)} maxLength={5} aria-invalid={fee !== "" && bps === null} disabled={changed.isPending} />{fee !== "" && bps === null && <p className="text-sm text-destructive">请输入 0 到 50 之间、最多两位小数的百分比。</p>}</div>
        <div className="space-y-1.5"><label className="text-sm font-medium" htmlFor="fee-reason">变更原因</label><Textarea id="fee-reason" value={reason} onChange={event => setReason(event.target.value)} maxLength={512} disabled={changed.isPending} /></div>
        <Button type="submit" disabled={!valid || changed.isPending}>{changed.isPending ? "正在保存…" : "保存费率"}</Button>
        {notice && <p role="status" className="text-sm">{notice}</p>}
        {changed.isError && <p role="alert" className="text-sm text-destructive">{changed.error instanceof ApiError && changed.error.status === 409 ? "费率已被其他管理员修改，请重新选择商户后再试。" : "保存结果未能确认，请刷新商户及变更记录后核对。"}</p>}
      </form>
      <div className="space-y-3 border-t pt-5"><h3 className="text-sm font-semibold">变更记录</h3>
        {history.isPending ? <p role="status" className="text-sm text-muted-foreground">正在加载记录…</p> : history.isError ? <p role="alert" className="text-sm text-destructive">变更记录暂时不可用。<Button variant="link" size="sm" onClick={() => void history.refetch()}>重试</Button></p> : <>
          {history.data.data.changes.length === 0 ? <p className="text-sm text-muted-foreground">暂无变更记录</p> : <ul className="divide-y">{history.data.data.changes.map(change => <li key={change.sequence} className="py-3 text-sm"><div className="flex flex-wrap justify-between gap-2"><span className="font-medium tabular-nums">{formatFee(change.oldFeeBps)} → {formatFee(change.newFeeBps)}</span><time className="text-muted-foreground" dateTime={new Date(change.occurredAt).toISOString()}>{new Date(change.occurredAt).toLocaleString("zh-CN")}</time></div><p className="mt-1 text-muted-foreground">{change.actor} · {change.reason}</p></li>)}</ul>}
          <div className="flex justify-end gap-2"><Button variant="outline" size="icon" aria-label="上一页记录" disabled={historyPages.length === 1} onClick={() => setHistoryPages(value => value.slice(0, -1))}><ChevronLeft className="size-4" /></Button><Button variant="outline" size="icon" aria-label="下一页记录" disabled={history.data.data.nextBefore === null} onClick={() => setHistoryPages(value => [...value, history.data.data.nextBefore])}><ChevronRight className="size-4" /></Button></div>
        </>}
      </div>
    </section>}
  </div>;
}
