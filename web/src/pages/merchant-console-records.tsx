import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { merchantRequest, centsText, dateText, paymentLabel, type Invoice, type LedgerEntry, type ConsoleMerchant } from "@/api/merchant-console";
import { ConsolePagination, ConsoleQuery } from "@/components/merchant-console-state";
import { MerchantTaxInvoices } from "./merchant-tax-invoices";

export function MerchantConsoleLedger({ merchantId }: { merchantId: string }) {
  const [page, setPage] = useState(1);
  const ledger = useQuery({ queryKey: ["merchant-console", merchantId, "ledger", page], queryFn: ({ signal }) => merchantRequest<{ entries: LedgerEntry[]; hasNext: boolean }>("ledger-entries", { merchantId, page: String(page) }, signal), retry: false });
  return <section><h2 className="text-xl font-semibold">余额账本</h2><ConsoleQuery query={ledger}>{value => <><ul className="mt-5 divide-y border-y">{value.entries.map(entry => <li key={entry.id} className="flex flex-wrap items-center justify-between gap-3 py-4"><div className="min-w-0"><p className="font-medium">{paymentLabel(entry.type)}</p><time className="text-xs text-muted-foreground">{dateText(entry.occurredAt)}</time></div><div className="text-right tabular-nums"><p className="font-semibold">{entry.availableDeltaCents > 0 ? "+" : ""}{centsText(entry.availableDeltaCents)}</p>{entry.frozenDeltaCents !== 0 && <p className="text-xs text-muted-foreground">冻结变动 {centsText(entry.frozenDeltaCents)}</p>}</div></li>)}</ul>{!value.entries.length && <p className="py-8 text-muted-foreground">暂无账本记录。</p>}<ConsolePagination page={page} hasNext={value.hasNext} change={setPage} /></>}</ConsoleQuery></section>;
}

export function MerchantConsoleInvoices({ merchantId, role = "member" }: { merchantId: string; role?: ConsoleMerchant["role"] }) {
  return <div className="space-y-10"><MerchantTaxInvoices key={`${merchantId}:${role}`} merchantId={merchantId} role={role} /><LegacyInvoiceRecords key={merchantId} merchantId={merchantId} /></div>;
}

function LegacyInvoiceRecords({ merchantId }: { merchantId: string }) {
  const [page, setPage] = useState(1);
  const invoices = useQuery({ queryKey: ["merchant-console", merchantId, "invoices", page], queryFn: ({ signal }) => merchantRequest<{ invoices: Invoice[]; applications: Array<Omit<Invoice, "amountCents"> & { feeCents: number }>; invoicesHaveNext: boolean; applicationsHaveNext: boolean }>("invoices", { merchantId, page: String(page) }, signal), retry: false });
  return <section><h2 className="text-xl font-semibold">历史发票记录</h2><p className="mt-2 text-sm text-muted-foreground">此前保存的发票及申请记录。新的客户开票申请请使用上方入口。</p><ConsoleQuery query={invoices}>{value => <><ul className="mt-5 divide-y border-y">{value.invoices.map(invoice => <li key={invoice.id} className="flex flex-wrap justify-between gap-3 py-4"><div className="min-w-0"><p className="break-all font-medium">{invoice.title}</p><p className="mt-1 break-all text-xs text-muted-foreground">订单 {invoice.tradeNo}</p><p className="mt-1 text-xs text-muted-foreground">{dateText(invoice.createdAt)}</p></div><div className="text-right"><p className="font-semibold tabular-nums">¥ {centsText(invoice.amountCents)}</p><p className="text-sm text-muted-foreground">{paymentLabel(invoice.status)}</p></div></li>)}</ul>{!value.invoices.length && <p className="py-8 text-muted-foreground">暂无发票记录。</p>}{value.applications.length > 0 && <div className="mt-6"><h3 className="font-medium">开票申请</h3>{value.applications.map(item => <div key={item.id} className="flex flex-wrap justify-between gap-3 border-b py-3 text-sm"><span className="break-all">{item.title}</span><span>{paymentLabel(item.status)}</span></div>)}</div>}<ConsolePagination page={page} hasNext={value.invoicesHaveNext || value.applicationsHaveNext} change={setPage} /></>}</ConsoleQuery></section>;
}
