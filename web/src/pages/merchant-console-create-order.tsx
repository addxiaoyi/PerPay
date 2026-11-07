import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { adminMountPath } from "@/admin-base";
import { merchantSessionFetch } from "@/api/merchant-session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Command = { merchantOrderId: string; amount: string; subject: string; channel: string };
const channels = [{ value: "alipay_scan", label: "支付宝扫码" }, { value: "alipay_web", label: "支付宝网页" }, { value: "wechat_native", label: "微信扫码" }];
export function MerchantConsoleCreateOrder({ merchantId, enabled, availableChannels }: { merchantId: string; enabled: boolean; availableChannels?: string[] | undefined }) {
  const available = availableChannels ? channels.filter(item => availableChannels.includes(item.value)) : channels;
  const [amount, setAmount] = useState(""), [subject, setSubject] = useState(""), [channel, setChannel] = useState(available[0]?.value ?? "");
  const [command, setCommand] = useState<Command | null>(null), [validation, setValidation] = useState("");
  const client = useQueryClient();
  const create = useMutation({ retry: false, mutationFn: async (input: Command) => {
    const response = await merchantSessionFetch(`${adminMountPath()}/api/merchant/orders?merchantId=${encodeURIComponent(merchantId)}`, {
      method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
    });
    const reply = await response.json() as { ok?: boolean; checkoutUrl?: string; order?: { status: string }; error?: string; code?: string };
    if (reply.code === "channel_unavailable") throw new Error("该支付方式当前未配置，请刷新页面后重新选择。");
    if (!response.ok || reply.ok !== true || !reply.checkoutUrl) throw new Error(response.status === 401 ? "登录已失效，请重新登录。" : "收款链接尚未生成，可重试本次订单。");
    const url = new URL(reply.checkoutUrl);
    if (url.origin !== window.location.origin || !url.pathname.startsWith(`${adminMountPath()}/epay/main/checkout/`)) throw new Error("收款链接无效，请刷新后核对订单。");
    return { url: url.toString(), pending: reply.order?.status === "pending_sync" };
  }, onSuccess: async () => { await client.invalidateQueries({ queryKey: ["merchant-console", merchantId] }); } });
  function submitOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (command) { create.mutate(command); return; }
    if (!/^(?:[1-9]\d{0,7}(?:\.\d{1,2})?|0\.\d{1,2})$/.test(amount.trim()) || Number(amount) <= 0 || !subject.trim()) { setValidation("请填写有效金额（最多两位小数）和收款说明。"); return; }
    const input = { merchantOrderId: `console_${crypto.randomUUID().replaceAll("-", "")}`, amount: amount.trim(), subject: subject.trim(), channel };
    setCommand(input); setValidation(""); create.mutate(input);
  }
  if (!enabled) return <p className="text-sm text-muted-foreground">升级期间暂不创建新收款订单。</p>;
  if (!available.length) return <p role="status" className="text-sm text-muted-foreground">当前没有可用的收款方式，请联系管理员配置。</p>;
  return <form onSubmit={submitOrder} className="max-w-xl space-y-4 rounded-lg border p-5"><h2 className="text-xl font-semibold">创建收款</h2><div className="space-y-2"><label htmlFor="collect-subject" className="text-sm">收款说明</label><Input id="collect-subject" value={subject} maxLength={127} disabled={command !== null} onChange={event => setSubject(event.target.value)} /></div><div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><label htmlFor="collect-amount" className="text-sm">金额（元）</label><Input id="collect-amount" inputMode="decimal" value={amount} maxLength={12} disabled={command !== null} onChange={event => setAmount(event.target.value)} /></div><div className="space-y-2"><label htmlFor="collect-channel" className="text-sm">支付方式</label><Select value={channel} disabled={command !== null} onValueChange={value => { if (value) setChannel(value); }}><SelectTrigger id="collect-channel"><SelectValue>{channels.find(item => item.value === channel)?.label}</SelectValue></SelectTrigger><SelectContent>{available.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></div></div>{create.data ? <div className="space-y-3"><p role="status" className="text-sm">{create.data.pending ? "订单已保存，正在获取渠道收款信息。" : "收款链接已生成。"}</p><a className="block break-all text-sm underline underline-offset-4" href={create.data.url} target="_blank" rel="noopener noreferrer">打开收款页面</a><Button type="button" variant="outline" onClick={() => { setCommand(null); create.reset(); setAmount(""); setSubject(""); }}>创建下一笔</Button></div> : <Button disabled={create.isPending} type="submit">{create.isPending ? "正在生成…" : command ? "重试本次订单" : "生成收款链接"}</Button>}{validation && <p role="alert" className="text-sm text-destructive">{validation}</p>}{create.isError && <p role="alert" className="text-sm text-destructive">{create.error.message}</p>}</form>;
}
