import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MerchantConsoleError } from "@/api/merchant-console";
import { Button } from "./ui/button";

export function ConsoleQuery<T>({ query, children }: { query: UseQueryResult<T>; children: (value: T) => ReactNode }) {
  if (query.isError) return <div className="space-y-3 py-8" role="alert"><p>{query.error instanceof MerchantConsoleError ? query.error.message : "加载失败，请重试。"}</p>{query.error instanceof MerchantConsoleError && query.error.status === 401 ? <a className="underline underline-offset-4" href={`/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`}>重新登录</a> : <Button variant="outline" onClick={() => void query.refetch()}>重试</Button>}</div>;
  if (!query.data) return <p role="status" className="py-8 text-muted-foreground">正在读取…</p>;
  return children(query.data);
}

export function ConsolePagination({ page, hasNext, change }: { page: number; hasNext: boolean; change: (page: number) => void }) {
  return <nav aria-label="记录分页" className="mt-5 flex items-center justify-end gap-3"><span className="text-sm text-muted-foreground">第 {page} 页</span><Button variant="outline" disabled={page === 1} onClick={() => change(page - 1)}>上一页</Button><Button variant="outline" disabled={!hasNext} onClick={() => change(page + 1)}>下一页</Button></nav>;
}
