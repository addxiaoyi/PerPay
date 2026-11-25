import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { merchantRequest } from "../src/api/merchant-console";
import { InvoiceReconciliation } from "../src/pages/invoice-reconciliation";

vi.mock("../src/api/merchant-console", async original => ({
  ...await original<typeof import("../src/api/merchant-console")>(), merchantRequest: vi.fn(),
}));
const applicationNo = "a".repeat(32);
const invoiceNo = "20260000000000000001";
const review = { applicationNo, invoiceNo, evidenceRef: "provider-ticket-001", reviewToken: "signed-review", expiresAt: 1_800_000_300_000,
  itemName: "Synthetic service", taxCode: "3040201000000000000", taxRateBps: 600,
  invoice: { title: "Synthetic buyer", tradeNo: "synthetic-trade", amountCents: 1000 } };
it("requires administrator capability and explicit original-blue-invoice confirmation after preview", async () => {
  const request = vi.mocked(merchantRequest);
  request.mockImplementation(async path => {
    if (path === "tax-invoices/session") return { canReconcile: true, csrfToken: "fixture-csrf" };
    if (path.endsWith("/preview")) return { review };
    if (path.endsWith("/confirm")) return { invoice: { status: "ISSUED" } };
    throw new Error(`unexpected request ${path}`);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><InvoiceReconciliation merchantId="main-1" invoiceId="invoice-1" applicationNo={applicationNo} /></QueryClientProvider>);
  fireEvent.click(screen.getByText("核对并回填原发票号"));
  fireEvent.change(screen.getByLabelText("原发票号"), { target: { value: invoiceNo } });
  fireEvent.change(screen.getByLabelText("核对凭据编号或工单号"), { target: { value: review.evidenceRef } });
  fireEvent.click(screen.getByRole("button", { name: "预览原发票" }));
  const confirm = await screen.findByRole("button", { name: "确认关联原发票" });
  expect(confirm).toBeDisabled();
  expect(request.mock.calls.some(([path]) => path.endsWith("/confirm"))).toBe(false);
  fireEvent.click(screen.getByRole("checkbox")); fireEvent.click(confirm);
  await waitFor(() => expect(request.mock.calls.some(([path]) => path.endsWith("/confirm"))).toBe(true));
  expect(request.mock.calls.find(([path]) => path.endsWith("/confirm"))![3]!.body).toEqual({
    applicationNo, invoiceNo, evidenceRef: review.evidenceRef, reviewToken: review.reviewToken,
    originalApplicationConfirmed: true, blueInvoiceConfirmed: true,
  });
  expect(request.mock.calls.some(([path]) => path.endsWith("/applications"))).toBe(false);
});
