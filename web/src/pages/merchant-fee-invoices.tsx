import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { merchantRequest, centsText, dateText, MerchantConsoleError } from "@/api/merchant-console";
import { ConsoleQuery } from "@/components/merchant-console-state";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { InvoiceReconciliation } from "./invoice-reconciliation";
import { InvoiceSubscription } from "./invoice-subscription";

type Buyer = { buyerType: "ORGANIZATION" | "INDIVIDUAL"; title: string; taxId: string; email: string; autoInvoice: boolean; version: number };
type Session = { configured: boolean; enabled: boolean; canConfigure: boolean; canRequest: boolean; csrfToken: string | null; buyer: Buyer | null;
  seller: { sellerName: string; itemName: string; taxCode: string; taxRateBps: number } | null };
type Invoice = { id: string; applicationNo: string; tradeNo: string; amountCents: number; title: string; status: string; invoiceNo: string | null; createdAt: number; errorCode?: string | null };
type Readiness = { configured: boolean; issuanceEnabled: boolean; feeEnabled: boolean; automaticEnabled: boolean; policyValid: boolean;
  buyerReady: boolean; buyerAutoInvoice: boolean; selfInvoice: boolean; validUntil: number | null;
  provider: { code: string | null; checkedAt: number; nextAt: number } | null;
  pendingCount: number; pendingAmountCents: number; deferredCount: number; unverifiedCount: number; scanLimit: number; hasMore: boolean;
  preview: { tradeNo: string; amountCents: number; nextAt: number }[] };
const statuses: Record<string, string> = { UNKNOWN: "待核实原申请", PROCESSING: "开票处理中", ISSUED: "已开票", FAILED: "开票失败", REVERSED: "已红冲", REVERSING: "红冲处理中" };
const problems: Record<string, string> = {
  fapiao_service_expired: "fa-piao 企业服务已到期，等待续期后复检。",
  fapiao_sms_required: "开票员需要在 fa-piao 完成短信认证。",
  fapiao_face_required: "开票员需要在 fa-piao 完成扫脸认证。",
  fapiao_authorization_expired: "开票平台授权已失效，请管理员重新检查。",
  invoice_provider_unavailable: "暂时无法核实开票平台状态，系统会退避后再检查。",
  invoice_not_authorized: "开票员或企业授权尚未就绪。",
  invoice_profile_unavailable: "请先保存本商户的真实购方资料。",
  invoice_refund_conflict: "该支付正在退款或已退款，请先核对原发票。",
  invoice_order_unconfirmed: "原支付与账务凭证尚未一致确认，暂不申请。",
  invoice_buyer_conflict: "购方与销方为同一企业，不能申请该服务费发票。",
  invoice_fee_scope_required: "平台服务费应使用服务费申请入口。",
};
function failure(error: Error) { return error instanceof MerchantConsoleError ? problems[error.code] ?? error.message : "服务费开票未完成，请刷新记录核对。"; }

