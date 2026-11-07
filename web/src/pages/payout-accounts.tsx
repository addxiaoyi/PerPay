import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { merchantRequest, dateText, type ConsoleMerchant } from "@/api/merchant-console";
import { accountStatuses, payoutKinds, type PayoutAccess, type PayoutAccount, type PayoutKind } from "@/api/payouts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type Props = { merchantId: string; role: ConsoleMerchant["role"]; session: PayoutAccess; accounts: PayoutAccount[] };
export function PayoutAccounts({ merchantId, role, session, accounts }: Props) {
  const [selected, setSelected] = useState<PayoutAccount | null>(null);
  return <section className="space-y-5" aria-label="提现收款账户"><h3 className="font-semibold">收款账户</h3>
    {role !== "member" && session.canBind && <AccountForm merchantId={merchantId} />}
    {accounts.length === 0 ? <p className="text-sm text-muted-foreground">尚未绑定收款账户。</p> : <ul className="divide-y">{accounts.map(account => <li key={account.id} className="flex flex-wrap items-center justify-between gap-3 py-4"><div><p className="break-all font-medium">{account.label}</p><p className="mt-1 text-sm text-muted-foreground">{accountStatuses[account.status]} · {dateText(account.createdAt)}</p>{account.reviewReference && <p className="mt-1 text-sm">审核说明：{account.reviewReference}</p>}</div>{role === "admin" && session.canReview && <Button variant="outline" onClick={() => setSelected(account)}>核对收款账户</Button>}</li>)}</ul>}
    {role === "admin" && session.canReview && selected && <AccountReview key={selected.id} merchantId={merchantId} account={selected} close={() => setSelected(null)} />}
  </section>;
}

function AccountForm({ merchantId }: { merchantId: string }) {
  const [kind, setKind] = useState<PayoutKind>("bank"), [holderName, setHolderName] = useState(""), [account, setAccount] = useState("");
  const [bankName, setBankName] = useState(""), [bankCode, setBankCode] = useState(""), [accountType, setAccountType] = useState("business"), [appId, setAppId] = useState("");
  const [pending, setPending] = useState<Record<string, string> | null>(null), [validation, setValidation] = useState("");
  const client = useQueryClient();
  const save = useMutation({ retry: false, mutationFn: async (command: Record<string, string>) => {
    const session = await merchantRequest<PayoutAccess>("payouts/session", { merchantId });
    if (!session.canBind) throw new Error("当前账户不能绑定收款账户。");
    return merchantRequest("payouts/accounts", { merchantId }, undefined, { token: session.csrfToken, body: command });
  }, onSuccess: async () => { setPending(null); setAccount(""); setHolderName(""); await client.invalidateQueries({ queryKey: ["merchant-console", merchantId] }); } });
  function submitAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) { save.mutate(pending); return; }
    if (!holderName.trim() || !account.trim() || (kind === "bank" && (!bankName.trim() || !/^\d{12}$/.test(bankCode))) || (kind === "wechat" && !/^wx[A-Za-z0-9]{16}$/.test(appId))) { setValidation("请填写完整收款人和账户资料；银行卡需 12 位联行号，微信需对应 AppID。"); return; }
    const command = { requestId: crypto.randomUUID(), kind, holderName: holderName.trim(), account: account.trim(), ...(kind === "bank" ? { bankName: bankName.trim(), bankCode, accountType } : {}), ...(kind === "wechat" ? { appId } : {}) };
    setValidation(""); setPending(command); save.mutate(command);
  }
  return <form className="max-w-xl space-y-4 rounded-lg border p-5" onSubmit={submitAccount}><h4 className="font-medium">绑定收款账户</h4>
    <div className="space-y-2"><label htmlFor="payout-kind" className="text-sm">收款方式</label><Select value={kind} disabled={pending !== null} onValueChange={value => { if (value === "bank" || value === "alipay" || value === "wechat") setKind(value); }}><SelectTrigger id="payout-kind" className="h-11 w-full text-base"><SelectValue>{payoutKinds[kind]}</SelectValue></SelectTrigger><SelectContent>{Object.entries(payoutKinds).map(([value, label]) => <SelectItem value={value} key={value}>{label}</SelectItem>)}</SelectContent></Select></div>
    <div className="space-y-2"><label htmlFor="payout-holder" className="text-sm">收款户名</label><Input id="payout-holder" autoComplete="off" value={holderName} maxLength={100} disabled={pending !== null} onChange={event => setHolderName(event.target.value)} /></div>
    <div className="space-y-2"><label htmlFor="payout-account" className="text-sm">{kind === "bank" ? "银行账号" : kind === "alipay" ? "支付宝账号（手机号或邮箱）" : "微信收款 OpenID"}</label><Input id="payout-account" autoComplete="off" inputMode={kind === "bank" ? "numeric" : "text"} value={account} maxLength={128} disabled={pending !== null} onChange={event => setAccount(event.target.value)} /></div>
    {kind === "bank" && <><div className="space-y-2"><label htmlFor="payout-bank" className="text-sm">收款银行及支行</label><Input id="payout-bank" value={bankName} maxLength={80} disabled={pending !== null} onChange={event => setBankName(event.target.value)} /></div><div className="space-y-2"><label htmlFor="payout-bank-code" className="text-sm">收款行联行号</label><Input id="payout-bank-code" inputMode="numeric" value={bankCode} maxLength={12} disabled={pending !== null} onChange={event => setBankCode(event.target.value)} /></div><div className="space-y-2"><label htmlFor="payout-account-type" className="text-sm">账户类型</label><Select value={accountType} disabled={pending !== null} onValueChange={value => { if (value) setAccountType(value); }}><SelectTrigger id="payout-account-type" className="h-11 w-full"><SelectValue>{accountType === "business" ? "对公账户" : "个人银行卡"}</SelectValue></SelectTrigger><SelectContent><SelectItem value="business">对公账户</SelectItem><SelectItem value="personal">个人银行卡</SelectItem></SelectContent></Select></div></>}
    {kind === "wechat" && <><div className="space-y-2"><label htmlFor="payout-app-id" className="text-sm">微信应用 AppID</label><Input id="payout-app-id" value={appId} disabled={pending !== null} onChange={event => setAppId(event.target.value)} /></div><p className="text-sm text-muted-foreground">OpenID 必须来自对应应用的微信授权记录，填写微信号或收款码不能代替授权。平台核对后才可使用。</p></>}
    <p className="text-sm text-muted-foreground">资料审核前不能自动提现。更换账户需要重新提交审核，不会改变已提交提现的收款方。</p>
    <Button type="submit" disabled={save.isPending}>{save.isPending ? "正在提交…" : pending ? "重试本次绑定" : "提交账户审核"}</Button>
    {pending && !save.isPending && <Button type="button" variant="outline" onClick={() => { setPending(null); save.reset(); }}>重新填写</Button>}
    {validation && <p role="alert">{validation}</p>}{save.isError && <p role="alert">{save.error.message}</p>}{save.isSuccess && <p role="status">账户已提交，等待审核。</p>}
  </form>;
}

