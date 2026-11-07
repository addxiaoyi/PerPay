import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { merchantRequest, centsText, type ConsoleMerchant, type ConsoleBalance } from "@/api/merchant-console";
import { ConsoleQuery } from "@/components/merchant-console-state";
import { MerchantConsoleOrders } from "./merchant-console-orders";
import { MerchantConsoleLedger, MerchantConsoleInvoices } from "./merchant-console-records";
import { MerchantConsoleFee } from "./merchant-console-fee";
import { MerchantConsoleAdjustments } from "./merchant-console-adjustments";
import { MerchantConsoleBalanceForm } from "./merchant-console-balance-form";
import { MerchantConsoleKeys } from "./merchant-console-keys";
import { MerchantConsoleMembers } from "./merchant-console-members";
import { MerchantConsoleRefunds } from "./merchant-console-refunds";
import { MerchantConsoleCreateOrder } from "./merchant-console-create-order";
import { MerchantConsoleSettlements } from "./merchant-console-settlements";
import { MerchantConsoleEnrollment } from "./merchant-console-enrollment";
import { MerchantConsoleProfile } from "./merchant-console-profile";
import { MerchantConsoleManagement } from "./merchant-console-management";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function MerchantConsole() {
  const [selectedId, setSelectedId] = useState(() => new URLSearchParams(window.location.search).get("merchantId") ?? "");
  const [refreshing, setRefreshing] = useState(false);
  const queryClient = useQueryClient();
  const directory = useQuery({ queryKey: ["merchant-console", "directory"], queryFn: ({ signal }) => merchantRequest<{ merchants: ConsoleMerchant[]; administrationEnabled: boolean }>("access", {}, signal), retry: false });
  function selectMerchant(id: string) {
    setSelectedId(id);
    const url = new URL(window.location.href); url.searchParams.set("merchantId", id); window.history.replaceState(window.history.state, "", url);
  }
  async function refreshPermissions() {
    setRefreshing(true);
    try {
      await queryClient.cancelQueries({ queryKey: ["merchant-console"] });
      // A new permission response must not reuse a previous administrator's records.
      queryClient.removeQueries({ queryKey: ["merchant-console"], predicate: query => query.queryKey[1] !== "directory" });
      await directory.refetch();
    } finally { setRefreshing(false); }
  }
  return <div className="min-h-svh bg-background text-foreground"><a href="#merchant-content" className="sr-only focus:not-sr-only focus:block focus:p-4">跳到商户记录</a><header className="border-b"><div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-5 sm:px-8"><a href="/" className="font-semibold tracking-tight">StarMC <span className="ml-2 font-normal text-muted-foreground">支付</span></a><a href="/profile" className="text-sm underline-offset-4 hover:underline">个人中心</a></div></header><main id="merchant-content" className="mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-12"><div className="mb-8 flex flex-wrap items-end justify-between gap-4"><div><p className="mb-2 text-sm text-muted-foreground">StarPAY 商户服务</p><h1 className="text-3xl font-semibold tracking-tight">商户工作台</h1></div><Button variant="outline" disabled={refreshing} onClick={refreshPermissions}>刷新权限</Button></div>{refreshing ? <p role="status">正在核对权限…</p> : <ConsoleQuery query={directory}>{access => {
    const selected = access.merchants.find(item => item.merchantId === selectedId) ?? (!selectedId ? access.merchants[0] : undefined);
    if (!access.merchants.length) return <p className="py-10 text-muted-foreground">当前账户尚未绑定商户，请联系管理员。</p>;
    return <><div className="mb-7 flex flex-wrap items-center justify-between gap-4"><div className="min-w-0 space-y-2"><label htmlFor="console-merchant" className="block text-sm text-muted-foreground">当前商户</label><Select value={selected?.merchantId ?? ""} onValueChange={value => { if (value) selectMerchant(value); }}><SelectTrigger id="console-merchant" className="h-11 w-full max-w-md"><SelectValue placeholder="请选择有权限的商户">{selected?.name}</SelectValue></SelectTrigger><SelectContent><SelectGroup>{access.merchants.map(merchant => <SelectItem key={merchant.merchantId} value={merchant.merchantId}>{merchant.name}</SelectItem>)}</SelectGroup></SelectContent></Select></div>{selected && <p className="text-sm text-muted-foreground">{selected.role === "admin" ? "管理员" : selected.role === "owner" ? "商户所有者" : "商户成员"}</p>}</div>{!access.administrationEnabled && <p role="status" className="mb-8 border-l-2 border-foreground py-1 pl-4 text-sm leading-6">支付服务升级中。这里展示已迁移的历史记录，新收款、余额调整和开票申请暂未开放。</p>}{selected ? <MerchantDetails key={selected.merchantId} merchant={selected} enabled={access.administrationEnabled} /> : <p role="alert">当前账户没有所选商户的访问权限，请重新选择。</p>}</>;
  }}</ConsoleQuery>}</main></div>;
}

