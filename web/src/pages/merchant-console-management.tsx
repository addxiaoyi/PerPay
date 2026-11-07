import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { merchantRequest, MerchantConsoleError, type ConsoleMerchant } from "@/api/merchant-console";
import { ConsoleQuery } from "@/components/merchant-console-state";
import { Button } from "@/components/ui/button";

type Directory = { merchants: Array<{ merchantId: string; name: string; enabled: boolean; epayMerchantId: number }>; canEdit: boolean; csrfToken: string };
export function MerchantConsoleManagement({ merchantId, role }: { merchantId: string; role: ConsoleMerchant["role"] }) {
  const client = useQueryClient();
  const directory = useQuery({ queryKey: ["merchant-console", merchantId, "management", role], queryFn: ({ signal }) => merchantRequest<Directory>("management", { merchantId }, signal), retry: false, enabled: role === "admin" });
  const update = useMutation({ retry: false, mutationFn: async (command: { targetMerchantId: string; enabled: boolean }) => {
    const current = await merchantRequest<Directory>("management", { merchantId });
    if (!current.canEdit) throw new MerchantConsoleError(403, "forbidden");
    return merchantRequest("management/status", { merchantId }, undefined, { token: current.csrfToken, body: command });
  }, onSuccess: async () => { await client.invalidateQueries({ queryKey: ["merchant-console"] }); } });
  if (role !== "admin") return null;
  return <section className="space-y-5"><h2 className="text-xl font-semibold">商户状态</h2><p className="text-sm leading-6 text-muted-foreground">停用后不再接受新订单和商户操作，已有收款的确认与账务处理继续保留。处理当前商户前，请先切换到另一商户。</p><ConsoleQuery query={directory}>{value => <ul className="divide-y border-y">{value.merchants.map(item => <li key={item.merchantId} className="flex flex-wrap items-center justify-between gap-4 py-5"><div><p className="font-medium">{item.name}</p><p className="mt-1 text-xs text-muted-foreground">商户号 {item.epayMerchantId} · {item.enabled ? "已启用" : "已停用"}</p></div>{value.canEdit && item.merchantId !== merchantId && <Button variant="outline" disabled={update.isPending} onClick={() => update.mutate({ targetMerchantId: item.merchantId, enabled: !item.enabled })}>{item.enabled ? "停用商户" : "重新启用"}</Button>}</li>)}</ul>}</ConsoleQuery>{update.isError && <p role="alert" className="text-sm text-destructive">{update.error.message}</p>}{update.isSuccess && <p role="status" className="text-sm">商户状态已更新。</p>}</section>;
}
