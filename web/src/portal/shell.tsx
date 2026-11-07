import { useEffect, type ReactNode } from "react";
import { NavLink, Link, Outlet, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { Activity, ArrowLeftRight, Bell, ClipboardList, CreditCard, FileText, Globe, KeyRound, LayoutDashboard, ListChecks, RefreshCw, Settings2, ShieldCheck, Store, Users, WalletCards } from "lucide-react";
import { MerchantConsoleError } from "@/api/merchant-console";
import { ConsoleQuery } from "@/components/merchant-console-state";
import { Button } from "@/components/ui/button";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ThemeControl } from "@/theme";
import { adminMountPath } from "@/admin-base";
import { PortalContext, portalLabels, type PortalContextValue } from "./context";
import "./portal.css";
import { usePortalAccess } from "./use-portal-access";

export function portalMode(): "admin" | "merchant" { return document.querySelector('meta[name="perpay-portal"]')?.getAttribute("content") === "merchant" ? "merchant" : "admin"; }
const merchantLinks = [
  ["/", "账户概览", LayoutDashboard], ["/collect", "创建收款", CreditCard], ["/orders", "我的订单", ClipboardList], ["/notifications", "收款通知", Bell],
  ["/ledger", "余额账本", WalletCards], ["/refunds", "退款申请", ArrowLeftRight], ["/settlements", "提现结算", CreditCard], ["/invoices", "历史发票", FileText],
  ["/keys", "API 接入", KeyRound], ["/profile", "商户设置", Settings2], ["/fee", "我的费率", ShieldCheck],
] as const;
const adminLinks = [
  ["/", "总览", LayoutDashboard], ["/merchants", "商户管理", Store], ["/orders", "全部订单", ClipboardList], ["/tasks", "全局待处理", ListChecks],
  ["/ledger", "余额账本", WalletCards], ["/notifications", "全部通知", Bell], ["/refunds", "退款审批", ArrowLeftRight], ["/settlements", "提现审批", CreditCard],
] as const;

export function PortalShell() {
  const mode = portalMode(), [search] = useSearchParams(), navigate = useNavigate();
  const { merchantId } = useParams(), location = useLocation();
  const { directory, verifying, refresh } = usePortalAccess();
  const requested = merchantId ?? search.get("merchantId");
  return <SidebarProvider className="payment-portal"><a href="#portal-content" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:bg-background focus:p-3">跳到主要内容</a>
    {directory.error instanceof MerchantConsoleError && directory.error.status === 401 ? <PortalMessage title="登录 StarPAY"><p>使用你的 StarMC 账户登录后继续。</p><a className="underline" href={`/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`}>前往登录</a></PortalMessage> : verifying ? <PortalMessage><p role="status">正在核对账户权限…</p></PortalMessage> : <ConsoleQuery query={directory}>{directoryValue => {
      const isAdmin = directoryValue.merchants.some(merchant => merchant.role === "admin");
      if (mode === "admin" && !isAdmin) return <PortalMessage title="无管理员权限"><p>此页面仅供平台管理员使用。</p><a href={`${adminMountPath()}/merchant/`} className="underline">进入商户端</a></PortalMessage>;
      const selected = directoryValue.merchants.find(merchant => merchant.merchantId === requested) ?? (!requested ? directoryValue.merchants[0] : undefined);
      if (!selected) return <PortalMessage title="请选择可访问的商户"><p>当前商户不存在、已停用或尚未获得授权。</p><Button variant="outline" onClick={() => void navigate("/")}>返回可用商户</Button><a href="/profile" className="underline">个人中心</a></PortalMessage>;
      const context: PortalContextValue = { mode, merchants: directoryValue.merchants, selected, isAdmin, enabled: directoryValue.administrationEnabled, ...(directoryValue.collectionChannels ? { collectionChannels: directoryValue.collectionChannels } : {}) };
      return <PortalContext value={context}><PortalLayout context={context} route={location.pathname} refresh={refresh} /></PortalContext>;
    }}</ConsoleQuery>}
  </SidebarProvider>;
}

function PortalMessage({ title = "StarPAY 支付", children }: { title?: string; children: ReactNode }) {
  return <main className="mx-auto my-16 w-full max-w-lg space-y-5 rounded-xl border bg-card p-8"><h1 className="text-xl font-semibold">{title}</h1>{children}</main>;
}

