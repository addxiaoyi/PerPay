import { createRoutesFromElements, Navigate, Route, useSearchParams } from "react-router";
import { PortalShell, portalMode } from "./shell";
import { PortalOverviewPage } from "./overview";
import { PortalRecordsPage } from "./records";
import { PortalMerchantsPage, PortalOperationPage, PortalSystemPage } from "./pages";

function LegacyWorkspace() {
  const [query] = useSearchParams();
  const id = query.get("merchantId");
  return <Navigate replace to={id ? `/merchants/${encodeURIComponent(id)}/overview` : "/"} />;
}
export function portalRoutes() {
  const admin = portalMode() === "admin";
  return createRoutesFromElements(<Route element={<PortalShell />} errorElement={<PortalFailure />}>
    <Route index element={<PortalOverviewPage />} />
    <Route path="orders" element={<PortalRecordsPage kind="orders" />} />
    <Route path="notifications" element={<PortalRecordsPage kind="notifications" />} />
    <Route path="ledger" element={<PortalRecordsPage kind="ledger" />} />
    <Route path="tasks" element={<PortalOverviewPage tasksOnly />} />
    {admin ? <>
      <Route path="merchants" element={<PortalMerchantsPage />} />
      <Route path="system" element={<PortalSystemPage />} />
      <Route path="refunds" element={<PortalRecordsPage kind="refunds" />} />
      <Route path="settlements" element={<PortalRecordsPage kind="settlements" />} />
      { ["management", "enrollment"].map(section => <Route key={section} path={section} element={<PortalOperationPage section={section} />} />) }
      <Route path="merchant-workspace" element={<LegacyWorkspace />} />
      <Route path="merchants/:merchantId/overview" element={<PortalOverviewPage scoped />} />
      { ["orders", "notifications", "ledger"].map(kind => <Route key={kind} path={`merchants/:merchantId/${kind}`} element={<PortalRecordsPage kind={kind as "orders" | "notifications" | "ledger"} scoped />} />) }
      { ["adjustments", "fee", "refunds", "settlements", "payouts", "invoices", "keys", "profile", "members"].map(section => <Route key={section} path={`merchants/:merchantId/${section}`} element={<PortalOperationPage section={section} />} />) }
    </> : ["collect", "refunds", "settlements", "invoices", "fee", "payouts", "keys", "profile"].map(section => <Route key={section} path={section} element={<PortalOperationPage section={section} />} />)}
    <Route path="*" element={<div role="alert" className="rounded-xl border p-8">页面不存在，请使用侧栏进入所需功能。</div>} />
  </Route>);
}

function PortalFailure() {
  return <main className="mx-auto my-16 max-w-lg space-y-4 rounded-xl border p-8"><h1 className="text-xl font-semibold">页面暂时未能加载</h1><p>请刷新页面后重试；已保存的订单和账本记录仍然保留。</p><a className="underline" href={window.location.pathname + window.location.search}>重新加载</a><a className="ml-4 underline" href="/profile">返回个人中心</a></main>;
}
