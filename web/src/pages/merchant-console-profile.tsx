import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { merchantRequest, MerchantConsoleError, type ConsoleMerchant } from "@/api/merchant-console";
import { ConsoleQuery } from "@/components/merchant-console-state";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

type Profile = { displayName: string; callbackUrl: string; apiId: string; canEdit: boolean; csrfToken: string | null };
export function MerchantConsoleProfile({ merchantId, role }: { merchantId: string; role: ConsoleMerchant["role"] }) {
  const profile = useQuery({ queryKey: ["merchant-console", merchantId, "profile", role], queryFn: ({ signal }) => merchantRequest<Profile>("profile", { merchantId }, signal), retry: false });
  return <section className="max-w-xl space-y-5"><h2 className="text-xl font-semibold">商户资料</h2><p className="text-sm leading-6 text-muted-foreground">新订单使用当前回调地址。已有订单保留创建时的地址和签名密钥。</p><ConsoleQuery query={profile}>{value => value.canEdit && role !== "member" ? <ProfileForm key={`${value.displayName}:${value.callbackUrl}`} merchantId={merchantId} profile={value} /> : <dl className="space-y-4 text-sm"><div><dt className="text-muted-foreground">商户名称</dt><dd className="mt-1">{value.displayName}</dd></div><div><dt className="text-muted-foreground">回调地址</dt><dd className="mt-1 break-all">{value.callbackUrl}</dd></div></dl>}</ConsoleQuery></section>;
}
function ProfileForm({ merchantId, profile }: { merchantId: string; profile: Profile }) {
  const [name, setName] = useState(profile.displayName), [callbackUrl, setCallbackUrl] = useState(profile.callbackUrl), [error, setError] = useState("");
  const client = useQueryClient();
  const save = useMutation({ retry: false, mutationFn: async () => {
    const current = await merchantRequest<Profile>("profile", { merchantId });
    if (!current.canEdit || !current.csrfToken) throw new MerchantConsoleError(403, "forbidden");
    return merchantRequest("profile", { merchantId }, undefined, { token: current.csrfToken, body: { displayName: name.trim(), callbackUrl: callbackUrl.trim() } });
  }, onSuccess: async () => { await client.invalidateQueries({ queryKey: ["merchant-console"] }); } });
  function submitProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    let valid = false;
    try { const url = new URL(callbackUrl); valid = url.protocol === "https:" && !url.username && !url.password && !url.hash; } catch { valid = false; }
    if (!name.trim() || !valid) { setError("请填写商户名称和有效的 HTTPS 回调地址。"); return; }
    setError(""); save.mutate();
  }
  return <form className="space-y-4 rounded-lg border p-5" onSubmit={submitProfile}><div className="space-y-2"><label htmlFor="profile-name" className="text-sm">商户名称</label><Input id="profile-name" value={name} maxLength={80} disabled={save.isPending} onChange={event => setName(event.target.value)} /></div><div className="space-y-2"><label htmlFor="profile-callback" className="text-sm">回调地址</label><Input id="profile-callback" type="url" value={callbackUrl} maxLength={2048} disabled={save.isPending} onChange={event => setCallbackUrl(event.target.value)} /></div><Button type="submit" disabled={save.isPending}>{save.isPending ? "保存中…" : "保存资料"}</Button>{(error || save.isError) && <p role="alert" className="text-sm text-destructive">{error || save.error?.message}</p>}</form>;
}