function MerchantDetails({ merchant, enabled }: { merchant: ConsoleMerchant; enabled: boolean }) {
  const [section, setSection] = useState("orders");
  const balance = useQuery({ queryKey: ["merchant-console", merchant.merchantId, "balance"], queryFn: ({ signal }) => merchantRequest<ConsoleBalance>("balance", { merchantId: merchant.merchantId }, signal), retry: false });
  const sections = [{ id: "collect", label: "创建收款" }, { id: "orders", label: "订单" }, { id: "ledger", label: "余额账本" }, { id: "invoices", label: "发票" }, { id: "refunds", label: "退款" }, { id: "settlements", label: "提现结算" }, { id: "fee", label: "费率与记录" }, { id: "keys", label: "API 接入" }, { id: "profile", label: "商户资料" }, ...(merchant.role === "admin" ? [{ id: "members", label: "成员权限" }, { id: "enrollment", label: "新增商户" }, { id: "management", label: "商户状态" }] : [])];
  return <><section aria-label="余额概览" className="mb-8 border-y py-6"><ConsoleQuery query={balance}>{value => <><div className="grid grid-cols-1 gap-6 sm:grid-cols-3"><div><p className="text-sm text-muted-foreground">综合余额</p><p className="mt-2 break-all text-3xl font-semibold tabular-nums">¥ {centsText(value.availableCents)}</p></div><div><p className="text-sm text-muted-foreground">冻结余额</p><p className="mt-2 text-2xl font-medium tabular-nums">¥ {centsText(value.frozenCents)}</p></div><div><p className="text-sm text-muted-foreground">当前费率</p><p className="mt-2 text-2xl font-medium tabular-nums">{(merchant.feeBps / 100).toFixed(2)}%</p></div></div>{!value.migrationBaselineVerified && <p className="mt-5 text-xs text-muted-foreground">综合余额包含主站账本、旧网关收款及开票扣费；最终对账完成前不可用于提现。</p>}</>}</ConsoleQuery></section><nav aria-label="商户功能" className="mb-7 flex flex-wrap gap-2 border-b pb-4">{sections.map(item => <Button key={item.id} variant={section === item.id ? "default" : "ghost"} aria-pressed={section === item.id} onClick={() => setSection(item.id)}>{item.label}</Button>)}</nav>{section === "profile" && <MerchantConsoleProfile key={merchant.role} merchantId={merchant.merchantId} role={merchant.role} />}{section === "collect" && <MerchantConsoleCreateOrder merchantId={merchant.merchantId} enabled={enabled} />}{section === "orders" && <MerchantConsoleOrders merchantId={merchant.merchantId} />}{section === "ledger" && <><MerchantConsoleLedger merchantId={merchant.merchantId} /><MerchantConsoleBalanceForm key={`balance:${merchant.role}`} merchantId={merchant.merchantId} role={merchant.role} /><MerchantConsoleAdjustments key={`history:${merchant.role}`} merchantId={merchant.merchantId} role={merchant.role} /></>}{section === "invoices" && <MerchantConsoleInvoices merchantId={merchant.merchantId} />}{section === "refunds" && <MerchantConsoleRefunds merchantId={merchant.merchantId} />}{section === "settlements" && <MerchantConsoleSettlements key={merchant.role} merchantId={merchant.merchantId} role={merchant.role} />}{section === "fee" && <MerchantConsoleFee merchantId={merchant.merchantId} role={merchant.role} />}{section === "keys" && <MerchantConsoleKeys key={merchant.role} merchantId={merchant.merchantId} role={merchant.role} />}{section === "members" && merchant.role === "admin" && <MerchantConsoleMembers key={merchant.role} merchantId={merchant.merchantId} />}{section === "enrollment" && merchant.role === "admin" && <MerchantConsoleEnrollment key={merchant.role} merchantId={merchant.merchantId} role={merchant.role} />}{section === "management" && merchant.role === "admin" && <MerchantConsoleManagement key={merchant.role} merchantId={merchant.merchantId} role={merchant.role} />}</>;
}