export function MerchantFeeInvoices({ merchantId, admin }: { merchantId: string; admin: boolean }) {
  const session = useQuery({ queryKey: ["merchant-console", merchantId, "fee-invoice-session"],
    queryFn: ({ signal }) => merchantRequest<Session>("fee-invoices/session", { merchantId }, signal), retry: false });
  const invoices = useQuery({ queryKey: ["merchant-console", merchantId, "fee-invoices"],
    queryFn: ({ signal }) => merchantRequest<{ invoices: Invoice[] }>("fee-invoices", { merchantId }, signal), retry: false,
    refetchInterval: session.data?.enabled ? 30_000 : false });
  return <section className="space-y-4 rounded-lg border p-5" aria-label="平台服务费发票">
    <div><h3 className="text-lg font-semibold">平台服务费发票</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">上海舵星向本商户开具实际收取的技术服务费发票，金额取自原支付的已确认扣费记录。</p></div>
    <ConsoleQuery query={session}>{access => <>
      {!access.enabled && <p role="status" className="text-sm">真实开票已关闭。可先维护本商户的购方资料，资料齐全并启用平台开票后才会处理。</p>}
      {access.seller && <p className="break-all text-sm">销方：{access.seller.sellerName}；项目：{access.seller.itemName}；税收编码：{access.seller.taxCode}；税率：{access.seller.taxRateBps / 100}%</p>}
      {access.canConfigure && <BuyerForm key={JSON.stringify(access.buyer)} merchantId={merchantId} buyer={access.buyer} />}
      {!access.canConfigure && access.buyer && <p className="break-all text-sm">购方：{access.buyer.title}；接收邮箱：{access.buyer.email}</p>}
      {access.canRequest && <FeeRequest merchantId={merchantId} />}
    </>}</ConsoleQuery>
    <InvoiceSubscription merchantId={merchantId} />
    <FeeReadiness merchantId={merchantId} admin={admin} />
    <ConsoleQuery query={invoices}>{reply => <>
      {!reply.invoices.length && <p className="text-sm text-muted-foreground">暂无平台服务费发票申请。</p>}
      <ul className="divide-y">{reply.invoices.map(invoice => <li key={invoice.id} className="space-y-2 py-4 text-sm">
        <p className="break-all">{invoice.title} · ¥ {centsText(invoice.amountCents)} · {statuses[invoice.status] ?? "待核实"}</p>
        <p className="break-all text-xs text-muted-foreground">原支付：{invoice.tradeNo}；{dateText(invoice.createdAt)}</p>
        {invoice.invoiceNo && <p className="break-all">发票号：{invoice.invoiceNo}</p>}
        {invoice.errorCode && problems[invoice.errorCode] && <p role="status">{problems[invoice.errorCode]}</p>}
        <FeeFiles merchantId={merchantId} invoice={invoice} enabled={session.data?.enabled === true} />
        {admin && ["UNKNOWN", "PROCESSING"].includes(invoice.status) && <InvoiceReconciliation merchantId={merchantId} invoiceId={invoice.id} applicationNo={invoice.applicationNo} />}
      </li>)}</ul>
    </>}</ConsoleQuery>
  </section>;
}

function FeeReadiness({ merchantId, admin }: { merchantId: string; admin: boolean }) {
  const client = useQueryClient();
  const readiness = useQuery({ queryKey: ["merchant-console", merchantId, "fee-invoice-readiness"],
    queryFn: ({ signal }) => merchantRequest<Readiness>("fee-invoices/readiness", { merchantId }, signal), retry: false });
  const check = useMutation({ retry: false, mutationFn: async () => {
    const session = await merchantRequest<Session>("fee-invoices/session", { merchantId });
    if (!admin || !session.canConfigure || !session.csrfToken) throw new MerchantConsoleError(403, "forbidden");
    return merchantRequest("fee-invoices/provider-status", { merchantId }, undefined, { token: session.csrfToken, body: {} });
  }, onSuccess: async () => { await client.invalidateQueries({ queryKey: ["merchant-console", merchantId, "fee-invoice-readiness"] }); } });
  function refreshReadiness() { void readiness.refetch(); }
  function checkProvider() { check.mutate(); }
  return <div className="space-y-3 border-t pt-4">
    <h4 className="font-medium">开票就绪检查</h4>
    <ConsoleQuery query={readiness}>{state => <div className="space-y-3 text-sm">
      <ul className="list-disc space-y-1 pl-5">
        {!state.configured && <li>平台开票项目尚未配置。</li>}
        {(!state.issuanceEnabled || !state.feeEnabled) && <li>真实开票开关保持关闭。</li>}
        {!state.automaticEnabled && <li>后台自动处理尚未启用。</li>}
        {state.configured && !state.policyValid && <li>税率政策配置已过期，需要重新核对。</li>}
        {!state.buyerReady && <li>本商户购方资料尚未维护。</li>}
        {state.buyerReady && !state.buyerAutoInvoice && <li>本商户尚未选择自动申请。</li>}
        {state.selfInvoice && <li>销购双方为同一企业，不能开具服务费发票。</li>}
        <li>{state.provider ? state.provider.code ? problems[state.provider.code] ?? "开票平台尚未就绪，请管理员复检。" : "最近一次开票平台授权检查已通过。" : "开票平台授权状态尚未检测。"}</li>
      </ul>
      {state.provider && <p className="text-xs text-muted-foreground">最近检测：{dateText(state.provider.checkedAt)}{state.provider.nextAt > Date.now() ? `；自动处理最早重试：${dateText(state.provider.nextAt)}` : ""}</p>}
      <p>最近 {state.scanLimit} 笔候选记录中有 {state.pendingCount} 笔待处理服务费，合计 ¥ {centsText(state.pendingAmountCents)}。</p>
      {state.deferredCount > 0 && <p>{state.deferredCount} 笔正在退避等待，资料修正后也可从原支付申请入口重新核对。</p>}
      {state.unverifiedCount > 0 && <p>{state.unverifiedCount} 笔凭证尚未一致确认，不会提交开票。</p>}
      {state.hasMore && <p className="text-xs text-muted-foreground">此预览展示最近记录；后台队列仍会继续检查其余符合条件的支付。</p>}
      {state.preview.length > 0 && <ul aria-label="待处理服务费预览" className="divide-y">{state.preview.map(row => <li key={row.tradeNo} className="flex flex-wrap justify-between gap-2 py-2"><span className="break-all">{row.tradeNo}</span><span>¥ {centsText(row.amountCents)}</span></li>)}</ul>}
    </div>}</ConsoleQuery>
    <div className="flex flex-wrap gap-3"><Button className="min-h-11" variant="outline" onClick={refreshReadiness} disabled={readiness.isFetching}>刷新待处理费用</Button>
      {admin && <Button className="min-h-11" variant="outline" onClick={checkProvider} disabled={check.isPending}>{check.isPending ? "正在检测授权…" : "检测开票平台授权"}</Button>}</div>
    <p className="text-xs leading-5 text-muted-foreground">授权检测只读取平台状态，不会启用开票，也不会申请发票。</p>
    {check.isError && <p role="alert" className="text-sm text-destructive">{failure(check.error)}</p>}
  </div>;
}