function PortalLayout({ context, route, refresh }: { context: PortalContextValue; route: string; refresh: () => Promise<void> }) {
  const { mode, selected, merchants, isAdmin, enabled } = context, { setOpenMobile } = useSidebar(), navigate = useNavigate();
  const detail = mode === "admin" && route.startsWith("/merchants/"), section = detail ? route.split("/")[3] ?? "overview" : route.split("/")[1] || "overview";
  const title = mode === "merchant" ? merchantLinks.find(link => link[0] === route)?.[1] ?? "商户中心" : portalLabels[section] ?? "管理中心";
  const query = mode === "merchant" ? `?merchantId=${encodeURIComponent(selected.merchantId)}` : "";
  useEffect(() => { document.title = `${title} · ${mode === "admin" ? "管理中心" : selected.name} · StarPAY`; setOpenMobile(false); }, [title, mode, selected.name, route, setOpenMobile]);
  const links = mode === "admin" ? adminLinks : merchantLinks;
  function selectMerchant(value: string | null) { if (value) void navigate({ pathname: route, search: `?merchantId=${encodeURIComponent(value)}` }); }
  return <>
    <Sidebar variant="inset" collapsible="icon"><SidebarHeader><SidebarMenu><SidebarMenuItem><SidebarMenuButton size="lg" render={<Link to={`/${query}`} />}><WalletCards className="size-5!" /><span className="text-base font-semibold">StarPAY</span></SidebarMenuButton></SidebarMenuItem></SidebarMenu><p className="px-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">{mode === "admin" ? "平台管理" : "商户中心"} · {enabled ? "服务运行中" : "维护中"}</p></SidebarHeader>
      <SidebarContent><nav aria-label={mode === "admin" ? "管理员导航" : "商户导航"} className="p-2"><SidebarMenu>{links.map(([path, label, Icon]) => <SidebarMenuItem key={path}><SidebarMenuButton tooltip={label} isActive={path === "/" ? route === "/" : route.startsWith(path)} render={<NavLink to={`${path}${query}`} end={path === "/"} />}><Icon /><span>{label}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></nav></SidebarContent>
      <SidebarFooter>{mode === "admin" && <SidebarMenu><SidebarMenuItem><SidebarMenuButton isActive={route === "/system"} render={<Link to="/system" />}><Activity /><span>运行状态</span></SidebarMenuButton></SidebarMenuItem></SidebarMenu>}<SidebarMenu>
        {isAdmin && <SidebarMenuItem><SidebarMenuButton render={<a href={`${adminMountPath()}/${mode === "admin" ? "merchant" : "admin"}/${mode === "admin" ? `?merchantId=${encodeURIComponent(selected.merchantId)}` : ""}`} />}><ArrowLeftRight /><span>{mode === "admin" ? "进入商户端" : "进入管理端"}</span></SidebarMenuButton></SidebarMenuItem>}
        <SidebarMenuItem><SidebarMenuButton size="lg" render={<a href="/profile" />}><Users /><span className="grid leading-5"><span>{mode === "admin" ? "平台管理员" : selected.name}</span><span className="text-xs text-muted-foreground">StarMC 账户</span></span></SidebarMenuButton></SidebarMenuItem>
      </SidebarMenu></SidebarFooter>
    </Sidebar>
    <SidebarInset className="min-w-0"><header className="flex min-h-14 flex-wrap items-center gap-2 border-b px-4 md:px-6"><SidebarTrigger /><span className="mx-2 h-4 border-l" /><Globe className="size-4 shrink-0" />
      {mode === "merchant" && merchants.length > 1 ? <Select value={selected.merchantId} onValueChange={selectMerchant}><SelectTrigger aria-label="当前商户" className="max-w-48 border-0 shadow-none"><SelectValue>{selected.name}</SelectValue></SelectTrigger><SelectContent>{merchants.map(merchant => <SelectItem key={merchant.merchantId} value={merchant.merchantId}>{merchant.name}</SelectItem>)}</SelectContent></Select> : <span className="max-w-40 truncate text-sm">{mode === "admin" ? "全部商户" : selected.name}</span>}
      <span className="text-muted-foreground">/</span><span className="min-w-0 truncate text-sm">{detail ? `${selected.name} · ${title}` : title}</span>
      <div className="ml-auto flex items-center gap-1"><Button variant="ghost" size="icon" aria-label="刷新权限与记录" onClick={refresh}><RefreshCw className="size-4" /></Button><ThemeControl /></div></header>
      <div id="portal-content" className="min-w-0 space-y-6 p-4 md:p-6"><h1 className="sr-only">{title}</h1>{!enabled && <p role="status" className="rounded-lg border p-4 text-sm">支付服务正在维护，仍可查看历史记录。</p>}
        {detail && <div className="space-y-4"><Link className="text-sm text-muted-foreground hover:text-foreground" to="/merchants">← 返回商户列表</Link><h2 className="text-xl font-semibold">{selected.name}</h2><nav aria-label="商户管理功能" className="flex flex-wrap gap-1 border-b pb-3">{["overview", "orders", "ledger", "adjustments", "fee", "refunds", "settlements", "invoices", "notifications", "members", "profile", "keys"].map(item => <Button key={item} size="sm" variant={section === item ? "secondary" : "ghost"} render={<Link to={`/merchants/${encodeURIComponent(selected.merchantId)}/${item}`} />}>{portalLabels[item]}</Button>)}</nav></div>}
        <Outlet key={`${mode}:${selected.merchantId}`} />
      </div>
    </SidebarInset>
  </>;
}
