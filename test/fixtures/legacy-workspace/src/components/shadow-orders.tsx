"use client";

import { useEffect, useRef, useState } from "react";

type Order = { id: string; merchantOrderId: string; name: string; amount: string; status: string; createdAt: string };
type Page = { orders: Order[]; pageInfo: { page: number; totalPages: number; total: number; hasNext: boolean; hasPrevious: boolean }; scope: "epay_only"; invoiceAvailable: false };
const labels: Record<string, string> = { pending_payment: "待支付", paid: "已支付", refunded: "已退款", frozen: "已冻结", closed: "已关闭", unknown: "未知" };

export function ShadowOrders({ merchantId }: { merchantId: string }) {
  const [pageResult, setPage] = useState<{ merchantId: string; data: Page } | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setError] = useState<{ merchantId: string; message: string } | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), [merchantId]);
  const page = pageResult?.merchantId === merchantId ? pageResult.data : null;
  const error = failure?.merchantId === merchantId ? failure.message : "";

  async function load(number: number) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setPage(null);
    setError(null);
    setLoading(true);
    try {
      const query = new URLSearchParams({ merchantId, page: String(number), pageSize: "20" });
      const response = await fetch(`${process.env.NEXT_PUBLIC_BASE_PATH || "/pay"}/api/merchant/shadow-orders?${query}`, { cache: "no-store", credentials: "include", signal: controller.signal });
      if (!response.ok) throw new Error("orders unavailable");
      const body = await response.json() as { ok: boolean; data: Page };
      if (body.ok !== true || body.data.scope !== "epay_only" || body.data.invoiceAvailable !== false || !Array.isArray(body.data.orders) || body.data.pageInfo.page !== number) throw new Error("invalid orders response");
      if (!controller.signal.aborted) setPage({ merchantId, data: body.data });
    } catch {
      if (!controller.signal.aborted) setError({ merchantId, message: "候选订单暂时无法读取，请检查访问权限后重试。" });
    } finally {
      if (pending.current === controller) { pending.current = null; setLoading(false); }
    }
  }

  return <section className="border-b p-4" aria-label="候选订单">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-sm font-medium">候选订单</h3><p className="mt-1 text-xs text-muted-foreground">仅用于迁移核对，数据尚未对账。</p></div><button type="button" onClick={() => void load(1)} disabled={loading} className="h-9 border px-3 text-sm disabled:opacity-50">{loading ? "读取中" : "读取候选订单"}</button></div>
    {error ? <p role="alert" className="mt-3 text-sm text-destructive">{error}</p> : null}
    {page ? <><div className="mt-3 overflow-x-auto"><table className="w-full min-w-[560px] text-left text-sm"><thead><tr className="border-b"><th className="p-2">订单号</th><th className="p-2">商品</th><th className="p-2">金额</th><th className="p-2">状态</th><th className="p-2">创建时间</th></tr></thead><tbody>{page.orders.map((order) => <tr key={order.id} className="border-b"><td className="break-all p-2">{order.merchantOrderId}</td><td className="p-2">{order.name}</td><td className="p-2">¥{order.amount}</td><td className="p-2">{labels[order.status] || "未知"}</td><td className="p-2">{new Date(order.createdAt).toLocaleString("zh-CN")}</td></tr>)}</tbody></table></div>{page.orders.length === 0 ? <p className="py-4 text-sm text-muted-foreground">暂无候选订单。</p> : null}<div className="mt-3 flex items-center justify-between gap-3 text-sm"><span>第 {page.pageInfo.page} / {page.pageInfo.totalPages} 页，共 {page.pageInfo.total} 条</span><div className="flex gap-2"><button type="button" disabled={!page.pageInfo.hasPrevious || loading} onClick={() => void load(page.pageInfo.page - 1)} className="border px-3 py-1 disabled:opacity-50">上一页</button><button type="button" disabled={!page.pageInfo.hasNext || loading} onClick={() => void load(page.pageInfo.page + 1)} className="border px-3 py-1 disabled:opacity-50">下一页</button></div></div></> : null}
  </section>;
}
