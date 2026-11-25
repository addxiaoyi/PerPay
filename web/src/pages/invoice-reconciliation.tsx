import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { merchantRequest, centsText, dateText, MerchantConsoleError } from "@/api/merchant-console";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

type Candidate = { applicationNo: string; invoiceNo: string; evidenceRef: string };
type Review = Candidate & { reviewToken: string; expiresAt: number; itemName: string; taxCode: string; taxRateBps: number;
  invoice: { title: string; tradeNo: string; amountCents: number } };
const problems: Record<string, string> = {
  invoice_reconcile_conflict: "核对已过期或申请已变化，请重新预览。",
  invoice_reconcile_unverified: "原发票核验未通过，没有保存回填。请检查平台服务状态、发票号及原申请资料。",
  invoice_reconcile_unavailable: "当前平台不支持原发票核对。",
};
function failure(error: Error) { return error instanceof MerchantConsoleError ? problems[error.code] ?? error.message : "核对未完成，请重新预览。"; }

export function InvoiceReconciliation({ merchantId, invoiceId, applicationNo }: { merchantId: string; invoiceId: string; applicationNo: string }) {
  const [number, setNumber] = useState("");
  const [reference, setReference] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const client = useQueryClient();
  async function post<T>(step: "preview" | "confirm", body: unknown): Promise<T> {
    const session = await merchantRequest<{ canReconcile: boolean; csrfToken: string | null }>("tax-invoices/session", { merchantId });
    if (!session.canReconcile || !session.csrfToken) throw new MerchantConsoleError(403, "forbidden");
    return merchantRequest<T>(`tax-invoices/${encodeURIComponent(invoiceId)}/reconcile/${step}`, { merchantId }, undefined, { token: session.csrfToken, body });
  }
  const preview = useMutation({ retry: false,
    mutationFn: (candidate: Candidate) => post<{ review: Review }>("preview", candidate),
    onSuccess: reply => { setReview(reply.review); setConfirmed(false); },
  });
  const confirm = useMutation({ retry: false, mutationFn: () => {
    if (!review || !confirmed) throw new Error("original invoice confirmation is required");
    return post("confirm", { applicationNo: review.applicationNo, invoiceNo: review.invoiceNo, evidenceRef: review.evidenceRef,
      reviewToken: review.reviewToken, originalApplicationConfirmed: true, blueInvoiceConfirmed: true });
  }, onSuccess: async () => { setReview(null); await client.invalidateQueries({ queryKey: ["merchant-console", merchantId] }); },
    onError: () => { setReview(null); setConfirmed(false); },
  });
  function previewInvoice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setReview(null); setConfirmed(false); confirm.reset();
    preview.mutate({ applicationNo, invoiceNo: number.trim(), evidenceRef: reference.trim() });
  }
  function confirmInvoice() { confirm.mutate(); }
  function reviseReview() { setReview(null); setConfirmed(false); preview.reset(); confirm.reset(); }
  return <Collapsible className="rounded-md border p-4">
    <CollapsibleTrigger render={<Button variant="outline" />}>核对并回填原发票号</CollapsibleTrigger>
    <CollapsibleContent>
    <p className="my-3 text-sm leading-6 text-muted-foreground">在开票平台找到原申请的发票，确认申请流水号一致、蓝字发票有效且未红冲。此操作只关联原发票，不会重新开票。</p>
    <p className="mb-3 break-all text-xs">原申请流水号：{applicationNo}</p>
    {!review && <form onSubmit={previewInvoice} className="space-y-3">
      <label className="block space-y-1 text-sm">原发票号<Input aria-label="原发票号" value={number} onChange={event => setNumber(event.target.value)} pattern="[0-9]{20}" minLength={20} maxLength={20} required disabled={preview.isPending || confirm.isPending} /></label>
      <label className="block space-y-1 text-sm">核对凭据编号或工单号<Input aria-label="核对凭据编号或工单号" value={reference} onChange={event => setReference(event.target.value)} minLength={6} maxLength={240} required disabled={preview.isPending || confirm.isPending} /></label>
      <Button type="submit" variant="outline" disabled={preview.isPending || confirm.isPending}>{preview.isPending ? "正在核验原发票…" : "预览原发票"}</Button>
    </form>}
    {review && <div className="space-y-3 text-sm">
      <p className="break-all">已核验发票号：{review.invoiceNo}</p>
      <p className="break-all">客户：{review.invoice.title}；金额：¥ {centsText(review.invoice.amountCents)}</p>
      <p className="break-all">项目：{review.itemName}；税收编码：{review.taxCode}；税率：{review.taxRateBps / 100}%</p>
      <p className="break-all">核对凭据：{review.evidenceRef}；预览有效至 {dateText(review.expiresAt)}</p>
      <label className="flex items-start gap-2"><Checkbox checked={confirmed} onCheckedChange={setConfirmed} disabled={confirm.isPending} />我已在开票平台确认该发票属于上述原申请，且为有效未红冲蓝字发票。</label>
      <div className="flex flex-wrap gap-3"><Button onClick={confirmInvoice} disabled={!confirmed || confirm.isPending}>{confirm.isPending ? "正在确认回填…" : "确认关联原发票"}</Button><Button variant="outline" onClick={reviseReview} disabled={confirm.isPending}>重新预览</Button></div>
    </div>}
    {(preview.isError || confirm.isError) && <p role="alert" className="mt-3 text-sm text-destructive">{failure(confirm.error ?? preview.error!)}</p>}
    {confirm.isSuccess && <p role="status" className="mt-3 text-sm">原发票号已关联，核对操作已记入审计记录。</p>}
    </CollapsibleContent>
  </Collapsible>;
}
