import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { merchantRequest, dateText } from "@/api/merchant-console";
import { ConsoleQuery } from "@/components/merchant-console-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MerchantConsoleCreateOrder } from "@/pages/merchant-console-create-order";
import { MerchantConsoleInvoices } from "@/pages/merchant-console-records";
import { MerchantConsoleRefunds } from "@/pages/merchant-console-refunds";
import { MerchantConsoleSettlements } from "@/pages/merchant-console-settlements";
import { MerchantConsoleFee } from "@/pages/merchant-console-fee";
import { MerchantConsoleKeys } from "@/pages/merchant-console-keys";
import { MerchantConsoleProfile } from "@/pages/merchant-console-profile";
import { MerchantConsoleMembers } from "@/pages/merchant-console-members";
import { MerchantConsoleEnrollment } from "@/pages/merchant-console-enrollment";
import { MerchantConsoleManagement } from "@/pages/merchant-console-management";
import { MerchantConsoleBalanceForm } from "@/pages/merchant-console-balance-form";
import { MerchantConsoleAdjustments } from "@/pages/merchant-console-adjustments";
import { MerchantPayouts } from "@/pages/merchant-payouts";
import { MerchantSummary } from "./overview";
import { PortalRecordsPage } from "./records";
import { portalParams, usePortal, type PortalOverview } from "./context";

export function PortalMerchantsPage() {
  const portal = usePortal(), params = portalParams(portal);
  const overview = useQuery({ queryKey: ["merchant-console", params.merchantId, "portal-merchants"], queryFn: ({ signal }) => merchantRequest<PortalOverview>("portal/overview", params, signal), retry: false });
  return <div className="space-y-6"><div className="flex flex-wrap items-center justify-between gap-4"><div><h2 className="text-xl font-semibold">商户管理</h2><p className="mt-1 text-sm text-muted-foreground">管理商户、余额、费率与账户权限。</p></div><div className="flex gap-2"><Button variant="outline" render={<Link to="/management" />}>启停管理</Button><Button render={<Link to="/enrollment" />}>新增商户</Button></div></div><ConsoleQuery query={overview}>{value => <MerchantSummary overview={value} />}</ConsoleQuery></div>;
}
export function PortalOperationPage({ section }: { section: string }) {
  const { selected, mode, enabled, collectionChannels } = usePortal(), merchantId = selected.merchantId;
  const role = mode === "merchant" && selected.role === "admin" ? "owner" : selected.role;
  const admin = mode === "admin" && role === "admin";
  if (["members", "enrollment", "management", "adjustments"].includes(section) && !admin) return <p role="alert">此功能仅限平台管理员使用。</p>;
  return <Card><CardContent className="space-y-6">
    {section === "collect" && <MerchantConsoleCreateOrder merchantId={merchantId} enabled={enabled} availableChannels={collectionChannels} />}
    {section === "invoices" && <MerchantConsoleInvoices merchantId={merchantId} />}
    {section === "refunds" && <><MerchantConsoleRefunds merchantId={merchantId} administration={admin} requests={!admin} /><h3 className="font-medium">历史退款</h3><PortalRecordsPage kind="refunds" scoped onlySource="main_site" /></>}
    {section === "settlements" && <MerchantConsoleSettlements merchantId={merchantId} role={role} requests={!admin} />}
    {section === "fee" && <MerchantConsoleFee merchantId={merchantId} role={role} />}
    {section === "keys" && <MerchantConsoleKeys merchantId={merchantId} role={role} />}
    {section === "payouts" && <MerchantPayouts merchantId={merchantId} role={role} />}
    {section === "profile" && <MerchantConsoleProfile merchantId={merchantId} role={role} />}
    {section === "members" && <MerchantConsoleMembers merchantId={merchantId} />}
    {section === "enrollment" && <MerchantConsoleEnrollment merchantId={merchantId} role={role} />}
    {section === "management" && <MerchantConsoleManagement merchantId={merchantId} role={role} />}
    {section === "adjustments" && <><MerchantConsoleBalanceForm merchantId={merchantId} role={role} /><MerchantConsoleAdjustments merchantId={merchantId} role={role} /></>}
  </CardContent></Card>;
}

type Health = { observedAt: number; sourceSync: { ok: boolean; appliedAt: number | null }; payments: { confirmed: number; inconsistent: number; unconfirmedLedger: number; unconfirmedCallbacks: number }; refunds: { inconsistent: number }; settlements: { inconsistent: number }; channels: Array<{ provider: string; product: string; enabled: boolean }>; invoiceEnabled: boolean };
export function PortalSystemPage() {
  const portal = usePortal(), params = portalParams(portal);
  const health = useQuery({ queryKey: ["merchant-console", params.merchantId, "portal-system"], queryFn: ({ signal }) => merchantRequest<Health>("portal/system", params, signal), retry: false, refetchInterval: 30000 });
  return <ConsoleQuery query={health}>{value => <div className="space-y-6"><Card><CardHeader><CardTitle>运行状态</CardTitle></CardHeader><CardContent><dl className="grid gap-6 sm:grid-cols-2"><Status label="新订单入口" value={portal.enabled ? "已开放" : "维护中"} /><Status label="历史数据同步" value={value.sourceSync.ok && value.sourceSync.appliedAt && value.observedAt - value.sourceSync.appliedAt < 90000 ? "同步正常" : "等待核对"} /><Status label="支付与账本核对" value={value.payments.inconsistent + value.payments.unconfirmedLedger + value.payments.unconfirmedCallbacks === 0 ? "无差异" : "存在差异，请检查"} /><Status label="退款与结算核对" value={value.refunds.inconsistent + value.settlements.inconsistent === 0 ? "无差异" : "存在差异，请检查"} /><Status label="新开票申请" value={value.invoiceEnabled ? "已开放" : "已关闭，保留历史记录"} /><Status label="最近检查" value={dateText(value.observedAt)} /></dl></CardContent></Card><Card><CardHeader><CardTitle>支付通道</CardTitle></CardHeader><CardContent><ul className="divide-y">{value.channels.map((channel, index) => <li className="flex justify-between gap-4 py-4" key={`${channel.provider}:${index}`}><span>{channel.provider === "ALIPAY" ? "支付宝" : channel.provider === "WECHAT" ? "微信支付" : "支付通道"} · {({ NATIVE: "扫码收款", WAP: "手机网页", PAGE: "网页支付", PC: "电脑网页", JSAPI: "公众号支付", PRECREATE: "扫码收款" })[channel.product.toUpperCase()] ?? "已保存配置"}</span><span className="text-sm text-muted-foreground">{channel.enabled ? "已启用" : "未启用"}</span></li>)}</ul></CardContent></Card></div>}</ConsoleQuery>;
}
function Status({ label, value }: { label: string; value: string }) { return <div><dt className="text-sm text-muted-foreground">{label}</dt><dd className="mt-2 font-medium">{value}</dd></div>; }
