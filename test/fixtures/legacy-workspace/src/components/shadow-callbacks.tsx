"use client";

import { useState } from "react";

type Attempt = { id: string; number: number; method: string; outcome: string; httpStatus: number | null; startedAt: number; failureReason: string | null };
type Order = { id: string; source?: "epay" | "main" };
type Selection = { merchantId: string; orderId: string };
type CallbackResult = Selection & { attempts: Attempt[]; hasNext: boolean };
type CallbackError = Selection & { message: string };

const outcomes: Record<string, string> = { STARTED: "投递中", SUCCESS: "已送达", RETRY: "等待重试", FAILED: "投递失败", EXPIRED: "投递中断" };

export function ShadowCallbacks({ merchantId, orders }: { merchantId: string; orders: Order[] }) {
  const epayOrders = orders.filter((order) => order.source === "epay" && order.id.startsWith("epay_"));
  const [selected, setSelected] = useState<Selection | null>(null);
  const [result, setResult] = useState<CallbackResult | null>(null);
  const [failure, setFailure] = useState<CallbackError | null>(null);
  const [loading, setLoading] = useState(false);
  const current = selected?.merchantId === merchantId && epayOrders.some((order) => order.id === selected.orderId) ? selected.orderId : "";
  const attempts = result?.merchantId === merchantId && result.orderId === current ? result.attempts : null;
  const hasNext = result?.merchantId === merchantId && result.orderId === current && result.hasNext;
  const error = failure?.merchantId === merchantId && failure.orderId === current ? failure.message : "";

  async function load() {
    if (!current || loading) return;
    setLoading(true);
    setFailure(null);
    setResult(null);
    try {
      const query = new URLSearchParams({ merchantId, tradeNo: current.slice(5) });
      const response = await fetch(`${process.env.NEXT_PUBLIC_BASE_PATH || "/pay"}/api/merchant/shadow-callbacks?${query}`, { cache: "no-store", credentials: "include" });
      if (!response.ok) throw new Error("查询失败，请稍后重试。");
      const body = await response.json() as { data: { attempts: Attempt[]; hasNext: boolean } };
      setResult({ merchantId, orderId: current, attempts: body.data.attempts, hasNext: body.data.hasNext });
    } catch { setFailure({ merchantId, orderId: current, message: "候选记录暂时无法查询。" }); }
    finally { setLoading(false); }
  }

  return <section className="border-b p-4" aria-label="候选系统回调记录">
    <h3 className="text-sm font-medium">候选系统回调记录</h3>
    <p className="mt-1 text-xs text-muted-foreground">仅供迁移核对，不代表当前生产投递状态。</p>
    <div className="mt-3 flex flex-wrap items-end gap-2">
      <label className="min-w-0 flex-1 text-xs sm:max-w-sm">订单<select value={current} onChange={(event) => { setSelected({ merchantId, orderId: event.target.value }); setResult(null); setFailure(null); }} disabled={loading} className="mt-1 block h-9 w-full min-w-0 max-w-full border bg-background px-2 text-sm"><option value="">选择本页订单</option>{epayOrders.map((order) => <option key={order.id} value={order.id}>{order.id.slice(5)}</option>)}</select></label>
      <button type="button" disabled={!current || loading} onClick={load} className="h-9 border px-3 text-sm disabled:opacity-50">{loading ? "查询中" : "查询"}</button>
    </div>
    {error ? <p role="alert" className="mt-3 text-sm text-destructive">{error}</p> : null}
    {attempts ? attempts.length ? <ul className="mt-3 divide-y">{attempts.map((attempt) => <li key={attempt.id} className="py-2 text-sm"><span>第 {attempt.number} 次 · {outcomes[attempt.outcome] || "状态未知"}</span><span className="ml-2 text-xs text-muted-foreground">{attempt.method} · {new Date(attempt.startedAt).toLocaleString("zh-CN")}{attempt.httpStatus ? ` · HTTP ${attempt.httpStatus}` : ""}</span>{attempt.failureReason ? <p className="mt-1 text-xs text-muted-foreground">{attempt.failureReason}</p> : null}</li>)}</ul> : <p className="mt-3 text-sm text-muted-foreground">暂无候选回调记录。</p> : null}
    {attempts && hasNext ? <p className="mt-2 text-xs text-muted-foreground">仅显示最近 20 次记录。</p> : null}
  </section>;
}
