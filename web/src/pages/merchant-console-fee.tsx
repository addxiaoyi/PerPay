import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { merchantRequest, dateText, MerchantConsoleError, type ConsoleSession } from "@/api/merchant-console";
import { parseFeePercent, formatFee, type FeeChange } from "@/api/epay-merchants";
import { ConsoleQuery } from "@/components/merchant-console-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Fee = { merchantId: number; feeBps: number; version: number };
export function MerchantConsoleFee({ merchantId, role }: { merchantId: string; role: ConsoleSession["role"] }) {
  const session = useQuery({ queryKey: ["merchant-console", merchantId, "session", role], queryFn: ({ signal }) => merchantRequest<ConsoleSession>("session", { merchantId }, signal), retry: false });
  const fee = useQuery({ queryKey: ["merchant-console", merchantId, "fee"], queryFn: ({ signal }) => merchantRequest<Fee>("fee", { merchantId }, signal), retry: false });
  const isAdmin = role === "admin" && session.data?.role === "admin" && !session.isError;
  const history = useQuery({ queryKey: ["merchant-console", merchantId, "fee-history", role], queryFn: ({ signal }) => merchantRequest<{ changes: FeeChange[] }>("fee/history", { merchantId }, signal), enabled: isAdmin, retry: false });
  return <section className="space-y-5"><h2 className="text-xl font-semibold">费率与操作记录</h2><ConsoleQuery query={session}>{access => <ConsoleQuery query={fee}>{current => <><p className="text-sm text-muted-foreground">当前费率 <span className="ml-2 text-2xl font-semibold text-foreground">{formatFee(current.feeBps)}</span></p>{isAdmin && access.canAdminister ? <FeeForm key={`${merchantId}:${current.version}`} merchantId={merchantId} current={current} /> : <p className="text-sm text-muted-foreground">{isAdmin ? "升级期间暂不修改费率。" : "费率由管理员维护。"}</p>}</>}</ConsoleQuery>}</ConsoleQuery>{isAdmin && <div className="border-t pt-5"><h3 className="font-medium">最近变更</h3><ConsoleQuery query={history}>{value => value.changes.length ? <ul className="divide-y">{value.changes.map(entry => <li key={entry.sequence} className="space-y-1 py-4 text-sm"><div className="flex flex-wrap justify-between gap-2"><span className="font-medium">{formatFee(entry.oldFeeBps)} → {formatFee(entry.newFeeBps)}</span><time className="text-muted-foreground">{dateText(entry.occurredAt)}</time></div><p className="break-all">{entry.reason}</p><p className="break-all text-xs text-muted-foreground">操作人 {entry.actor}</p></li>)}</ul> : <p className="text-sm text-muted-foreground">暂无费率变更记录。</p>}</ConsoleQuery></div>}</section>;
}

function FeeForm({ merchantId, current }: { merchantId: string; current: Fee }) {
  const [value, setValue] = useState((current.feeBps / 100).toFixed(2));
  const [reason, setReason] = useState("");
  const [validation, setValidation] = useState("");
  const queryClient = useQueryClient();
  const save = useMutation({
    retry: false,
    mutationFn: async (feeBps: number) => {
      const session = await merchantRequest<ConsoleSession>("session", { merchantId });
      if (!session.canAdminister || !session.csrfToken) throw new MerchantConsoleError(403, "forbidden");
      return merchantRequest<Fee>("fee", { merchantId }, undefined, { token: session.csrfToken, body: { expectedFeeBps: current.feeBps, expectedVersion: current.version, feeBps, reason: reason.trim() } });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["merchant-console", merchantId] }),
        queryClient.invalidateQueries({ queryKey: ["merchant-console", "directory"] }),
      ]);
    },
  });
  function submitFee(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const feeBps = parseFeePercent(value);
    if (feeBps === null || feeBps === current.feeBps || !reason.trim()) { setValidation("请输入与当前不同的费率（0%–50%，最多两位小数）并填写原因。"); return; }
    setValidation(""); save.mutate(feeBps);
  }
  return <form className="max-w-xl space-y-4" onSubmit={submitFee}><div className="space-y-2"><label htmlFor="merchant-fee" className="text-sm font-medium">新费率（%）</label><Input id="merchant-fee" inputMode="decimal" className="h-11 text-base" value={value} maxLength={5} disabled={save.isPending} onChange={event => setValue(event.target.value)} /></div><div className="space-y-2"><label htmlFor="merchant-fee-reason" className="text-sm font-medium">变更原因</label><Textarea id="merchant-fee-reason" className="text-base" value={reason} maxLength={512} disabled={save.isPending} onChange={event => setReason(event.target.value)} /></div><p className="text-sm text-muted-foreground">保存后仅对新订单生效，已有订单的费率保持原值。</p><Button type="submit" disabled={save.isPending}>{save.isPending ? "保存中…" : "保存费率"}</Button>{validation && <p role="alert" className="text-sm text-destructive">{validation}</p>}{save.isError && <p role="alert" className="text-sm text-destructive">{save.error instanceof MerchantConsoleError ? save.error.message : "保存结果未确认，请刷新后核对。"}</p>}</form>;
}
