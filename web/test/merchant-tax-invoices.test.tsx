import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { merchantRequest, MerchantConsoleError } from "../src/api/merchant-console";
import { MerchantTaxInvoices, type TaxInvoiceSession } from "../src/pages/merchant-tax-invoices";

vi.mock("../src/api/merchant-console", async importOriginal => ({
  ...await importOriginal<typeof import("../src/api/merchant-console")>(),
  merchantRequest: vi.fn(),
}));

const request = vi.mocked(merchantRequest);
const ready: TaxInvoiceSession = {
  enabled: true, providerConfigured: true, canConfigure: false, canRequest: true, csrfToken: "csrf",
  profile: {
    subMchId: "1900000001", sellerName: "示例商户", sellerTaxId: "91310000123456789A",
    itemName: "软件服务", taxCode: "3040201000000000000", taxRateBps: 600, enabled: true,
    authorized: true, authorizationCheckedAt: 1_800_000_000_000, version: 1, billingPersonId: "person-1",
  },
};

function show(session = ready, invoices: unknown[] = [], role: "owner" | "admin" | "member" = "owner") {
  request.mockImplementation(async path => {
    if (path === "tax-invoices/session") return session;
    if (path === "tax-invoices") return { invoices, hasNext: false };
    if (path === "tax-invoices/profile") return { profile: session.profile };
    if (path === "tax-invoices/authorization") return { profile: session.profile, billingPersonIds: ["person-1", "person-2"] };
    return { invoice: { id: "invoice-1", status: "PROCESSING" } };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><MerchantTaxInvoices merchantId="merchant-1" role={role} /></QueryClientProvider>);
}

beforeEach(() => { request.mockReset(); });
afterEach(() => { focusManager.setFocused(undefined); });

async function advanceInvoiceClock(milliseconds: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}

describe("automatic invoice status updates", () => {
  const invoice = { id: "pending-1", tradeNo: "order-1", title: "待开票客户", amountCents: 100, attempt: 1, createdAt: 1_800_000_000_000 };
  const listRequests = () => request.mock.calls.filter(([path]) => path === "tax-invoices");

  it.each(["PENDING", "PROCESSING", "UNKNOWN", "REVERSING"])("refreshes %s from the local list and stops at an issued result", async status => {
    vi.useFakeTimers();
    focusManager.setFocused(true);
    show(ready, [{ ...invoice, status }]);
    await advanceInvoiceClock(1);
    expect(screen.getByText("待开票客户")).toBeVisible();
    expect(listRequests()).toHaveLength(1);
    request.mockImplementation(async path => {
      if (path === "tax-invoices/session") return ready;
      if (path === "tax-invoices") return { invoices: [{ ...invoice, status: "ISSUED", invoiceNo: "12345678901234567890" }], hasNext: false };
      throw new Error(`unexpected invoice mutation: ${path}`);
    });

    await advanceInvoiceClock(5_000);
    await advanceInvoiceClock(1);
    expect(screen.getByText("已开票")).toBeVisible();
    expect(screen.getByText("发票号码 12345678901234567890")).toBeVisible();
    expect(listRequests()).toHaveLength(2);
    await advanceInvoiceClock(30_000);
    expect(listRequests()).toHaveLength(2);
    expect(request.mock.calls.every(([path, , , mutation]) => !mutation && ["tax-invoices", "tax-invoices/session"].includes(path))).toBe(true);
  });

  it("does not poll pending invoices while the invoice service is disabled", async () => {
    vi.useFakeTimers();
    focusManager.setFocused(true);
    show({ ...ready, enabled: false, canRequest: false, csrfToken: null }, [{ ...invoice, status: "PROCESSING" }]);
    await advanceInvoiceClock(1);
    expect(screen.getByText("开票处理中")).toBeVisible();
    await advanceInvoiceClock(30_000);
    expect(listRequests()).toHaveLength(1);
  });

  it("pauses list polling while the page is in the background", async () => {
    vi.useFakeTimers();
    focusManager.setFocused(true);
    show(ready, [{ ...invoice, status: "PROCESSING" }]);
    await advanceInvoiceClock(1);
    focusManager.setFocused(false);
    await advanceInvoiceClock(30_000);
    expect(listRequests()).toHaveLength(1);
  });
});

it("explains an immutable buyer conflict and lets the merchant restore the original details", async () => {
  show();
  request.mockImplementation(async path => {
    if (path === "tax-invoices/session") return ready;
    if (path === "tax-invoices") return { invoices: [], hasNext: false };
    throw new MerchantConsoleError(409, "invoice_buyer_conflict");
  });
  fireEvent.change(await screen.findByLabelText("平台订单号"), { target: { value: "paid-order" } });
  const title = screen.getByLabelText("客户抬头");
  fireEvent.change(title, { target: { value: "另一家购买方" } });
  fireEvent.change(screen.getByLabelText("客户税号"), { target: { value: "91310000123456789B" } });
  fireEvent.change(screen.getByLabelText("接收邮箱"), { target: { value: "buyer@example.test" } });
  fireEvent.click(screen.getByRole("button", { name: "提交开票申请" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("同一开票申请重试时不能修改购方类型、抬头、税号或邮箱，请恢复原资料。");
  expect(title).toBeEnabled();
  expect(screen.getByRole("button", { name: "提交开票申请" })).toBeEnabled();
});

it("allows correcting a declined request but preserves its identity after a network timeout", async () => {
  show();
  let uncertain = false, attempts = 0;
  request.mockImplementation(async path => {
    if (path === "tax-invoices/session") return ready;
    if (path === "tax-invoices") return { invoices: [], hasNext: false };
    attempts++;
    if (attempts === 3) return { invoice: { id: "recovered", status: "PROCESSING" } };
    if (uncertain) throw new TypeError("Failed to fetch");
    throw new MerchantConsoleError(409, "invoice_order_unconfirmed");
  });
  const order = await screen.findByLabelText("平台订单号");
  fireEvent.change(order, { target: { value: "unpaid-order" } });
  fireEvent.change(screen.getByLabelText("客户抬头"), { target: { value: "客户有限公司" } });
  fireEvent.change(screen.getByLabelText("客户税号"), { target: { value: "91310000123456789B" } });
  fireEvent.change(screen.getByLabelText("接收邮箱"), { target: { value: "buyer@example.test" } });
  fireEvent.click(screen.getByRole("button", { name: "提交开票申请" }));
  await screen.findByRole("alert");
  expect(order).toBeEnabled();
  uncertain = true;
  fireEvent.change(order, { target: { value: "paid-order" } });
  fireEvent.click(screen.getByRole("button", { name: "提交开票申请" }));
  await screen.findByRole("button", { name: "核实并重试原申请" });
  expect(order).toBeDisabled();
  const before = request.mock.calls.filter(([path]) => path === "tax-invoices/applications").at(-1)![3]!.body;
  fireEvent.click(screen.getByRole("button", { name: "核实并重试原申请" }));
  await waitFor(() => expect(request.mock.calls.filter(([path]) => path === "tax-invoices/applications")).toHaveLength(3));
  await screen.findByRole("status");
  expect(request.mock.calls.filter(([path]) => path === "tax-invoices/applications").at(-1)![3]!.body).toEqual(before);
});

describe("merchant tax invoices", () => {
  it("explains missing platform configuration and keeps issuance unavailable", async () => {
    show({ ...ready, providerConfigured: false, canRequest: false, profile: null });
    expect(await screen.findByText(/平台开票服务尚未配置/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "提交开票申请" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存开票配置" })).not.toBeInTheDocument();
  });

  it("shows accepted work as processing and only offers downloads for issued invoices", async () => {
    show(ready, [
      { id: "pending-1", tradeNo: "order-1", title: "待开票客户", amountCents: 100, status: "PROCESSING", attempt: 1, createdAt: 1_800_000_000_000 },
      { id: "issued-1", tradeNo: "order-2", title: "已开票客户", amountCents: 200, status: "ISSUED", attempt: 1, createdAt: 1_800_000_000_000, invoiceNo: "12345678901234567890" },
    ]);
    const pending = (await screen.findByText("待开票客户")).closest("li")!;
    expect(within(pending).getByText("开票处理中")).toBeVisible();
    expect(within(pending).queryByRole("button", { name: "获取发票文件" })).not.toBeInTheDocument();
    const issued = screen.getByText("已开票客户").closest("li")!;
    expect(within(issued).getByRole("button", { name: "获取发票文件" })).toBeEnabled();
  });

  it("does not show issuer configuration or request actions to a member", async () => {
    show({ ...ready, canConfigure: true, canRequest: true }, [], "member");
    await screen.findByText("示例商户");
    expect(screen.queryByRole("button", { name: "保存开票配置" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "提交开票申请" })).not.toBeInTheDocument();
  });

  it("explains how to correct a failed application and shows the five-attempt limit", async () => {
    show(ready, [
      { id: "failed-1", tradeNo: "retry-order", title: "可重试的客户", amountCents: 100, status: "FAILED", attempt: 1, createdAt: 1_800_000_000_000 },
      { id: "failed-5", tradeNo: "limited-order", title: "已达上限的客户", amountCents: 100, status: "FAILED", attempt: 5, createdAt: 1_800_000_000_000 },
    ]);
    const retry = (await screen.findByText("可重试的客户")).closest("li")!;
    expect(within(retry).getByText(/使用同一订单号重新提交/)).toBeVisible();
    expect(within(retry).getByText("第 1 / 5 次申请")).toBeVisible();
    const limited = screen.getByText("已达上限的客户").closest("li")!;
    expect(within(limited).getByText(/已达到 5 次申请上限/)).toBeVisible();
    expect(within(limited).getByText("第 5 / 5 次申请")).toBeVisible();
  });

  it("rejects an email exceeding 214 UTF-8 bytes before sending a request", async () => {
    show();
    fireEvent.change(await screen.findByLabelText("平台订单号"), { target: { value: "trade-email" } });
    fireEvent.change(screen.getByLabelText("客户抬头"), { target: { value: "客户有限公司" } });
    fireEvent.change(screen.getByLabelText("客户税号"), { target: { value: "91310000123456789B" } });
    fireEvent.change(screen.getByLabelText("接收邮箱"), { target: { value: `${"测".repeat(68)}@example.test` } });
    fireEvent.submit(screen.getByLabelText("接收邮箱").closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent("不超过 214 字节");
    expect(request.mock.calls.filter(([path]) => path === "tax-invoices/applications")).toHaveLength(0);
    expect(screen.getByLabelText("接收邮箱")).toBeEnabled();
  });

  it("does not offer downloads for reversing or reversed invoices", async () => {
    show(ready, [
      { id: "reversing-1", tradeNo: "order-1", title: "红冲中的客户", amountCents: 100, status: "REVERSING", attempt: 1, createdAt: 1_800_000_000_000 },
      { id: "reversed-1", tradeNo: "order-2", title: "已红冲的客户", amountCents: 200, status: "REVERSED", attempt: 1, createdAt: 1_800_000_000_000 },
    ]);
    expect(await screen.findByText("红冲处理中")).toBeVisible();
    expect(screen.getByText("已红冲")).toBeVisible();
    expect(screen.queryByRole("button", { name: "获取发票文件" })).not.toBeInTheDocument();
  });

  it("starts new issuer tax settings empty", async () => {
    show({ ...ready, profile: null, canConfigure: true, canRequest: false }, [], "admin");
    fireEvent.click(await screen.findByRole("button", { name: "商户开票配置" }));
    expect(await screen.findByLabelText("税率（%）")).toHaveValue("");
    expect(screen.getByLabelText("税收分类编码")).toHaveValue("");
  });

  it("lets an administrator prepare a disabled profile before the provider is configured", async () => {
    show({ ...ready, canConfigure: true, providerConfigured: false, canRequest: false,
      profile: { ...ready.profile!, enabled: false, authorized: false, version: 2, billingPersonId: "" } }, [], "admin");
    fireEvent.click(await screen.findByText("商户开票配置"));
    expect(screen.getByLabelText("开票员 ID")).not.toBeRequired();
    fireEvent.click(screen.getByRole("button", { name: "保存开票配置" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("tax-invoices/profile", { merchantId: "merchant-1" }, undefined, {
      token: "csrf", body: expect.objectContaining({ expectedVersion: 2, enabled: false, billingPersonId: "", taxRateBps: 600 }),
    }));
  });

  it("lists authorized billing people without choosing one for the administrator", async () => {
    show({ ...ready, canConfigure: true, canRequest: false,
      profile: { ...ready.profile!, enabled: false, authorized: false, billingPersonId: "" } }, [], "admin");
    fireEvent.click(await screen.findByRole("button", { name: "检查开票授权" }));
    fireEvent.click(screen.getByText("商户开票配置"));
    const choices = await screen.findByRole("list", { name: "可用开票员" });
    expect(within(choices).getByText("person-1")).toBeVisible();
    expect(within(choices).getByText("person-2")).toBeVisible();
    expect(screen.getByLabelText("开票员 ID")).toHaveValue("");
    fireEvent.click(screen.getByRole("checkbox", { name: "启用本商户开票" }));
    expect(screen.getByLabelText("开票员 ID")).toBeRequired();
    fireEvent.change(screen.getByLabelText("开票员 ID"), { target: { value: "person-2" } });
    fireEvent.click(screen.getByRole("button", { name: "保存开票配置" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("tax-invoices/profile", { merchantId: "merchant-1" }, undefined, {
      token: "csrf", body: expect.objectContaining({ enabled: true, billingPersonId: "person-2" }),
    }));
  });

  it("rechecks authorization before submitting the buyer details", async () => {
    show();
    fireEvent.change(await screen.findByLabelText("平台订单号"), { target: { value: "trade-1" } });
    fireEvent.change(screen.getByLabelText("客户抬头"), { target: { value: "客户有限公司" } });
    fireEvent.change(screen.getByLabelText("客户税号"), { target: { value: "91310000123456789B" } });
    fireEvent.change(screen.getByLabelText("接收邮箱"), { target: { value: "buyer@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "提交开票申请" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("tax-invoices/applications", { merchantId: "merchant-1" }, undefined, {
      token: "csrf", body: expect.objectContaining({ tradeNo: "trade-1", title: "客户有限公司", taxId: "91310000123456789B", email: "buyer@example.test" }),
    }));
    expect(request.mock.calls.filter(([path]) => path === "tax-invoices/session").length).toBeGreaterThan(1);
    expect(await screen.findByText(/申请已提交/)).toBeVisible();
  });

  it("omits the tax identifier for an individual buyer", async () => {
    show();
    fireEvent.click(await screen.findByRole("radio", { name: "个人" }));
    fireEvent.change(screen.getByLabelText("平台订单号"), { target: { value: "trade-person" } });
    fireEvent.change(screen.getByLabelText("客户抬头"), { target: { value: "张三" } });
    fireEvent.change(screen.getByLabelText("接收邮箱"), { target: { value: "buyer@example.test" } });
    expect(screen.queryByLabelText("客户税号")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "提交开票申请" }));
    await waitFor(() => expect(request).toHaveBeenCalledWith("tax-invoices/applications", { merchantId: "merchant-1" }, undefined, {
      token: "csrf", body: expect.objectContaining({ buyerType: "INDIVIDUAL", taxId: "", title: "张三" }),
    }));
  });

  it("rejects an unsafe download URL without exposing a link", async () => {
    const invoices = [{ id: "issued-1", tradeNo: "order-1", title: "已开票客户", amountCents: 200, status: "ISSUED", attempt: 1, createdAt: 1_800_000_000_000, invoiceNo: "12345678901234567890" }];
    show(ready, invoices);
    request.mockImplementation(async path => {
      if (path === "tax-invoices/session") return ready;
      if (path === "tax-invoices") return { invoices, hasNext: false };
      return { url: "javascript:alert(1)" };
    });
    fireEvent.click(await screen.findByRole("button", { name: "获取发票文件" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("操作未完成");
    expect(screen.queryByRole("link", { name: "下载电子发票" })).not.toBeInTheDocument();
  });
});
