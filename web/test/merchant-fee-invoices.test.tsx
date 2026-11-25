import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { merchantRequest } from "../src/api/merchant-console";
import { MerchantTaxInvoices } from "../src/pages/merchant-tax-invoices";

vi.mock("../src/api/merchant-console", async original => ({ ...await original<typeof import("../src/api/merchant-console")>(), merchantRequest: vi.fn() }));
it("prepares the merchant fee buyer while closed and never exposes the customer full-payment request form", async () => {
  const request = vi.mocked(merchantRequest);
  const seller = { sellerName: 'Synthetic platform', itemName: 'Platform fee', taxCode: '3040205000000000000', taxRateBps: 100 };
  request.mockImplementation(async path => {
    if (path === 'tax-invoices/session') return { enabled: false, platformFeesConfigured: true, providerConfigured: true, canConfigure: true, canRequest: false, profile: null };
    if (path === 'tax-invoices') return { invoices: [], hasNext: false };
    if (path === 'fee-invoices/session') return { configured: true, enabled: false, canConfigure: true, canRequest: false, csrfToken: 'synthetic-csrf', buyer: null, seller };
    if (path === 'fee-invoices') return { invoices: [] };
    if (path === 'fee-invoices/readiness') return { configured: true, issuanceEnabled: false, feeEnabled: false, automaticEnabled: false, policyValid: true,
      buyerReady: false, buyerAutoInvoice: false, selfInvoice: false, validUntil: 1_800_000_000_000, provider: { code: 'fapiao_service_expired', checkedAt: 1_800_000_000_000, nextAt: 0 },
      pendingCount: 1, pendingAmountCents: 50, deferredCount: 0, unverifiedCount: 0, scanLimit: 200, hasMore: false, preview: [] };
    if (path === 'fee-invoices/buyer') return { buyer: {} };
    if (path === 'fee-invoices/subscription') return { subscription: {active:false,validUntil:0,priceCents:10000,durationDays:365},balance:{availableCents:10000,version:0},canPurchase:false,csrfToken:null };
    throw new Error(`unexpected request ${path}`);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MerchantTaxInvoices merchantId='main-1' role='owner' /></QueryClientProvider>);
  fireEvent.change(await screen.findByLabelText('服务费发票抬头'), { target: { value: 'Synthetic merchant' } });
  fireEvent.change(screen.getByLabelText('服务费购方税号'), { target: { value: '91310000987654321B' } });
  fireEvent.change(screen.getByLabelText('服务费接收邮箱'), { target: { value: 'merchant@example.test' } });
  expect(screen.queryByRole('button', { name: '提交开票申请' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '申请该订单的服务费发票' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '保存服务费购方资料' }));
  await waitFor(() => expect(request.mock.calls.some(([path]) => path === 'fee-invoices/buyer')).toBe(true));
  expect(request.mock.calls.find(([path]) => path === 'fee-invoices/buyer')![3]!.body).toMatchObject({ title: 'Synthetic merchant', taxId: '91310000987654321B', autoInvoice: false });
  expect(request.mock.calls.some(([path]) => path.endsWith('/applications'))).toBe(false);
  expect(screen.getByText('fa-piao 企业服务已到期，等待续期后复检。')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '检测开票平台授权' })).not.toBeInTheDocument();
});
