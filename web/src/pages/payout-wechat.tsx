import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { merchantRequest } from "@/api/merchant-console";
import type { PayoutAccess } from "@/api/payouts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConsoleQuery } from "@/components/merchant-console-state";

type Grant = { state: string; bridge: { mchId: string; appId: string; package: string } | null };
type WechatBridge = { invoke: (name: string, fields: Record<string, string>, callback: (reply: { err_msg?: string }) => void) => void };
const states: Record<string, string> = { NOT_REQUESTED: "尚未授权", REQUESTED: "准备申请授权", UNKNOWN: "正在核对授权结果", WAIT_USER_CONFIRM: "等待本人在微信确认", TAKING_EFFECT: "微信收款授权已生效", CLOSED: "收款授权已关闭", EXPIRED: "授权申请已过期，请核对后重新申请" };
async function command<T>(merchantId: string, path: string, body: unknown): Promise<T> {
  const session = await merchantRequest<PayoutAccess>("payouts/session", { merchantId });
  if (!session.wechatAuthorization) throw new Error("微信收款授权暂未开放。");
  return merchantRequest<T>(`payouts/${path}`, { merchantId }, undefined, { token: session.csrfToken, body });
}
function openGrant(bridge: NonNullable<Grant["bridge"]>) {
  const wechat = (window as Window & { WeixinJSBridge?: WechatBridge }).WeixinJSBridge;
  if (!wechat) return Promise.reject(new Error("请使用微信打开本页，完成本人收款授权。"));
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("微信确认尚未返回，请返回后刷新授权状态。")), 120000);
    wechat.invoke("requestMerchantTransfer", bridge, reply => {
      window.clearTimeout(timer);
      if (reply.err_msg !== "requestMerchantTransfer:ok") reject(new Error("尚未完成微信授权，可返回后重新打开或核对状态。"));
      else resolve();
    });
  });
}

export function WechatRecipientBinding({ merchantId }: { merchantId: string }) {
  const [holderName, setHolderName] = useState("");
  const [returned, setReturned] = useState(() => { const query = new URLSearchParams(location.search); return query.has("code") && query.has("state") ? { code: query.get("code")!, state: query.get("state")! } : null; });
  const client = useQueryClient();
  useEffect(() => { const url = new URL(location.href); if (url.searchParams.has("code")) { url.searchParams.delete("code"); url.searchParams.delete("state"); history.replaceState(history.state, "", url); } }, []);
  const bind = useMutation({ retry: false, mutationFn: async () => {
    if (returned) { await command(merchantId, "wechat/binding/complete", returned); setReturned(null); await client.invalidateQueries({ queryKey: ["merchant-console", merchantId] }); return; }
    if (!holderName.trim()) throw new Error("请填写本人真实姓名，用于收款校验。");
    const redirect = await command<{ url: string }>(merchantId, "wechat/binding/begin", { holderName: holderName.trim() });
    const url = new URL(redirect.url);
    if (url.origin !== "https://open.weixin.qq.com") throw new Error("微信授权地址无效。");
    location.assign(url.href);
  } });
  function beginBinding(event: FormEvent<HTMLFormElement>) { event.preventDefault(); bind.mutate(); }
  return <form className="max-w-xl space-y-4 rounded-lg border p-5" onSubmit={beginBinding}><h4 className="font-medium">绑定本人微信</h4>
    {!returned && <><label htmlFor="wechat-recipient-name" className="block text-sm">本人真实姓名</label><Input id="wechat-recipient-name" autoComplete="name" maxLength={100} value={holderName} onChange={event => setHolderName(event.target.value)} /></>}
    <p className="text-sm text-muted-foreground">在微信中完成身份验证，账户审核通过后再确认收款授权。可以在微信关闭授权。</p>
    <Button type="submit" disabled={bind.isPending}>{bind.isPending ? "正在核验…" : returned ? "完成微信绑定" : "前往微信验证身份"}</Button>
    {bind.isError && <p role="alert">{bind.error.message}</p>}{bind.isSuccess && !returned && <p role="status">微信身份已核验，请等待收款账户审核。</p>}
  </form>;
}

export function WechatPayoutAuthorization({ merchantId, accountId }: { merchantId: string; accountId: string }) {
  const client = useQueryClient(), key = ["merchant-console", merchantId, "wechat-authorization", accountId];
  const grant = useQuery({ queryKey: key, queryFn: ({ signal }) => merchantRequest<Grant>(`payouts/accounts/${accountId}/wechat`, { merchantId }, signal), retry: false });
  const authorize = useMutation({ retry: false, mutationFn: async () => {
    const latest = await command<Grant>(merchantId, `accounts/${accountId}/wechat/authorize`, {});
    if (latest.bridge) { await openGrant(latest.bridge); await command<Grant>(merchantId, `accounts/${accountId}/wechat/authorize`, {}); }
  }, onSettled: async () => { await client.invalidateQueries({ queryKey: key }); } });
  function confirmGrant() { authorize.mutate(); }
  return <div className="space-y-2"><ConsoleQuery query={grant}>{value => <p className="text-sm">{states[value.state] ?? "等待核对授权"}</p>}</ConsoleQuery>
    <Button type="button" variant="outline" disabled={authorize.isPending} onClick={confirmGrant}>{authorize.isPending ? "正在核对…" : "确认或刷新微信授权"}</Button>
    {authorize.isError && <p role="alert" className="text-sm">{authorize.error.message}</p>}</div>;
}
