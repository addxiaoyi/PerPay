import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { merchantRequest, MerchantConsoleError, type ConsoleMerchant } from "@/api/merchant-console";
import { ConsoleQuery } from "@/components/merchant-console-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Access = { canCreate: boolean; csrfToken: string | null };
type Command = { requestId: string; userId: string; displayName: string; callbackUrl: string };
export function MerchantConsoleEnrollment({ merchantId, role }: { merchantId: string; role: ConsoleMerchant["role"] }) {
  const access = useQuery({ queryKey: ["merchant-console", merchantId, "creation-session", role], queryFn: ({ signal }) => merchantRequest<Access>("merchants/creation-session", { merchantId }, signal), enabled: role === "admin", retry: false });
  if (role !== "admin") return null;
  return <section className="max-w-xl space-y-5"><h2 className="text-xl font-semibold">新增商户</h2><p className="text-sm leading-6 text-muted-foreground">绑定已有 StarMC 账户，创建独立商户号和零余额账本。账户身份与成员权限继续由主站管理。</p><ConsoleQuery query={access}>{session => session.canCreate ? <EnrollmentForm merchantId={merchantId} /> : <p className="text-sm text-muted-foreground">当前暂不开放新增商户。</p>}</ConsoleQuery></section>;
}

function EnrollmentForm({ merchantId }: { merchantId: string }) {
  const [userId, setUserId] = useState(""), [name, setName] = useState(""), [callbackUrl, setCallbackUrl] = useState("");
  const [pending, setPending] = useState<Command | null>(null), [validation, setValidation] = useState("");
  const client = useQueryClient();
  const create = useMutation({ retry: false, mutationFn: async (command: Command) => {
    const access = await merchantRequest<Access>("merchants/creation-session", { merchantId });
    if (!access.canCreate || !access.csrfToken) throw new MerchantConsoleError(403, "forbidden");
    return merchantRequest<{ createdMerchantId: string; epayMerchantId: number; duplicate: boolean }>("merchants/create", { merchantId }, undefined, { token: access.csrfToken, body: command });
  }, onSuccess: async () => { setPending(null); setUserId(""); setName(""); setCallbackUrl(""); await client.invalidateQueries({ queryKey: ["merchant-console", "directory"] }); } });
  function submitMerchant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) { create.mutate(pending); return; }
    let validUrl = false;
    try { const url = new URL(callbackUrl); validUrl = url.protocol === "https:" && !url.username && !url.password && !url.hash; } catch { validUrl = false; }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId.trim()) || !name.trim() || !validUrl) { setValidation("请填写有效账户 ID、商户名称和 HTTPS 回调地址。"); return; }
    const command = { requestId: crypto.randomUUID(), userId: userId.trim(), displayName: name.trim(), callbackUrl: callbackUrl.trim() };
    setValidation(""); setPending(command); create.mutate(command);
  }
  return <form className="space-y-4 rounded-lg border p-5" onSubmit={submitMerchant}><div className="space-y-2"><label htmlFor="new-merchant-user" className="text-sm">StarMC 账户 ID</label><Input id="new-merchant-user" value={userId} maxLength={128} disabled={pending !== null} onChange={event => setUserId(event.target.value)} /></div><div className="space-y-2"><label htmlFor="new-merchant-name" className="text-sm">商户名称</label><Input id="new-merchant-name" value={name} maxLength={80} disabled={pending !== null} onChange={event => setName(event.target.value)} /></div><div className="space-y-2"><label htmlFor="new-merchant-callback" className="text-sm">回调地址</label><Input id="new-merchant-callback" type="url" value={callbackUrl} maxLength={2048} disabled={pending !== null} onChange={event => setCallbackUrl(event.target.value)} placeholder="https://example.com/payment/notify" /></div><Button type="submit" disabled={create.isPending}>{create.isPending ? "正在创建…" : pending ? "重试原商户申请" : "创建商户"}</Button>{validation && <p role="alert" className="text-sm text-destructive">{validation}</p>}{create.isError && <p role="alert" className="text-sm text-destructive">{create.error.message}</p>}{create.isSuccess && <p role="status" className="text-sm">商户已创建，EPay 商户号 {create.data.epayMerchantId}。可在顶部商户列表切换查看。</p>}</form>;
}