function AccountReview({ merchantId, account, close }: { merchantId: string; account: PayoutAccount; close: () => void }) {
  const [reference, setReference] = useState(""), [details, setDetails] = useState<Record<string, string> | null>(null);
  const client = useQueryClient();
  useEffect(() => { if (!details) return; const timer = window.setTimeout(() => setDetails(null), 60000); return () => window.clearTimeout(timer); }, [details]);
  const operation = useMutation({ retry: false, mutationFn: async (decision: "reveal" | "approve" | "reject" | "revoke") => {
    const session = await merchantRequest<PayoutAccess>("payouts/session", { merchantId });
    if (!session.canReview) throw new Error("需要当前管理员权限。");
    if (decision !== "reveal" && !reference.trim()) throw new Error("请填写账户归属核对依据或拒绝原因。");
    const value = await merchantRequest<Record<string, string>>(`payouts/accounts/${account.id}/${decision === "reveal" ? "reveal" : "review"}`, { merchantId }, undefined, { token: session.csrfToken, body: decision === "reveal" ? {} : { decision, reference: reference.trim() } });
    if (decision === "reveal") setDetails(value);
    else { setDetails(null); await client.invalidateQueries({ queryKey: ["merchant-console", merchantId] }); close(); }
  } });
  const labels: Record<string, string> = { holderName: "收款户名", account: "收款账号", bankName: "开户银行", bankCode: "联行号", appId: "微信 AppID", accountType: "账户类型" };
  return <section className="space-y-4 rounded-lg border p-5" aria-label="审核收款账户"><h4 className="font-medium">{account.label}</h4><Button variant="outline" disabled={operation.isPending} onClick={() => operation.mutate("reveal")}>查看完整收款资料</Button>{details && <><dl className="space-y-2">{Object.entries(details).filter(([key]) => key in labels).map(([key, value]) => <div key={key}><dt className="text-sm text-muted-foreground">{labels[key]}</dt><dd className="break-all">{value === "business" ? "对公" : value === "personal" ? "个人" : value}</dd></div>)}</dl><Button variant="ghost" onClick={() => setDetails(null)}>隐藏资料</Button></>}
    <label htmlFor="payout-account-reference" className="block text-sm">账户归属核对依据或审核说明</label><Input id="payout-account-reference" value={reference} maxLength={200} onChange={event => setReference(event.target.value)} /><div className="flex flex-wrap gap-2">{account.status === "PENDING" && <><Button disabled={operation.isPending} onClick={() => operation.mutate("approve")}>批准收款账户</Button><Button variant="outline" disabled={operation.isPending} onClick={() => operation.mutate("reject")}>拒绝账户</Button></>}{account.status === "APPROVED" && <Button variant="outline" disabled={operation.isPending} onClick={() => operation.mutate("revoke")}>停用收款账户</Button>}<Button variant="ghost" disabled={operation.isPending} onClick={close}>关闭审核</Button></div>{operation.isError && <p role="alert">{operation.error.message}</p>}
  </section>;
}
