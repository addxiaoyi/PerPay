import { useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { merchantRequest, centsText, dateText, MerchantConsoleError, type ConsoleMerchant } from "@/api/merchant-console";
import { ConsolePagination, ConsoleQuery } from "@/components/merchant-console-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Radio } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { InvoiceReconciliation } from "./invoice-reconciliation";
import { MerchantFeeInvoices } from "./merchant-fee-invoices";

type InvoiceProfile = {
  provider?: "wechat" | "fa-piao";
  subMchId: string; sellerName: string; sellerTaxId: string;
  itemName: string; taxCode: string; taxRateBps: number; enabled: boolean; billingPersonId: string;
  authorized: boolean; authorizationCheckedAt: number; version: number;
};
export type TaxInvoiceSession = {
  platformFeesConfigured?: boolean;
  providerKind?: "wechat" | "fa-piao";
  enabled: boolean; providerConfigured: boolean; canConfigure: boolean; canRequest: boolean;
  canReconcile?: boolean;
  csrfToken: string | null; profile: InvoiceProfile | null;
};
type TaxInvoice = {
  id: string; tradeNo: string; title: string; amountCents: number;
  applicationNo?: string;
  status: string; attempt: number; createdAt: number; invoiceNo?: string | null;
  errorCode?: string | null;
};
type InvoiceCommand = { requestId: string; tradeNo: string; buyerType: "INDIVIDUAL" | "ORGANIZATION"; title: string; taxId: string; email: string };

const statuses: Record<string, string> = {
  PENDING: "等待提交", PROCESSING: "开票处理中", UNKNOWN: "正在核实开票结果",
  ISSUED: "已开票", FAILED: "开票失败", REVERSING: "红冲处理中", REVERSED: "已红冲",
};
const providerProblems: Record<string, string> = {
  fapiao_sms_required: "开票员需要完成短信验证码验证。请在 fa-piao 平台处理后刷新原申请。",
  fapiao_face_required: "开票员需要完成扫脸认证。请在 fa-piao 平台处理后刷新原申请。",
  fapiao_authorization_expired: "开票平台授权已过期，请检查服务和开票员登录状态。",
  fapiao_reconcile_required: "本次开票结果需要人工核对，请在 fa-piao 平台查找原申请，暂时不要重新开票。",
};
const taxRatesBps = [0, 100, 150, 300, 500, 600, 900, 1000, 1100, 1300, 1600, 1700];
const MAX_INVOICE_ATTEMPTS = 5;
const MAX_EMAIL_BYTES = 214;
const INVOICE_POLL_INTERVAL_MS = 5_000;
const PENDING_INVOICE_STATUSES = new Set(["PENDING", "PROCESSING", "UNKNOWN", "REVERSING"]);
const errors: Record<string, string> = {
  invoice_not_configured: "平台开票服务尚未配置，请联系管理员。",
  invoice_not_authorized: "商户尚未完成开票授权，请先检查授权状态。",
  invoice_not_ready: "订单未确认收款，或已进入退款流程，暂时不能开票。",
  invoice_conflict: "该订单已有申请或资料已变更，请刷新原申请查看。",
  invoice_invalid: "请核对订单号、客户资料和开票配置。",
  invoice_unavailable: "开票服务暂时不可用，请稍后刷新原申请。",
  invoice_provider_unavailable: "开票服务暂时不可用，请稍后刷新原申请。",
  invoice_profile_conflict: "开票配置已发生变化，请刷新后再保存。",
  invoice_profile_unavailable: "本商户尚未启用开票或未完成授权，请联系管理员。",
  invoice_order_unconfirmed: "订单尚未确认收款，暂时不能开票。",
  invoice_refund_conflict: "订单存在退款申请，暂时不能开票。",
  invoice_legacy_conflict: "该订单已有历史发票或申请，请先核对原记录。",
  invoice_request_conflict: "该订单已有开票申请，请在列表核对原申请。",
  invoice_buyer_conflict: "同一开票申请重试时不能修改购方类型、抬头、税号或邮箱，请恢复原资料。",
  invoice_unconfigured: "平台尚未配置开票服务，请联系管理员。",
  invoice_provider_mismatch: "开票资料与当前服务商不一致，请联系管理员核对。",
  invoice_disabled: "当前开票操作未启用，请联系管理员。",
  invoice_order_unavailable: "订单尚未确认支付、正在退款或不属于当前商户。",
  invoice_payment_unsupported: "此接口仅支持微信支付订单，支付宝订单暂不支持。",
  invoice_payment_merchant_mismatch: "开票主体与微信订单实际收款商户不一致，请先核对商户绑定。",
  invoice_seller_conflict: "该微信子商户号已绑定其他商户，请联系管理员核对。",
  invoice_not_found: "未找到当前商户的开票记录，请刷新列表。",
  invoice_not_issued: "发票尚未开具完成或已进入红冲流程，暂时无法下载。",
  invoice_retry_limit: "该订单已达到 5 次申请上限，请联系管理员核查失败原因。",
};

function failureMessage(error: Error) {
  return error instanceof MerchantConsoleError ? errors[error.code] ?? error.message : "操作未完成，请刷新后重试。";
}

async function invoiceSession(merchantId: string, capability: "canRequest" | "canConfigure" | "enabled") {
  const session = await merchantRequest<TaxInvoiceSession>("tax-invoices/session", { merchantId });
  if (!session[capability] || !session.csrfToken) throw new MerchantConsoleError(403, "forbidden");
  return session;
}

export function MerchantTaxInvoices({ merchantId, role }: { merchantId: string; role: ConsoleMerchant["role"] }) {
  const [page, setPage] = useState(1);
  const [billingPeople, setBillingPeople] = useState<{ subMchId: string; ids: string[] } | null>(null);
  function rememberBillingPeople(subMchId: string, ids: string[]) { setBillingPeople({ subMchId, ids }); }
  const session = useQuery({
    queryKey: ["merchant-console", merchantId, "tax-invoice-session", role],
    queryFn: ({ signal }) => merchantRequest<TaxInvoiceSession>("tax-invoices/session", { merchantId }, signal), retry: false,
  });
  const invoices = useQuery({
    queryKey: ["merchant-console", merchantId, "tax-invoices", page],
    queryFn: ({ signal }) => merchantRequest<{ invoices: TaxInvoice[]; hasNext: boolean }>("tax-invoices", { merchantId, page: String(page) }, signal), retry: false,
    refetchInterval: query => session.data?.enabled && query.state.data?.invoices.some(invoice => PENDING_INVOICE_STATUSES.has(invoice.status))
      ? INVOICE_POLL_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
  });
  return <section className="space-y-6">
    <div><h2 className="text-xl font-semibold">{session.data?.platformFeesConfigured ? "服务费开票" : "客户开票"}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{session.data?.platformFeesConfigured ? "为平台实际收取的技术服务费开具发票。" : "以当前商户的税务主体开票，金额以已确认收款的订单为准。"}</p></div>
    <ConsoleQuery query={session}>{access => <>
      {access.platformFeesConfigured && <MerchantFeeInvoices merchantId={merchantId} admin={role === "admin"} />}
      {!access.platformFeesConfigured && <>
      <InvoiceReadiness merchantId={merchantId} session={access} role={role} onBillingPeople={rememberBillingPeople} />
      {role === "admin" && access.canConfigure && <InvoiceProfileForm key={JSON.stringify(access.profile)} merchantId={merchantId} profile={access.profile} providerKind={access.providerKind ?? "wechat"} allowEnable={access.enabled} billingPersonIds={billingPeople?.subMchId === access.profile?.subMchId ? billingPeople?.ids ?? [] : []} />}
      {role !== "member" && access.canRequest && <InvoiceRequestForm merchantId={merchantId} />}
      </>}
    </>}</ConsoleQuery>
    {!session.data?.platformFeesConfigured && <div><h3 className="font-medium">开票申请</h3><ConsoleQuery query={invoices}>{value => <>
      <ul className="mt-4 divide-y border-y">{value.invoices.map(invoice => <InvoiceRecord key={invoice.id} merchantId={merchantId} invoice={invoice} canOperate={role !== "member" && session.data?.enabled === true} canReconcile={role === "admin" && session.data?.canReconcile === true} />)}</ul>
      {!value.invoices.length && <p className="py-6 text-sm text-muted-foreground">暂无客户开票申请。</p>}
      <ConsolePagination page={page} hasNext={value.hasNext} change={setPage} />
    </>}</ConsoleQuery></div>}
  </section>;
}

function InvoiceReadiness({ merchantId, session, role, onBillingPeople }: { merchantId: string; session: TaxInvoiceSession; role: ConsoleMerchant["role"]; onBillingPeople: (subMchId: string, ids: string[]) => void }) {
  const client = useQueryClient();
  const check = useMutation({
    retry: false, mutationFn: async () => {
      const access = await invoiceSession(merchantId, "enabled");
      return merchantRequest<{ profile: InvoiceProfile; billingPersonIds: string[] }>("tax-invoices/authorization", { merchantId }, undefined, { token: access.csrfToken!, body: {} });
    },
    onSuccess: reply => { onBillingPeople(reply.profile.subMchId, reply.billingPersonIds); },
    onError: () => { if (session.profile) onBillingPeople(session.profile.subMchId, []); },
    onSettled: async () => { await client.invalidateQueries({ queryKey: ["merchant-console", merchantId] }); },
  });
  const invite = useMutation({
    retry: false, mutationFn: async () => {
      const access = await invoiceSession(merchantId, "enabled");
      const reply = await merchantRequest<{ url: string }>("tax-invoices/invite", { merchantId }, undefined, { token: access.csrfToken!, body: {} });
      return invoiceUrl(reply.url);
    },
  });
  function checkAuthorization() { check.mutate(); }
  function requestAuthorization() { invite.mutate(); }
  const profile = session.profile;
  return <div className="space-y-4 rounded-lg border p-5">
    <p className="text-sm text-muted-foreground">{session.providerKind === "fa-piao" ? "已接入 fa-piao，可处理微信和支付宝已确认订单；验证码及扫脸仍需开票员完成。" : "当前接入仅支持微信支付订单，支付宝订单暂不支持。"}</p>
    {!session.providerConfigured && <p role="status" className="text-sm">平台开票服务尚未配置，请联系管理员完成服务商接入。</p>}
    {!session.enabled && <p role="status" className="text-sm">当前开票服务未启用，可查看已有申请。</p>}
    {!profile && <p className="text-sm text-muted-foreground">当前商户尚未绑定开票主体。请由管理员核对本商户的税务资料。</p>}
    {profile && <>
      <dl className="grid gap-4 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">开票方</dt><dd className="mt-1 break-all font-medium">{profile.sellerName}</dd></div><div><dt className="text-muted-foreground">开票方税号</dt><dd className="mt-1 break-all">{profile.sellerTaxId}</dd></div><div><dt className="text-muted-foreground">开票项目</dt><dd className="mt-1 break-all">{profile.itemName}</dd></div><div><dt className="text-muted-foreground">授权状态</dt><dd className="mt-1">{profile.authorized ? "已授权" : "尚未完成开票授权"}</dd></div></dl>
      {!profile.enabled && <p className="text-sm text-muted-foreground">本商户的开票功能尚未启用。</p>}
      {profile.authorizationCheckedAt > 0 && <p className="text-xs text-muted-foreground">最近核对：{dateText(profile.authorizationCheckedAt)}</p>}
      {role !== "member" && session.enabled && session.providerConfigured && <div className="flex flex-wrap gap-3"><Button variant="outline" onClick={checkAuthorization} disabled={check.isPending}>{check.isPending ? "正在检查授权…" : "检查开票授权"}</Button><Button variant="outline" onClick={requestAuthorization} disabled={invite.isPending}>{invite.isPending ? "正在获取…" : "获取微信授权入口"}</Button></div>}
      {invite.data && <a className="inline-flex min-h-8 items-center text-sm underline underline-offset-4" href={invite.data} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">前往微信完成开票授权</a>}
    </>}
    {check.isError && <p role="alert" className="text-sm text-destructive">{failureMessage(check.error)}</p>}
    {check.isSuccess && check.data.billingPersonIds.length > 0 && !session.profile?.billingPersonId && <p role="status" className="text-sm">已取得可用开票员名单，请由管理员在下方商户开票配置中选择开票员，再启用开票。</p>}
    {invite.isError && <p role="alert" className="text-sm text-destructive">{failureMessage(invite.error)}</p>}
  </div>;
}

function InvoiceField({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return <div className="space-y-2"><label htmlFor={id} className="text-sm">{label}</label>{children}</div>;
}

function InvoiceProfileForm({ merchantId, profile, billingPersonIds, providerKind, allowEnable }: { merchantId: string; profile: InvoiceProfile | null; billingPersonIds: string[]; providerKind: "wechat" | "fa-piao"; allowEnable: boolean }) {
  const isFaPiao = providerKind === "fa-piao";
  const [subMchId, setSubMchId] = useState(profile?.subMchId ?? "");
  const [sellerName, setSellerName] = useState(profile?.sellerName ?? "");
  const [sellerTaxId, setSellerTaxId] = useState(profile?.sellerTaxId ?? "");
  const [itemName, setItemName] = useState(profile?.itemName ?? "");
  const [billingPersonId, setBillingPersonId] = useState(profile?.billingPersonId ?? "");
  const [taxCode, setTaxCode] = useState(profile?.taxCode ?? "");
  const [taxRate, setTaxRate] = useState(profile ? String(profile.taxRateBps / 100) : "");
  const [enabled, setEnabled] = useState(profile?.enabled ?? false);
  const [validation, setValidation] = useState("");
  const client = useQueryClient();
  const save = useMutation({
    retry: false, mutationFn: async (taxRateBps: number) => {
      const access = await invoiceSession(merchantId, "canConfigure");
      return merchantRequest("tax-invoices/profile", { merchantId }, undefined, {
        token: access.csrfToken!, body: { ...(isFaPiao ? { provider: "fa-piao" } : {}), expectedVersion: profile?.version ?? 0, subMchId: subMchId.trim(), sellerName: sellerName.trim(), sellerTaxId: sellerTaxId.trim().toUpperCase(), billingPersonId: billingPersonId.trim(), itemName: itemName.trim(), taxCode: taxCode.trim(), taxRateBps, enabled: allowEnable && enabled },
      });
    }, onSuccess: async () => { await client.invalidateQueries({ queryKey: ["merchant-console", merchantId] }); },
  });
  function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const rate = /^(0|[1-9]\d?)(?:\.(\d{1,2}))?$/.exec(taxRate.trim());
    const taxRateBps = rate ? Number(rate[1]) * 100 + Number((rate[2] ?? "").padEnd(2, "0")) : -1;
    const accountValid = (isFaPiao ? /^\d{1,32}$/ : /^\d{6,32}$/).test(subMchId.trim());
    if (!rate || !taxRatesBps.includes(taxRateBps) || !accountValid || !sellerName.trim() || !/^[A-Z0-9]{15,20}$/.test(sellerTaxId.trim().toUpperCase()) || (enabled && !billingPersonId.trim()) || !itemName.trim() || !/^\d{19}$/.test(taxCode.trim())) {
      setValidation("请填写完整的商户开票资料，并由财务确认税收分类编码和税率。"); return;
    }
    setValidation(""); save.mutate(taxRateBps);
  }
  return <Collapsible className="rounded-lg border p-5"><CollapsibleTrigger render={<Button variant="outline" />}>商户开票配置</CollapsibleTrigger><CollapsibleContent>
    <form className="mt-5 space-y-4" onSubmit={saveProfile}>
      <p className="text-sm leading-6 text-muted-foreground">{isFaPiao ? "填写 fa-piao 企业 ID 和电子税务局开票员手机号。销方必须与服务商凭据中登记的企业一致。" : "绑定当前商户自己的微信子商户号和税务主体。开票主体须与微信订单的实际收款商户一致。"}税收分类编码、税率及项目名称由商户财务确认。</p>
      <fieldset disabled={save.isPending} className="grid min-w-0 gap-4 sm:grid-cols-2">
        <InvoiceField id="invoice-submerchant" label={isFaPiao ? "fa-piao 企业 ID" : "微信子商户号"}><Input id="invoice-submerchant" value={subMchId} onChange={event => setSubMchId(event.target.value)} maxLength={32} required /></InvoiceField>
        <InvoiceField id="invoice-seller" label="开票主体名称"><Input id="invoice-seller" value={sellerName} onChange={event => setSellerName(event.target.value)} maxLength={120} required /></InvoiceField>
        <InvoiceField id="invoice-seller-tax" label="开票主体税号"><Input id="invoice-seller-tax" value={sellerTaxId} onChange={event => setSellerTaxId(event.target.value)} maxLength={32} required /></InvoiceField>
        <InvoiceField id="invoice-billing-person" label={isFaPiao ? "开票员手机号" : "开票员 ID"}><Input id="invoice-billing-person" value={billingPersonId} onChange={event => setBillingPersonId(event.target.value)} maxLength={64} required={enabled} list="invoice-billing-people" aria-describedby="invoice-billing-help" /><p id="invoice-billing-help" className="text-xs leading-5 text-muted-foreground">{isFaPiao ? "须与服务商凭据中的开票员一致。平台未启用真实开票时可保存配置，不能启用开票。" : "首次设置可留空并关闭启用开关保存，完成微信授权后检查授权状态，再填写开票员 ID 并启用。"}</p>{subMchId === profile?.subMchId && billingPersonIds.length > 0 && <><datalist id="invoice-billing-people">{billingPersonIds.map(id => <option key={id} value={id} />)}</datalist><p className="text-xs text-muted-foreground">可用开票员，请核对后选择或填写：</p><ul aria-label="可用开票员" className="space-y-1 text-xs">{billingPersonIds.map(id => <li key={id} className="break-all">{id}</li>)}</ul></>}</InvoiceField>
        <InvoiceField id="invoice-item" label="开票项目名称"><Input id="invoice-item" value={itemName} onChange={event => setItemName(event.target.value)} maxLength={90} required /></InvoiceField>
        <InvoiceField id="invoice-tax-code" label="税收分类编码"><Input id="invoice-tax-code" value={taxCode} onChange={event => setTaxCode(event.target.value)} maxLength={19} required /></InvoiceField>
        <InvoiceField id="invoice-tax-rate" label="税率（%）"><Input id="invoice-tax-rate" value={taxRate} inputMode="decimal" onChange={event => setTaxRate(event.target.value)} maxLength={6} required /></InvoiceField>
      </fieldset>
      <label className="flex items-center gap-2 text-sm"><Checkbox checked={allowEnable && enabled} onCheckedChange={setEnabled} disabled={save.isPending || !allowEnable} />启用本商户开票</label>
      <Button type="submit" disabled={save.isPending}>{save.isPending ? "正在保存…" : "保存开票配置"}</Button>
      {(validation || save.isError) && <p role="alert" className="text-sm text-destructive">{validation || (save.error && failureMessage(save.error))}</p>}
    </form>
  </CollapsibleContent></Collapsible>;
}

function InvoiceRequestForm({ merchantId }: { merchantId: string }) {
  const [tradeNo, setTradeNo] = useState(""), [title, setTitle] = useState("");
  const [buyerType, setBuyerType] = useState<InvoiceCommand["buyerType"]>("ORGANIZATION");
  const [taxId, setTaxId] = useState(""), [email, setEmail] = useState("");
  const [pending, setPending] = useState<InvoiceCommand | null>(null), [validation, setValidation] = useState("");
  const client = useQueryClient();
  const submit = useMutation({
    retry: false, mutationFn: async (command: InvoiceCommand) => {
      const access = await invoiceSession(merchantId, "canRequest");
      return merchantRequest("tax-invoices/applications", { merchantId }, undefined, { token: access.csrfToken!, body: command });
    }, onSuccess: async () => {
      setPending(null); setTradeNo(""); setTitle(""); setTaxId(""); setEmail("");
      await client.invalidateQueries({ queryKey: ["merchant-console", merchantId] });
    }, onError: error => {
      const declined = error instanceof MerchantConsoleError && ([400, 401, 403, 404].includes(error.status)
        || ["invoice_order_unconfirmed", "invoice_payment_unsupported", "invoice_payment_merchant_mismatch", "invoice_refund_conflict",
          "invoice_legacy_conflict", "invoice_profile_unavailable", "invoice_profile_conflict", "invoice_request_conflict", "invoice_buyer_conflict",
          "invoice_not_authorized", "invoice_retry_limit", "invoice_unconfigured"].includes(error.code));
      if (declined) setPending(null);
    },
  });
  function requestInvoice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) { submit.mutate(pending); return; }
    if (new TextEncoder().encode(email.trim()).byteLength > MAX_EMAIL_BYTES) {
      setValidation("接收邮箱过长，请使用不超过 214 字节的邮箱地址。"); return;
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tradeNo.trim()) || !title.trim() || (buyerType === "ORGANIZATION" && !/^[A-Z0-9]{15,20}$/.test(taxId.trim().toUpperCase())) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setValidation("请填写有效的订单号、客户抬头、税号和邮箱。"); return;
    }
    const command = { requestId: crypto.randomUUID(), tradeNo: tradeNo.trim(), buyerType, title: title.trim(), taxId: buyerType === "INDIVIDUAL" ? "" : taxId.trim().toUpperCase(), email: email.trim() };
    setValidation(""); setPending(command); submit.mutate(command);
  }
  return <form className="space-y-4 rounded-lg border p-5" onSubmit={requestInvoice}>
    <h3 className="font-medium">为客户申请开票</h3>
    <p className="text-sm leading-6 text-muted-foreground">请核对真实交易及客户资料。申请受理后，下方列表会自动更新开票结果。</p>
    <p className="text-sm leading-6 text-muted-foreground">订单最新申请确认失败后，可使用同一订单号重新申请，每笔订单最多 5 次。重试须保留原购方类型、抬头、税号和邮箱；税目等开票配置请联系管理员修正。处理中或结果待核实的申请请先查询原结果。</p>
    <fieldset disabled={pending !== null} className="grid min-w-0 gap-4 sm:grid-cols-2">
      <RadioGroup<InvoiceCommand["buyerType"]> aria-label="客户类型" name="invoice-buyer-type" value={buyerType} onValueChange={setBuyerType} disabled={pending !== null} className="flex flex-wrap gap-4 text-sm sm:col-span-2"><BuyerType value="ORGANIZATION">企业或组织</BuyerType><BuyerType value="INDIVIDUAL">个人</BuyerType></RadioGroup>
      <InvoiceField id="invoice-order" label="平台订单号"><Input id="invoice-order" value={tradeNo} onChange={event => setTradeNo(event.target.value)} maxLength={64} required /></InvoiceField>
      <InvoiceField id="invoice-buyer" label="客户抬头"><Input id="invoice-buyer" value={title} onChange={event => setTitle(event.target.value)} maxLength={160} required /></InvoiceField>
      {buyerType === "ORGANIZATION" && <InvoiceField id="invoice-buyer-tax" label="客户税号"><Input id="invoice-buyer-tax" value={taxId} onChange={event => setTaxId(event.target.value)} maxLength={20} required /></InvoiceField>}
      <InvoiceField id="invoice-email" label="接收邮箱"><Input id="invoice-email" type="email" value={email} onChange={event => setEmail(event.target.value)} maxLength={MAX_EMAIL_BYTES} required /></InvoiceField>
    </fieldset>
    <Button type="submit" disabled={submit.isPending}>{submit.isPending ? "正在提交…" : pending ? "核实并重试原申请" : "提交开票申请"}</Button>
    {pending && !submit.isPending && <p className="text-sm text-muted-foreground">上次提交结果尚未确认，重试会继续使用原申请资料。</p>}
    {(validation || submit.isError) && <p role="alert" className="text-sm text-destructive">{validation || (submit.error && failureMessage(submit.error))}</p>}
    {submit.isSuccess && <p role="status" className="text-sm">申请已提交，请在申请列表查看实际开票结果。</p>}
  </form>;
}

