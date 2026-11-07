import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { centsText, dateText, merchantRequest, type ConsoleSession, type LedgerEntry } from "@/api/merchant-console";
import { ConsolePagination, ConsoleQuery } from "@/components/merchant-console-state";

type Adjustment = LedgerEntry & { actorId: string | null; reason: string | null };

export function MerchantConsoleAdjustments({ merchantId, role }: { merchantId: string; role: ConsoleSession["role"] }) {
  const [page, setPage] = useState(1);
  const history = useQuery({
    queryKey: ["merchant-console", merchantId, "ledger-adjustments", role, page],
    queryFn: ({ signal }) => merchantRequest<{ adjustments: Adjustment[]; hasNext: boolean }>("ledger-adjustments", { merchantId, page: String(page) }, signal),
    enabled: role === "admin", retry: false,
  });
  if (role !== "admin") return null;
  return <section className="mt-8 space-y-4 border-t pt-6" aria-label="管理员余额调整记录">
    <div><h2 className="text-xl font-semibold">余额调整记录</h2><p className="mt-2 text-sm text-muted-foreground">保留操作人、原因与金额，供管理员核查。</p></div>
    <ConsoleQuery query={history}>{value => <>
      {value.adjustments.length ? <ul className="divide-y">{value.adjustments.map(entry => <li key={entry.id} className="space-y-2 py-4">
        <div className="flex flex-wrap justify-between gap-2"><p className="font-semibold tabular-nums">{entry.availableDeltaCents > 0 ? "+" : ""}{centsText(entry.availableDeltaCents)} 元</p><time className="text-sm text-muted-foreground">{dateText(entry.occurredAt)}</time></div>
        <p className="break-words text-sm whitespace-pre-wrap">{entry.reason || "历史记录未填写原因"}</p>
        <p className="break-all text-xs text-muted-foreground">操作人：{entry.actorId || "历史记录未保留操作人"}</p>
        {entry.frozenDeltaCents !== 0 && <p className="text-xs text-muted-foreground">冻结变动 {centsText(entry.frozenDeltaCents)} 元</p>}
      </li>)}</ul> : <p className="py-5 text-sm text-muted-foreground">暂无余额调整记录。</p>}
      <ConsolePagination page={page} hasNext={value.hasNext} change={setPage} />
    </>}</ConsoleQuery>
  </section>;
}
