import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { merchantRequest, centsText, dateText, paymentLabel, type ConsoleOrder } from "@/api/merchant-console";
import { ConsolePagination, ConsoleQuery } from "@/components/merchant-console-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MerchantConsoleCallbacks } from "./merchant-console-callbacks";

export function MerchantConsoleOrders({ merchantId }: { merchantId: string }) {
  const [draft, setDraft] = useState("");
  const [filters, setFilters] = useState({ search: "", status: "", page: 1 });
  const [notificationOrder, setNotificationOrder] = useState<string | null>(null);
  const orders = useQuery({ queryKey: ["merchant-console", merchantId, "orders", filters], queryFn: ({ signal }) => merchantRequest<{ orders: ConsoleOrder[]; hasNext: boolean }>("combined-orders", { merchantId, search: filters.search, status: filters.status, page: String(filters.page) }, signal), retry: false });
  function searchOrders(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setNotificationOrder(null); setFilters(value => ({ ...value, search: draft.trim(), page: 1 })); }
  return <section aria-labelledby="merchant-orders-title" className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="merchant-orders-title" className="text-xl font-semibold">订单</h2><p className="text-sm text-muted-foreground">保留原始记录，来源分别标明</p></div>
    <form onSubmit={searchOrders} className="flex flex-wrap items-end gap-3"><div className="min-w-0 grow space-y-1.5"><label htmlFor="order-search" className="text-sm">订单号</label><Input id="order-search" className="h-11 text-base" placeholder="商户订单号或平台订单号" value={draft} maxLength={128} onChange={event => setDraft(event.target.value)} /></div><div className="space-y-1.5"><label htmlFor="order-status" className="block text-sm">状态</label><Select value={filters.status} onValueChange={status => { setNotificationOrder(null); setFilters(value => ({ ...value, status: status ?? "", page: 1 })); }}><SelectTrigger id="order-status" className="h-11 min-w-40"><SelectValue>{filters.status ? paymentLabel(filters.status) : "全部状态"}</SelectValue></SelectTrigger><SelectContent><SelectGroup><SelectItem value="">全部状态</SelectItem>{["pending_payment", "paid", "partial_refund", "refund_processing", "refunded", "closed", "frozen"].map(status => <SelectItem key={status} value={status}>{paymentLabel(status)}</SelectItem>)}</SelectGroup></SelectContent></Select></div><Button type="submit" className="h-11">搜索</Button></form>
    <ConsoleQuery query={orders}>{value => <><div className="divide-y border-y">{value.orders.length === 0 ? <p className="py-10 text-muted-foreground">没有符合条件的订单。</p> : value.orders.map(order => <article key={`${order.source}:${order.id}`} className="grid gap-3 py-5 sm:grid-cols-[minmax(0,1fr)_auto]"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="text-xs text-muted-foreground">{order.source === "main_site" ? "主站订单" : "支付网关订单"}</span><span className="text-sm font-medium">{paymentLabel(order.status)}</span></div><p className="mt-1 break-all font-medium">{order.merchantOrderId}</p><p className="mt-1 break-all text-xs text-muted-foreground">平台单号 {order.id}</p><time className="mt-2 block text-xs text-muted-foreground" dateTime={new Date(order.createdAt).toISOString()}>{dateText(order.createdAt)}</time></div><div className="flex items-center justify-between gap-4 sm:flex-col sm:items-end"><span className="text-xl font-semibold tabular-nums">¥ {centsText(order.amountCents)}</span>{order.source === "epay" && <Button variant="outline" size="sm" onClick={() => setNotificationOrder(order.id)}>回调记录</Button>}</div></article>)}</div><ConsolePagination page={filters.page} hasNext={value.hasNext} change={page => { setNotificationOrder(null); setFilters(current => ({ ...current, page })); }} /></>}</ConsoleQuery>
    {notificationOrder && <MerchantConsoleCallbacks key={notificationOrder} merchantId={merchantId} tradeNo={notificationOrder} close={() => setNotificationOrder(null)} />}
  </section>;
}