function BuyerForm({ merchantId, buyer }: { merchantId: string; buyer: Buyer | null }) {
  const [buyerType, setBuyerType] = useState<Buyer["buyerType"]>(buyer?.buyerType ?? "ORGANIZATION");
  const [title, setTitle] = useState(buyer?.title ?? ""), [taxId, setTaxId] = useState(buyer?.taxId ?? ""), [email, setEmail] = useState(buyer?.email ?? "");
  const [autoInvoice, setAutoInvoice] = useState(buyer?.autoInvoice ?? false), [validation, setValidation] = useState("");
  const client = useQueryClient();
  const save = useMutation({ retry: false, mutationFn: async () => {
    const access = await merchantRequest<Session>("fee-invoices/session", { merchantId });
    if (!access.canConfigure || !access.csrfToken) throw new MerchantConsoleError(403, "forbidden");
    return merchantRequest("fee-invoices/buyer", { merchantId }, undefined, { token: access.csrfToken,
      body: { buyerType, title: title.trim(), taxId: buyerType === "ORGANIZATION" ? taxId.trim() : "", email: email.trim(), autoInvoice, expectedVersion: buyer?.version ?? 0 } });
  }, onSuccess: async () => { await client.invalidateQueries({ queryKey: ["merchant-console", merchantId, "fee-invoice-session"] }); } });
  function saveBuyer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim() || (buyerType === "ORGANIZATION" && !/^[A-Z0-9]{15,20}$/.test(taxId.trim())) || new TextEncoder().encode(email.trim()).length > 214) {
      setValidation("请填写本商户的真实发票抬头、税号和接收邮箱。"); return;
    }
    setValidation(""); save.mutate();
  }
  return <form onSubmit={saveBuyer} className="space-y-4">
    <RadioGroup<Buyer["buyerType"]> value={buyerType} onValueChange={setBuyerType} disabled={save.isPending} aria-label="服务费购方类型" className="flex flex-wrap gap-4 text-sm">
      {(["ORGANIZATION", "INDIVIDUAL"] as const).map(type => <label key={type} className="flex min-h-11 cursor-pointer items-center gap-2"><Radio.Root value={type} className="flex size-4 items-center justify-center rounded-full border border-input focus-visible:ring-2 focus-visible:ring-ring"><Radio.Indicator className="size-2 rounded-full bg-primary" /></Radio.Root>{type === "ORGANIZATION" ? "企业或组织" : "个人"}</label>)}
    </RadioGroup>
    <fieldset disabled={save.isPending} className="grid gap-4 sm:grid-cols-2">
      <label className="space-y-1 text-sm">服务费发票抬头<Input aria-label="服务费发票抬头" value={title} onChange={event => setTitle(event.target.value)} maxLength={160} required /></label>
      {buyerType === "ORGANIZATION" && <label className="space-y-1 text-sm">服务费购方税号<Input aria-label="服务费购方税号" value={taxId} onChange={event => setTaxId(event.target.value.toUpperCase())} maxLength={20} required /></label>}
      <label className="space-y-1 text-sm">服务费接收邮箱<Input aria-label="服务费接收邮箱" type="email" value={email} onChange={event => setEmail(event.target.value)} maxLength={214} required /></label>
    </fieldset>
    <label className="flex items-start gap-2 text-sm"><Checkbox checked={autoInvoice} onCheckedChange={setAutoInvoice} disabled={save.isPending} />启用后，自动为已确认支付中实际扣除的服务费申请发票。</label>
    <Button className="min-h-11" type="submit" disabled={save.isPending}>{save.isPending ? "正在保存购方资料…" : "保存服务费购方资料"}</Button>
    {(validation || save.isError) && <p role="alert" className="text-sm text-destructive">{validation || failure(save.error!)}</p>}
    {save.isSuccess && <p role="status" className="text-sm">购方资料已保存。</p>}
  </form>;
}
function FeeRequest({ merchantId }: { merchantId: string }) {
  const [tradeNo, setTradeNo] = useState(""); const client = useQueryClient();
  const submit = useMutation({ retry: false, mutationFn: async () => {
    const session = await merchantRequest<Session>("fee-invoices/session", { merchantId });
    if (!session.canRequest || !session.csrfToken) throw new MerchantConsoleError(403, "forbidden");
    return merchantRequest("fee-invoices/applications", { merchantId }, undefined, { token: session.csrfToken, body: { tradeNo: tradeNo.trim() } });
  }, onSettled: async () => { await client.invalidateQueries({ queryKey: ["merchant-console", merchantId, "fee-invoices"] }); } });
  function requestFeeInvoice(event: FormEvent<HTMLFormElement>) { event.preventDefault(); submit.mutate(); }
  return <form onSubmit={requestFeeInvoice} className="space-y-3"><label className="block space-y-1 text-sm">服务费对应的原支付订单号<Input aria-label="服务费对应的原支付订单号" value={tradeNo} onChange={event => setTradeNo(event.target.value)} maxLength={64} required disabled={submit.isPending} /></label>
    <Button type="submit" variant="outline" disabled={submit.isPending}>{submit.isPending ? "正在核实原支付…" : "申请该订单的服务费发票"}</Button>
    {submit.isError && <p role="alert" className="text-sm text-destructive">{failure(submit.error)}</p>}
    {submit.isSuccess && <p role="status" className="text-sm">申请已记录，请在列表中核对实际开票状态。</p>}</form>;
}
function FeeFiles({ merchantId, invoice, enabled }: { merchantId: string; invoice: Invoice; enabled: boolean }) {
  const file = useMutation({ retry: false, mutationFn: async () => {
    const session = await merchantRequest<Session>("fee-invoices/session", { merchantId });
    if (!session.enabled || !session.csrfToken) throw new MerchantConsoleError(403, "forbidden");
    const reply = await merchantRequest<{ url: string }>(`tax-invoices/${encodeURIComponent(invoice.id)}/files`, { merchantId }, undefined, { token: session.csrfToken, body: {} });
    const url = new URL(reply.url); if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("invalid fee invoice file URL");
    return url.href;
  } });
  function readInvoiceFile() { file.mutate(); }
  if (invoice.status !== "ISSUED" || !enabled) return null;
  return <div className="space-y-2"><Button variant="outline" onClick={readInvoiceFile} disabled={file.isPending}>{file.isPending ? "正在获取发票…" : "获取服务费发票文件"}</Button>
    {file.data && <a href={file.data} className="ml-3 underline" target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">下载服务费发票</a>}
    {file.isError && <p role="alert" className="text-sm text-destructive">{failure(file.error)}</p>}</div>;
}
