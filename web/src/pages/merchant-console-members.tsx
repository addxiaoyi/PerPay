import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { merchantRequest, MerchantConsoleError, dateText, type ConsoleSession } from "@/api/merchant-console";
import { ConsoleQuery } from "@/components/merchant-console-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Members = { merchantId: string; members: Array<{ userId: string; username: string; enabled: boolean; addedAt?: string }> };
type Command = { action: "grant"; userId: string } | { action: "set_status"; userId: string; enabled: boolean };

export function MerchantConsoleMembers({ merchantId }: { merchantId: string }) {
  const cache = useQueryClient();
  const [userId, setUserId] = useState("");
  const [validation, setValidation] = useState("");
  const session = useQuery({ queryKey: ["merchant-console", merchantId, "members-session"], queryFn: ({ signal }) => merchantRequest<ConsoleSession>("session", { merchantId }, signal), retry: false });
  const isAdmin = session.data?.role === "admin" && !session.isError;
  const members = useQuery({ queryKey: ["merchant-console", merchantId, "members"], queryFn: ({ signal }) => merchantRequest<Members>("members", { merchantId }, signal), enabled: isAdmin, retry: false });
  const change = useMutation({
    retry: false,
    mutationFn: async (command: Command) => {
      const access = await merchantRequest<ConsoleSession>("session", { merchantId });
      if (!access.canAdminister || !access.csrfToken) throw new MerchantConsoleError(403, "forbidden");
      return merchantRequest<Members>("members", { merchantId }, undefined, { token: access.csrfToken, body: command });
    },
    onSuccess: confirmed => {
      cache.setQueryData(["merchant-console", merchantId, "members"], confirmed);
      setUserId("");
    },
  });
  function grantMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = userId.trim();
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) { setValidation("请输入现有 StarMC 账户的完整 ID。"); return; }
    setValidation(""); change.mutate({ action: "grant", userId: id });
  }
  return <section aria-label="成员权限" className="space-y-6">
    <div><h2 className="text-xl font-semibold">成员权限</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">沿用 StarMC 账户授权。停用成员后，其商户访问权限立即失效。</p></div>
    <ConsoleQuery query={session}>{access => isAdmin ? <>
      {access.canAdminister ? <form onSubmit={grantMember} className="max-w-xl space-y-3">
        <label htmlFor="merchant-member-id" className="block text-sm font-medium">StarMC 账户 ID</label>
        <Input id="merchant-member-id" value={userId} onChange={event => setUserId(event.target.value)} disabled={change.isPending} maxLength={128} autoComplete="off" autoCapitalize="none" spellCheck={false} className="h-11 text-base" />
        <Button type="submit" disabled={change.isPending}>{change.isPending ? "保存中…" : "添加成员"}</Button>
      </form> : <p className="text-sm text-muted-foreground">升级期间可以查看已有授权，暂不更改成员。</p>}
      <ConsoleQuery query={members}>{value => value.members.length ? <ul className="divide-y">{value.members.map(member => <li key={member.userId} className="flex flex-wrap items-center justify-between gap-4 py-5">
        <div className="min-w-0 space-y-1"><p className="break-all font-medium">{member.username || "商户成员"}</p><p className="break-all text-xs text-muted-foreground">账户 ID：{member.userId}</p><p className="text-sm text-muted-foreground">{member.enabled ? "已授权" : "已停用"}{member.addedAt ? ` · ${dateText(member.addedAt)}` : ""}</p></div>
        <Button variant="outline" disabled={!access.canAdminister || change.isPending} onClick={() => change.mutate({ action: "set_status", userId: member.userId, enabled: !member.enabled })}>{member.enabled ? "停用授权" : "恢复授权"}</Button>
      </li>)}</ul> : <p className="py-6 text-sm text-muted-foreground">暂无额外成员。商户所有者的权限由账户绑定管理。</p>}</ConsoleQuery>
    </> : <p className="text-sm text-muted-foreground">成员授权由管理员维护。</p>}</ConsoleQuery>
    {validation && <p role="alert" className="text-sm text-destructive">{validation}</p>}
    {change.isError && <div role="alert" className="space-y-3"><p className="text-sm text-destructive">{change.error instanceof MerchantConsoleError ? change.error.message : "保存结果未确认，请刷新授权后核对。"}</p><Button variant="outline" onClick={() => void members.refetch()}>刷新授权</Button></div>}
    {change.isSuccess && <p role="status" className="text-sm">成员授权已更新。</p>}
  </section>;
}
