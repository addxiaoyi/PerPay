import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { merchantRequest, MerchantConsoleError, centsText, type ConsoleBalance, type ConsoleSession } from "@/api/merchant-console";
import { ConsoleQuery } from "@/components/merchant-console-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function MerchantConsoleBalanceForm({ merchantId, role }: { merchantId: string; role: ConsoleSession["role"] }) {
  const session = useQuery({ queryKey: ["merchant-console", merchantId, "session", role], queryFn: ({ signal }) => merchantRequest<ConsoleSession>("session", { merchantId }, signal), enabled: role === "admin", retry: false });
  const balance = useQuery({ queryKey: ["merchant-console", merchantId, "balance"], queryFn: ({ signal }) => merchantRequest<ConsoleBalance>("balance", { merchantId }, signal), enabled: role === "admin", retry: false });
  if (role !== "admin") return null;
  return <ConsoleQuery query={session}>{access => access.canAdminister && access.role === "admin" ? <ConsoleQuery query={balance}>{current => current.migrationBaselineVerified && current.version !== null ? <BalanceForm key={merchantId} merchantId={merchantId} current={current} /> : <p className="text-sm text-muted-foreground">期初余额核对完成后开放管理员调整。</p>}</ConsoleQuery> : null}</ConsoleQuery>;
}

type AdjustmentRequest = { deltaCents: number; reason: string; requestId: string; expectedVersion: number };

function BalanceForm({ merchantId, current }: { merchantId: string; current: ConsoleBalance }) {
  const [direction, setDirection] = useState("subtract"), [value, setValue] = useState(""), [reason, setReason] = useState("");
  const [validation, setValidation] = useState("");
  const [submitted, setSubmitted] = useState<AdjustmentRequest | null>(null);
  const queryClient = useQueryClient();
  const save = useMutation({
    retry: false,
    mutationFn: async (input: AdjustmentRequest) => {
      const session = await merchantRequest<ConsoleSession>("session", { merchantId });
      if (!session.canAdminister || !session.csrfToken) throw new MerchantConsoleError(403, "forbidden");
      return merchantRequest<ConsoleBalance>("balance/adjust", { merchantId }, undefined, { token: session.csrfToken, body: input });
    },
    onSuccess: async () => {
      setSubmitted(null); setValue(""); setReason(""); setValidation("");
      await queryClient.invalidateQueries({ queryKey: ["merchant-console", merchantId] });
    },
    onError: async error => {
      // An uncertain transport outcome must reuse the same request ID and payload.
      if (error instanceof MerchantConsoleError && [400, 401, 403, 404, 409].includes(error.status)) {
        setSubmitted(null);
        if (error.status === 409) await queryClient.invalidateQueries({ queryKey: ["merchant-console", merchantId, "balance"] });
      }
    },
  });
  const locked = save.isPending || submitted !== null;
  function submitAdjustment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitted) { save.mutate(submitted); return; }
    if (!/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(value) || !reason.trim()) { setValidation("请填写金额（最多两位小数）和调整原因。"); return; }
    const [yuan, fraction = ""] = value.split(".");
    const amount = BigInt(yuan!) * 100n + BigInt(fraction.padEnd(2, "0"));
    const deltaCents = Number(direction === "subtract" ? -amount : amount);
    if (amount === 0n || !Number.isSafeInteger(deltaCents) || (deltaCents < 0 && BigInt(current.availableCents) + BigInt(deltaCents) < 0n)) { setValidation("金额必须大于零，扣减金额不能超过可用余额。"); return; }
    if (current.version === null) { setValidation("余额正在核对，请稍后重试。"); return; }
    const input = { deltaCents, reason: reason.trim(), requestId: crypto.randomUUID(), expectedVersion: current.version };
    setValidation(""); setSubmitted(input); save.mutate(input);
  }
  return <section className="mt-8 border-t pt-6" aria-label="管理员调整余额"><h2 className="text-xl font-semibold">调整余额</h2><p className="mt-2 text-sm text-muted-foreground">当前可用 ¥ {centsText(current.availableCents)}。调整会记录操作人和原因。</p><form className="mt-5 max-w-xl space-y-4" onSubmit={submitAdjustment}>
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><div className="space-y-2"><label htmlFor="balance-direction" className="text-sm font-medium">调整方向</label><Select value={direction} disabled={locked} onValueChange={value => { if (value) setDirection(value); }}><SelectTrigger id="balance-direction" className="h-11 w-full text-base"><SelectValue>{direction === "subtract" ? "扣减余额" : "增加余额"}</SelectValue></SelectTrigger><SelectContent><SelectItem value="subtract">扣减余额</SelectItem><SelectItem value="add">增加余额</SelectItem></SelectContent></Select></div><div className="space-y-2"><label htmlFor="balance-amount" className="text-sm font-medium">金额（元）</label><Input id="balance-amount" inputMode="decimal" autoComplete="off" className="h-11 text-base" maxLength={15} value={value} disabled={locked} onChange={event => setValue(event.target.value)} /></div></div>
    <div className="space-y-2"><label htmlFor="balance-reason" className="text-sm font-medium">调整原因</label><Textarea id="balance-reason" className="text-base" maxLength={512} value={reason} disabled={locked} onChange={event => setReason(event.target.value)} /></div>
    <Button type="submit" disabled={save.isPending}>{save.isPending ? "正在提交…" : submitted ? "重试本次调整" : "确认调整"}</Button>
    {validation && <p role="alert" className="text-sm text-destructive">{validation}</p>}{save.isError && <p role="alert" className="text-sm text-destructive">{save.error instanceof MerchantConsoleError ? save.error.message : "调整结果未确认，可重试本次请求。"}</p>}
  </form></section>;
}