function InvoiceRecord({ merchantId, invoice, canOperate, canReconcile }: { merchantId: string; invoice: TaxInvoice; canOperate: boolean; canReconcile: boolean }) {
  const client = useQueryClient();
  const refresh = useMutation({
    retry: false, mutationFn: async () => {
      const access = await invoiceSession(merchantId, "enabled");
      return merchantRequest(`tax-invoices/${encodeURIComponent(invoice.id)}/refresh`, { merchantId }, undefined, { token: access.csrfToken!, body: {} });
    }, onSettled: async () => { await client.invalidateQueries({ queryKey: ["merchant-console", merchantId] }); },
  });
  const files = useMutation({
    retry: false, mutationFn: async () => {
      const access = await invoiceSession(merchantId, "enabled");
      const reply = await merchantRequest<{ url: string }>(`tax-invoices/${encodeURIComponent(invoice.id)}/files`, { merchantId }, undefined, { token: access.csrfToken!, body: {} });
      return invoiceUrl(reply.url);
    },
    onSettled: async () => { await client.invalidateQueries({ queryKey: ["merchant-console", merchantId] }); },
  });
  function refreshInvoice() { refresh.mutate(); }
  function readFiles() { files.mutate(); }
  return <li className="space-y-3 py-5">
    <div className="flex flex-wrap justify-between gap-3"><div className="min-w-0"><p className="break-all font-medium">{invoice.title}</p><p className="mt-1 break-all text-xs text-muted-foreground">订单 {invoice.tradeNo}</p><p className="mt-1 text-xs text-muted-foreground">{dateText(invoice.createdAt)}</p></div><div className="text-right"><p className="font-semibold tabular-nums">¥ {centsText(invoice.amountCents)}</p><p className="mt-1 text-sm">{statuses[invoice.status] ?? "待核实"}</p></div></div>
    {invoice.invoiceNo && <p className="break-all text-xs text-muted-foreground">发票号码 {invoice.invoiceNo}</p>}
    {invoice.errorCode && providerProblems[invoice.errorCode] && <p role="status" className="text-sm leading-6 text-muted-foreground">{providerProblems[invoice.errorCode]}</p>}
    <p className="text-xs text-muted-foreground">第 {invoice.attempt} / {MAX_INVOICE_ATTEMPTS} 次申请</p>
    {invoice.status === "FAILED" && <p className="text-sm leading-6 text-muted-foreground">{invoice.attempt >= MAX_INVOICE_ATTEMPTS
      ? "该订单已达到 5 次申请上限，请联系管理员核查失败原因。"
      : "本次申请已确认失败。若该订单没有更新的申请，可保留原购方类型、抬头、税号和邮箱，使用同一订单号重新提交；税目等开票配置请联系管理员修正。"}</p>}
    <div className="flex flex-wrap gap-3">
      {canOperate && !["FAILED", "REVERSED"].includes(invoice.status) && <Button variant="outline" onClick={refreshInvoice} disabled={refresh.isPending}>{refresh.isPending ? "正在查询…" : "刷新开票状态"}</Button>}
      {canOperate && invoice.status === "ISSUED" && <Button variant="outline" onClick={readFiles} disabled={files.isPending}>{files.isPending ? "正在获取…" : "获取发票文件"}</Button>}
      {invoice.status === "ISSUED" && files.data && <a className="inline-flex min-h-8 items-center text-sm underline underline-offset-4" href={files.data} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">下载电子发票</a>}
    </div>
    {canReconcile && invoice.applicationNo && ["UNKNOWN", "PROCESSING"].includes(invoice.status) && <InvoiceReconciliation key={`${invoice.id}:${invoice.status}`} merchantId={merchantId} invoiceId={invoice.id} applicationNo={invoice.applicationNo} />}
    {(refresh.isError || files.isError) && <p role="alert" className="text-sm text-destructive">{failureMessage(refresh.error ?? files.error!)}</p>}
  </li>;
}

function invoiceUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("invalid invoice URL");
  return url.href;
}

function BuyerType({ value, children }: { value: InvoiceCommand["buyerType"]; children: ReactNode }) {
  return <label className="flex cursor-pointer items-center gap-2"><Radio.Root value={value} className="flex size-4 shrink-0 items-center justify-center rounded-full border border-input outline-none data-checked:border-primary focus-visible:ring-2 focus-visible:ring-ring data-disabled:cursor-not-allowed data-disabled:opacity-50"><Radio.Indicator className="size-2 rounded-full bg-primary" /></Radio.Root>{children}</label>;
}
