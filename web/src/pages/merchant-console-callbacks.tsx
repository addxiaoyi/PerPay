import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { dateText, merchantRequest, paymentLabel } from "@/api/merchant-console";
import { ConsolePagination, ConsoleQuery } from "@/components/merchant-console-state";
import { Button } from "@/components/ui/button";

type CallbackQueue = {
  job: { status: string; attempts: number; updatedAt: number } | null;
  attempts: Array<{ id: string; number: number; method: string; outcome: string; httpStatus: number | null; startedAt: number; finishedAt: number | null; failureReason: string | null }>;
  hasNext: boolean;
};

function deliveryLabel(status: string) {
  const labels: Record<string, string> = { PENDING: "等待投递", LEASED: "正在投递", SUCCEEDED: "已确认送达", FAILED: "投递失败", STARTED: "投递中", SUCCESS: "已确认送达", RETRY: "等待重试", EXPIRED: "本次投递超时" };
  return labels[status] ?? "状态待核实";
}

export function MerchantConsoleCallbacks({ merchantId, tradeNo, close }: { merchantId: string; tradeNo: string; close: () => void }) {
  const [retryId, setRetryId] = useState(() => crypto.randomUUID());
  const client = useQueryClient();
  const [historyPage, setHistoryPage] = useState(1);
  const [queuePage, setQueuePage] = useState(1);
  const history = useQuery({ queryKey: ["merchant-console", merchantId, "notifications", tradeNo, historyPage], queryFn: ({ signal }) => merchantRequest<{ notifications: Array<{ id: number; status: string; createdAt: number }>; hasNext: boolean }>("notifications", { merchantId, tradeNo, page: String(historyPage) }, signal), retry: false });
  const queue = useQuery({ queryKey: ["merchant-console", merchantId, "callback-attempts", tradeNo, queuePage], queryFn: ({ signal }) => merchantRequest<CallbackQueue>("callback-attempts", { merchantId, tradeNo, page: String(queuePage) }, signal), retry: false });
  function refreshDelivery() { void queue.refetch(); void history.refetch(); }
  const retry = useMutation({ retry: false, mutationFn: async () => {
    const session = await merchantRequest<{ enabled: boolean; csrfToken: string }>("callbacks/session", { merchantId });
    if (!session.enabled) throw new Error("升级期间暂不重试通知。");
    return merchantRequest<{ queued: boolean }>("callbacks/retry", { merchantId }, undefined, { token: session.csrfToken, body: { tradeNo, requestId: retryId } });
  }, onSuccess: async () => { setRetryId(crypto.randomUUID()); await client.invalidateQueries({ queryKey: ["merchant-console", merchantId, "callback-attempts", tradeNo] }); } });
  return <section className="space-y-5 border-t pt-5" aria-label="订单回调记录">
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-semibold">回调记录</h3><div className="flex gap-2"><Button size="sm" variant="outline" onClick={refreshDelivery} disabled={queue.isFetching || history.isFetching}>刷新记录</Button><Button size="sm" variant="ghost" onClick={close}>收起</Button></div></div>
    <p className="break-all text-sm text-muted-foreground">{tradeNo}</p>
    <section aria-label="新系统回调投递" className="space-y-3"><h4 className="font-medium">新系统投递</h4>
      <ConsoleQuery query={queue}>{value => <>
        {value.job ? <><div className="flex flex-wrap justify-between gap-2 text-sm"><p>{deliveryLabel(value.job.status)} · 已尝试 {value.job.attempts} 次</p><time className="text-muted-foreground">{dateText(value.job.updatedAt)}</time></div>
          {value.job.status === "FAILED" && <Button size="sm" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate()}>{retry.isPending ? "正在排队…" : "重新投递通知"}</Button>}
          {retry.isSuccess && <p role="status" className="text-sm text-muted-foreground">重试请求已保存，送达结果以商户确认回执为准。</p>}
          {retry.isError && <p role="alert" className="text-sm text-destructive">{retry.error.message}</p>}
          <ul className="divide-y">{value.attempts.map(attempt => <li key={attempt.id} className="space-y-1 py-3 text-sm">
            <div className="flex flex-wrap justify-between gap-2"><p>第 {attempt.number} 次 · {deliveryLabel(attempt.outcome)}</p><time className="text-muted-foreground">{dateText(attempt.startedAt)}</time></div>
            {attempt.failureReason && <p className="break-words text-muted-foreground">{attempt.failureReason}</p>}
            {attempt.httpStatus !== null && <p className="text-xs text-muted-foreground">商户接口响应码 {attempt.httpStatus}；送达状态以回执校验为准。</p>}
          </li>)}</ul><ConsolePagination page={queuePage} hasNext={value.hasNext} change={setQueuePage} />
        </> : <p className="text-sm text-muted-foreground">本订单没有新系统投递任务。旧系统的投递结果请查看下方历史记录。</p>}
      </>}</ConsoleQuery>
    </section>
    <section aria-label="旧系统回调记录" className="space-y-3 border-t pt-5"><h4 className="font-medium">历史回调</h4><ConsoleQuery query={history}>{value => <>
      {value.notifications.length ? <ul className="divide-y">{value.notifications.map(entry => <li key={entry.id} className="flex flex-wrap justify-between gap-2 py-3 text-sm"><span>{paymentLabel(entry.status)}</span><time>{dateText(entry.createdAt)}</time></li>)}</ul> : <p className="text-sm text-muted-foreground">暂无历史回调记录。</p>}
      <ConsolePagination page={historyPage} hasNext={value.hasNext} change={setHistoryPage} />
    </>}</ConsoleQuery></section>
  </section>;
}
