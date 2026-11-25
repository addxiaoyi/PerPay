import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { merchantRequest } from "../src/api/merchant-console";
import { MerchantTaxInvoices, type TaxInvoiceSession } from "../src/pages/merchant-tax-invoices";

vi.mock("../src/api/merchant-console", async importOriginal => ({
  ...await importOriginal<typeof import("../src/api/merchant-console")>(), merchantRequest: vi.fn(),
}));

it("prepares a fa-piao profile with provider-specific labels while real invoicing remains disabled", async () => {
  const request = vi.mocked(merchantRequest);
  const session: TaxInvoiceSession = { providerKind: "fa-piao", enabled: false, providerConfigured: true,
    canConfigure: true, canRequest: false, csrfToken: "fixture-csrf", profile: {
      provider: "fa-piao", subMchId: "1000", sellerName: "Synthetic seller", sellerTaxId: "91310000123456789A",
      billingPersonId: "13900000000", itemName: "Software", taxCode: "3040201000000000000", taxRateBps: 600,
      enabled: false, authorized: false, authorizationCheckedAt: 0, version: 1,
    } };
  request.mockImplementation(async path => {
    if (path === "tax-invoices/session") return session;
    if (path === "tax-invoices") return { invoices: [], hasNext: false };
    if (path === "tax-invoices/profile") return { profile: session.profile };
    throw new Error(`unexpected invoice request: ${path}`);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><MerchantTaxInvoices merchantId="merchant-1" role="admin" /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "商户开票配置" }));
  expect(await screen.findByLabelText("fa-piao 企业 ID")).toHaveValue("1000");
  expect(screen.getByLabelText("开票员手机号")).toHaveValue("13900000000");
  const enable = screen.getByRole("checkbox", { name: "启用本商户开票" });
  expect(enable).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(enable);
  expect(enable).toHaveAttribute("aria-checked", "false");
  expect(screen.queryByRole("button", { name: "提交开票申请" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "保存开票配置" }));
  await waitFor(() => expect(request.mock.calls.some(([path]) => path === "tax-invoices/profile")).toBe(true));
  const command = request.mock.calls.find(([path]) => path === "tax-invoices/profile")![3]!.body;
  expect(command).toMatchObject({ provider: "fa-piao", subMchId: "1000", enabled: false });
  expect(request.mock.calls.some(([path]) => path === "tax-invoices/applications")).toBe(false);
});
