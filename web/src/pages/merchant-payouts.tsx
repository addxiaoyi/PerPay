import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { merchantRequest, type ConsoleMerchant } from "@/api/merchant-console";
import { type Payout, type PayoutAccess, type PayoutAccount, payoutKinds } from "@/api/payouts";
import { ConsolePagination, ConsoleQuery } from "@/components/merchant-console-state";
import { PayoutAccounts } from "./payout-accounts";
import { PayoutRequests } from "./payout-requests";

export function MerchantPayouts({ merchantId, role }: { merchantId: string; role: ConsoleMerchant["role"] }) {
  const [accountPage, setAccountPage] = useState(1), [page, setPage] = useState(1);
  const access = useQuery({ queryKey: ["merchant-console", merchantId, "payout-access", role], queryFn: ({ signal }) => merchantRequest<PayoutAccess>("payouts/session", { merchantId }, signal), retry: false });
  const accounts = useQuery({ queryKey: ["merchant-console", merchantId, "payout-accounts", accountPage], queryFn: ({ signal }) => merchantRequest<{ accounts: PayoutAccount[]; hasNext: boolean }>("payouts/accounts", { merchantId, page: String(accountPage) }, signal), retry: false });
  const requests = useQuery({ queryKey: ["merchant-console", merchantId, "payout-requests", page], queryFn: ({ signal }) => merchantRequest<{ payouts: Payout[]; hasNext: boolean }>("payouts/requests", { merchantId, page: String(page) }, signal), retry: false, refetchInterval: 15000 });
  return <section className="space-y-7"><div><h2 className="text-xl font-semibold">收款账户与自动提现</h2><p className="mt-2 text-sm text-muted-foreground">绑定本人或本商户账户，经平台审核后用于提现。自动打款按通道开放，未开放时继续使用线下提现结算。</p></div>
    <ConsoleQuery query={access}>{session => <>
      <ul className="grid gap-3 sm:grid-cols-3" aria-label="自动打款通道">{session.channels.map(channel => <li key={channel.kind} className="rounded-lg border p-4"><h3 className="font-medium">{payoutKinds[channel.kind]}</h3><p className="mt-2 text-sm">{channel.enabled ? "可申请自动提现" : "暂未开放"}</p>{channel.reason && <p className="mt-1 text-xs text-muted-foreground">{channel.reason}</p>}</li>)}</ul>
      <ConsoleQuery query={accounts}>{value => <><PayoutAccounts key={`${merchantId}:${role}`} merchantId={merchantId} role={role} session={session} accounts={value.accounts} /><ConsolePagination page={accountPage} hasNext={value.hasNext} change={setAccountPage} /></>}</ConsoleQuery>
      <ConsoleQuery query={requests}>{value => <><PayoutRequests key={`${merchantId}:${role}`} merchantId={merchantId} role={role} session={session} accounts={accounts.data?.accounts ?? []} payouts={value.payouts} /><ConsolePagination page={page} hasNext={value.hasNext} change={setPage} /></>}</ConsoleQuery>
    </>}</ConsoleQuery>
  </section>;
}
