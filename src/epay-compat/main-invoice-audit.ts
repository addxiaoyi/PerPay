type Row = Record<string, unknown>;
type Issue = { code: string; id: string };

export function auditMainInvoiceFees(payment: unknown): Issue[] {
  if (!payment || typeof payment !== "object" || Array.isArray(payment)) throw new Error("invalid main invoice source");
  const source = payment as Record<string, unknown>;
  if (![source.orders, source.ledger, source.invoiceApplications].every(Array.isArray)) throw new Error("main invoice source is incomplete");
  const orders = new Map((source.orders as Row[]).map(row => [row.id, row]));
  const applications = new Map<string, Row>(), issues: Issue[] = [];
  for (const row of source.invoiceApplications as Row[]) {
    if (typeof row.id !== "string" || !row.id || applications.has(row.id) || !Number.isSafeInteger(row.feeCents) || Number(row.feeCents) < 0) throw new Error("invalid main invoice identity or fee");
    applications.set(row.id, row);
    const order = orders.get(row.orderId);
    if (!order || order.merchantId !== row.merchantId || !["paid", "refund_processing", "refunded"].includes(String(order.status))) issues.push({ code: "invoice_order_mismatch", id: row.id });
  }
  const entries = new Map<string, Row[]>();
  for (const row of source.ledger as Row[]) {
    if (row.type !== "invoice_fee") continue;
    const id = String(row.invoiceApplicationId), application = applications.get(id);
    if (!application) { issues.push({ code: "invoice_fee_orphan", id: String(row.id) }); continue; }
    entries.set(id, [...(entries.get(id) ?? []), row]);
    if (row.merchantId !== application.merchantId || row.orderId !== application.orderId || row.availableDelta !== -Number(application.feeCents) || row.frozenDelta !== 0 || row.grossCents !== application.feeCents) issues.push({ code: "invoice_fee_mismatch", id: String(row.id) });
  }
  for (const [id, application] of applications) {
    if ((entries.get(id)?.length ?? 0) !== (Number(application.feeCents) > 0 ? 1 : 0)) issues.push({ code: "invoice_fee_count_mismatch", id });
  }
  return issues;
}
