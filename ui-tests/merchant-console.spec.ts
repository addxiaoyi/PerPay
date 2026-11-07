import { expect, test } from "@playwright/test";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createServer } from "vite";
import { resolve } from "node:path";

for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
  test(`main identity merchant console at ${viewport.width}px`, async ({ page }, testInfo) => {
    const root = resolve(process.cwd(), "web");
    const server = await createServer({ root, configFile: false, plugins: [react(), tailwindcss()], resolve: { alias: { "@": resolve(root, "src") } }, server: { host: "127.0.0.1", port: 0 } });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("merchant console fixture is unavailable");
    let revoked = false, statusFilter = "", searchFilter = "", keyReads = 0, callbackRetried = false;
    const failures: string[] = [];
    page.on("pageerror", error => failures.push(error.message));
    try {
      await page.setViewportSize(viewport);
      await page.route("**/api/merchant/epay/**", async route => {
        const url = new URL(route.request().url()), path = url.pathname.split("/epay/")[1], merchantId = url.searchParams.get("merchantId");
        if (revoked) return route.fulfill({ status: 401, json: { ok: false, error: "unauthenticated" } });
        if (path === "keys") keyReads++;
        const data = path === "access" ? { merchants: [1, 2].map(id => ({ merchantId: `main-${id}`, epayMerchantId: id, name: id === 1 ? "星光服商户" : "云端社区商户", role: "admin", feeBps: 500, version: 1 })), administrationEnabled: false }
          : path === "members" ? { merchantId, members: [{ userId: "member-1", username: "星光协作成员", enabled: true, addedAt: "2026-11-05T00:00:00Z" }] }
          : path === "keys/meta" ? { merchantId, epayPid: merchantId?.at(-1), apiId: `api-${merchantId}`, keyConfigured: true }
          : path === "keys/rotation-session" ? { canRotate: false, version: 1, csrfToken: null }
          : path === "keys" ? { merchantId, epayPid: merchantId?.at(-1), apiId: `api-${merchantId}`, keyConfigured: true, md5Key: `isolated-ui-key-${merchantId}` }
          : path === "profile/main-key" ? { merchantId, apiId: `api-${merchantId}`, apiSecret: `isolated-main-key-${merchantId}` }
          : path === "balance" ? { merchantId, availableCents: merchantId === "main-1" ? 93795 : -1234, frozenCents: 0, migrationBaselineVerified: false, version: null }
          : path === "session" ? { merchantId, role: "admin", canAdminister: false, csrfToken: null, expiresAt: 1800000000000 }
          : path === "fee" ? { merchantId: Number(merchantId?.at(-1)), feeBps: 500, version: 1 }
          : path === "fee/history" ? { changes: [{ sequence: 1, occurredAt: 1800000000000, actor: "管理员账户", oldFeeBps: 600, newFeeBps: 500, reason: "合同费率调整" }] }
          : path === "refunds/session" ? { enabled: false, canApprove: false, csrfToken: "isolated-ui-token" }
          : path === "refunds" ? { refunds: [{ refundNo: "refund-fixture-001", tradeNo: "order-1", amountCents: 101, debitCents: 96, status: "PROCESSING", reason: "测试退款", createdAt: 1800000000000, requestedBy: "测试账户", approvedBy: "管理员" }], hasNext: false }
          : path === "ledger-entries" ? { merchantId, entries: [{ id: "ledger-1", type: "manual_adjustment", availableDeltaCents: -100, frozenDeltaCents: 0, occurredAt: 1800000000000 }], hasNext: false }
          : path === "ledger-adjustments" ? { merchantId, adjustments: [{ id: "ledger-1", type: "manual_adjustment", availableDeltaCents: -100, frozenDeltaCents: 0, occurredAt: 1800000000000, actorId: "管理员测试账户", reason: "商户申请提现" }], hasNext: false }
          : path === "invoices" ? { merchantId, invoices: [{ id: "invoice-1", tradeNo: "order-1", title: "星光社区技术服务发票", amountCents: 5000, status: "ISSUED", createdAt: 1800000000000 }], applications: [], invoicesHaveNext: false, applicationsHaveNext: false }
          : path === "notifications" ? { tradeNo: "order-1", notifications: [{ id: 1, status: "SUCCESS", createdAt: 1800000000000 }], hasNext: false }
          : path === "callbacks/session" ? { enabled: true, csrfToken: "retry-token" }
          : path === "callbacks/retry" ? { queued: true }
          : path === "callback-attempts" ? { tradeNo: "order-1", job: { status: callbackRetried ? "PENDING" : "FAILED", attempts: 1, updatedAt: 1800000000000 }, attempts: [{ id: "attempt-1", number: 1, method: "POST", outcome: "RETRY", httpStatus: 200, startedAt: 1800000000000, finishedAt: 1800000001000, failureReason: "商户接口未确认收到通知" }], hasNext: false }
          : path === "combined-orders" ? { merchantId, orders: [{ id: "order-1", merchantOrderId: merchantId === "main-1" ? "星光测试订单001" : "云端测试订单002", amountCents: 101, status: "paid", createdAt: "2026-11-04T12:00:00Z", source: "epay" }], hasNext: false }
          : null;
        if (path === "combined-orders") { statusFilter = url.searchParams.get("status") ?? ""; searchFilter = url.searchParams.get("search") ?? ""; }
        if (path === "callbacks/retry") {
          expect(route.request().headers()["x-csrf-token"]).toBe("retry-token");
          expect(route.request().postDataJSON().tradeNo).toBe("order-1");
          callbackRetried = true;
        }
        if (!data) return route.fulfill({ status: 404, json: { ok: false } });
        return route.fulfill({ json: { ok: true, data } });
      });
      await page.goto(`http://127.0.0.1:${address.port}/test/fixtures/merchant-console.html`);
      await expect(page.getByRole("heading", { name: "商户工作台" })).toBeVisible();
      await expect(page.getByText("¥ 937.95")).toBeVisible();
      await expect(page.getByText("星光测试订单001")).toBeVisible();
      await page.getByLabel("订单号", { exact: true }).fill("001");
      await page.getByRole("button", { name: "搜索", exact: true }).click();
      await expect.poll(() => searchFilter).toBe("001");
      await page.getByLabel("状态", { exact: true }).click();
      await page.getByRole("option", { name: "已支付", exact: true }).click();
      await expect.poll(() => statusFilter).toBe("paid");
      await page.getByRole("button", { name: "回调记录", exact: true }).click();
      await expect(page.getByText("已送达", { exact: true })).toBeVisible();
      const delivery = page.getByRole("region", { name: "新系统回调投递" });
      await expect(delivery.getByText("第 1 次 · 等待重试", { exact: true })).toBeVisible();
      await expect(delivery.getByText("商户接口未确认收到通知", { exact: true })).toBeVisible();
      await expect(delivery.getByText("已确认送达", { exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "重新投递通知", exact: true }).click();
      await expect(page.getByText("重试请求已保存，送达结果以商户确认回执为准。", { exact: true })).toBeVisible();
      await expect(delivery.getByText("等待投递 · 已尝试 1 次", { exact: true })).toBeVisible();
      expect(callbackRetried).toBe(true);
      await page.getByRole("button", { name: "余额账本", exact: true }).click();
      await expect(page.getByText("管理员余额调整", { exact: true })).toBeVisible();
      await expect(page.getByText("商户申请提现", { exact: true })).toBeVisible();
      await expect(page.getByText("操作人：管理员测试账户", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "发票", exact: true }).click();
      await expect(page.getByText("星光社区技术服务发票")).toBeVisible();
      await expect(page.getByText("暂不受理新的开票申请，历史发票和申请记录继续保留。")).toBeVisible();
      await page.getByRole("button", { name: "退款", exact: true }).click();
      await expect(page.getByText("渠道处理中", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "批准原路退款", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "提交退款申请", exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.getByRole("button", { name: "费率与记录", exact: true }).click();
      await expect(page.getByText("合同费率调整")).toBeVisible();
      await expect(page.getByRole("button", { name: "保存费率" })).toHaveCount(0);
      await page.getByRole("button", { name: "成员权限", exact: true }).click();
      await expect(page.getByText("星光协作成员", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "停用授权", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "添加成员", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "API 接入", exact: true }).click();
      await expect(page.getByRole("button", { name: "查看密钥", exact: true })).toBeEnabled();
      expect(keyReads).toBe(0);
      await expect(page.getByText("isolated-ui-key-main-1", { exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "查看密钥", exact: true }).click();
      await expect(page.getByLabel("EPay MD5 密钥", { exact: true })).toHaveText("isolated-ui-key-main-1");
      await page.getByRole("button", { name: "隐藏密钥", exact: true }).click();
      await expect(page.getByText("isolated-ui-key-main-1", { exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "查看密钥", exact: true }).click();
      await expect(page.getByText("isolated-ui-key-main-1", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "查看主站密钥", exact: true }).click();
      await expect(page.getByLabel("StarMC API 密钥", { exact: true })).toHaveText("isolated-main-key-main-1");
      await expect(page.getByLabel("当前商户", { exact: true })).toContainText("星光服商户");
      await page.getByLabel("当前商户", { exact: true }).click();
      await page.getByRole("option", { name: "云端社区商户", exact: true }).click();
      await expect(page.getByText("云端测试订单002")).toBeVisible();
      await expect(page.getByText("星光测试订单001")).toHaveCount(0);
      await expect(page.getByText("isolated-ui-key-main-1", { exact: true })).toHaveCount(0);
      await expect(page.getByText("isolated-main-key-main-1", { exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`merchant-console-${viewport.width}.png`), fullPage: true });
      await page.setViewportSize({ width: 320, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.getByRole("button", { name: "API 接入", exact: true }).click();
      await page.getByRole("button", { name: "查看密钥", exact: true }).click();
      await expect(page.getByText("isolated-ui-key-main-2", { exact: true })).toBeVisible();
      revoked = true;
      await page.getByRole("button", { name: "刷新权限" }).click();
      await expect(page.getByRole("link", { name: "重新登录", exact: true })).toBeVisible();
      await expect(page.getByText("云端测试订单002")).toHaveCount(0);
      await expect(page.getByText("isolated-ui-key-main-2", { exact: true })).toHaveCount(0);
      expect(failures).toEqual([]);
    } finally { await server.close(); }
  });
}


type ConsoleRole = "admin" | "owner" | "member";

test("administrator can disable and restore another merchant, while member downgrade removes the controls", async ({ page }) => {
  const fixture = await openEditableConsole(page);
  try {
    await page.getByRole("button", { name: "商户状态", exact: true }).click();
    await page.getByRole("button", { name: "停用商户", exact: true }).click();
    await expect(page.getByRole("button", { name: "重新启用", exact: true })).toBeVisible();
    expect(fixture.state.otherMerchantEnabled).toBe(false);
    await page.getByRole("button", { name: "重新启用", exact: true }).click();
    await expect(page.getByRole("button", { name: "停用商户", exact: true })).toBeVisible();
    expect(fixture.state.otherMerchantEnabled).toBe(true);
    expect(fixture.state.merchantStatusWrites).toBe(2);
    fixture.state.role = "member";
    await page.getByRole("button", { name: "刷新权限", exact: true }).click();
    await expect(page.getByRole("button", { name: "商户状态", exact: true })).toHaveCount(0);
    expect(fixture.pageErrors).toEqual([]);
  } finally { await fixture.close(); }
});

test("merchant profile saves a public callback and becomes read-only after a member downgrade", async ({ page }) => {
  const fixture = await openEditableConsole(page);
  try {
    await page.getByRole("button", { name: "商户资料", exact: true }).click();
    await page.getByLabel("商户名称", { exact: true }).fill("更新后的商户");
    await page.getByLabel("回调地址", { exact: true }).fill("https://merchant.example/new-notify");
    await page.getByRole("button", { name: "保存资料", exact: true }).click();
    await expect(page.getByLabel("当前商户", { exact: true })).toContainText("更新后的商户");
    expect(fixture.state.profileWrites).toBe(1);
    expect(fixture.state.callbackUrl).toBe("https://merchant.example/new-notify");
    fixture.state.role = "member";
    await page.getByRole("button", { name: "刷新权限", exact: true }).click();
    await page.getByRole("button", { name: "商户资料", exact: true }).click();
    await expect(page.getByRole("button", { name: "保存资料", exact: true })).toHaveCount(0);
    await expect(page.getByText("https://merchant.example/new-notify", { exact: true })).toBeVisible();
    expect(fixture.pageErrors).toEqual([]);
  } finally { await fixture.close(); }
});

test("collection form reaches the native order route and retains the same order after an uncertain response", async ({ page }) => {
  const fixture = await openEditableConsole(page);
  try {
    await page.getByRole("button", { name: "创建收款", exact: true }).click();
    await page.getByLabel("收款说明", { exact: true }).fill("隔离收款订单");
    await page.getByLabel("金额（元）", { exact: true }).fill("1.01");
    await page.getByLabel("支付方式", { exact: true }).click();
    await page.getByRole("option", { name: "支付宝网页", exact: true }).click();
    fixture.state.loseCollectionResponse = true;
    await page.getByRole("button", { name: "生成收款链接", exact: true }).click();
    await expect(page.getByRole("button", { name: "重试本次订单", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "重试本次订单", exact: true }).click();
    await expect(page.getByRole("link", { name: "打开收款页面", exact: true })).toBeVisible();
    expect(fixture.state.collectionRequests).toHaveLength(2);
    expect(fixture.state.collectionRequests[0]).toEqual(fixture.state.collectionRequests[1]);
    expect(fixture.state.collectionRequests[0]?.amount).toBe("1.01");
    expect(fixture.state.collectionRequests[0]?.channel).toBe("alipay_web");
    expect(fixture.pageErrors).toEqual([]);
  } finally { await fixture.close(); }
});

test("administrator merchant creation validates input and retains its request after a lost response", async ({ page }) => {
  const fixture = await openEditableConsole(page);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "新增商户", exact: true }).click();
    await page.getByRole("button", { name: "创建商户", exact: true }).click();
    await expect(page.getByText("请填写有效账户 ID、商户名称和 HTTPS 回调地址。", { exact: true })).toBeVisible();
    await page.getByLabel("StarMC 账户 ID", { exact: true }).fill("new-owner");
    await page.getByLabel("商户名称", { exact: true }).fill("新商户");
    await page.getByLabel("回调地址", { exact: true }).fill("https://merchant.example/notify");
    fixture.state.loseEnrollmentResponse = true;
    await page.getByRole("button", { name: "创建商户", exact: true }).click();
    await expect(page.getByRole("button", { name: "重试原商户申请", exact: true })).toBeVisible();
    await expect(page.getByLabel("StarMC 账户 ID", { exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "重试原商户申请", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("商户已创建");
    expect(new Set(fixture.state.enrollmentRequests).size).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    fixture.state.role = "owner";
    await page.getByRole("button", { name: "刷新权限", exact: true }).click();
    await expect(page.getByRole("button", { name: "新增商户", exact: true })).toHaveCount(0);
    expect(fixture.pageErrors).toEqual([]);
  } finally { await fixture.close(); }
});

test("key rotation hides old plaintext, retries the same command and disappears after downgrade", async ({ page }) => {
  const fixture = await openEditableConsole(page);
  try {
    await page.getByRole("button", { name: "API 接入", exact: true }).click();
    await page.getByRole("button", { name: "查看密钥", exact: true }).click();
    await expect(page.getByLabel("EPay MD5 密钥", { exact: true })).toHaveText("fixture-key-v1");
    await page.getByRole("button", { name: "准备轮换密钥", exact: true }).click();
    await expect(page.getByText("fixture-key-v1", { exact: true })).toHaveCount(0);
    fixture.state.loseRotationResponse = true;
    await page.getByRole("button", { name: "确认轮换密钥", exact: true }).click();
    await expect(page.getByRole("button", { name: "重试本次轮换", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "重试本次轮换", exact: true }).click();
    await expect(page.getByText("密钥已轮换。点击“查看密钥”获取新密钥。", { exact: true })).toBeVisible();
    expect(fixture.state.keyVersion).toBe(2);
    expect(new Set(fixture.state.rotationRequests).size).toBe(1);
    await page.getByRole("button", { name: "查看密钥", exact: true }).click();
    await expect(page.getByLabel("EPay MD5 密钥", { exact: true })).toHaveText("fixture-key-v2");
    fixture.state.role = "member";
    await page.getByRole("button", { name: "刷新权限", exact: true }).click();
    await expect(page.getByText("fixture-key-v2", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "API 接入", exact: true }).click();
    await expect(page.getByRole("button", { name: "准备轮换密钥", exact: true })).toHaveCount(0);
    expect(fixture.pageErrors).toEqual([]);
  } finally { await fixture.close(); }
});

for (const width of [390, 1280]) test(`settlement request retries once and administrator rejection refreshes balances at ${width}px`, async ({ page }) => {
  const fixture = await openEditableConsole(page);
  try {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("button", { name: "提现结算", exact: true }).click();
    await page.getByLabel("提现金额（元）", { exact: true }).fill("20.00");
    await page.getByLabel("备注", { exact: true }).fill("隔离测试提现");
    fixture.state.loseSettlementResponse = true;
    await page.getByRole("button", { name: "提交提现申请", exact: true }).click();
    await expect(page.getByRole("button", { name: "重试本次提现", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "重试本次提现", exact: true }).click();
    await expect(page.getByText("申请已保存，相应余额已冻结。", { exact: true })).toBeVisible();
    expect(new Set(fixture.state.settlementRequests).size).toBe(1);
    expect(fixture.state.settlements).toHaveLength(1);
    await expect(page.getByText("¥ 103.45", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "处理结算", exact: true }).click();
    await page.getByRole("button", { name: "登记打款完成", exact: true }).click();
    await expect(page.getByText("请先填写已完成打款的凭证。", { exact: true })).toBeVisible();
    expect(fixture.state.frozenCents).toBe(2000);
    await page.getByLabel("打款凭证或驳回说明", { exact: true }).fill("资料有误，重新提交");
    await page.getByRole("button", { name: "驳回并释放余额", exact: true }).click();
    await expect(page.getByText("已驳回", { exact: true })).toBeVisible();
    await expect(page.getByText("¥ 123.45", { exact: true })).toBeVisible();
    expect(fixture.state.frozenCents).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(fixture.pageErrors).toEqual([]);
  } finally { await fixture.close(); }
});

async function openEditableConsole(page: import("@playwright/test").Page) {
  const root = resolve(process.cwd(), "web");
  const server = await createServer({ root, configFile: false, plugins: [react(), tailwindcss()], resolve: { alias: { "@": resolve(root, "src") } }, server: { host: "127.0.0.1", port: 0 } });
  const state = {
    role: "admin" as ConsoleRole, feeBps: 500, version: 1,
    availableCents: 12_345, frozenCents: 0, balanceVersion: 0, loseAdjustmentResponse: false,
    settlements: [] as Array<{ id: string; requestId: string; amountCents: number; note: string; status: string; createdAt: number; reference: string | null }>,
    loseSettlementResponse: false, settlementRequests: [] as string[],
    keyVersion: 1, rotationRequests: [] as string[], loseRotationResponse: false,
    enrollmentRequests: [] as string[], loseEnrollmentResponse: false,
    displayName: "回归测试商户", callbackUrl: "https://merchant.example/notify", profileWrites: 0,
    otherMerchantEnabled: true, merchantStatusWrites: 0,
    collectionRequests: [] as Array<{ merchantOrderId: string; amount: string; channel: string }>, loseCollectionResponse: false,
    balanceWrites: [] as Array<{ requestId: string; expectedVersion: number; deltaCents: number; reason: string }>,
    memberEnabled: true, memberWrites: [] as Array<{ action: string; userId: string; enabled?: boolean }>,
    heldSessionReads: 0, heldDirectoryReads: 0,
    writes: [] as Array<{ expectedFeeBps: number; expectedVersion: number; feeBps: number; reason: string }>,
  };
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  let sessionGate: Promise<void> | undefined;
  let resumeSessions: (() => void) | undefined;
  let directoryGate: Promise<void> | undefined;
  let resumeDirectory: (() => void) | undefined;
  const feePanel = page.locator("section").filter({ has: page.getByRole("heading", { name: "费率与操作记录", exact: true }) });
  const close = async () => {
    resumeSessions?.();
    resumeDirectory?.();
    await page.unrouteAll({ behavior: "wait" });
    await server.close();
  };
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("editable console fixture is unavailable");
    await page.route("**/api/merchant/orders?*", async route => {
      const command = route.request().postDataJSON() as typeof state.collectionRequests[number];
      state.collectionRequests.push(command);
      if (state.loseCollectionResponse) { state.loseCollectionResponse = false; return route.abort("failed"); }
      return route.fulfill({ json: { ok: true, checkoutUrl: `http://127.0.0.1:${address.port}/epay/main/checkout/fixture`, order: { status: "pending_payment" } } });
    });
    await page.route("**/api/merchant/epay/**", async route => {
      const request = route.request(), url = new URL(request.url()), path = url.pathname.split("/epay/")[1];
      if (path !== "access" && url.searchParams.get("merchantId") !== "main-1") return route.fulfill({ status: 403, json: { ok: false, error: "forbidden" } });
      let data: unknown;
      if (path === "access") {
        if (directoryGate) state.heldDirectoryReads++;
        await directoryGate;
        data = { merchants: [{ merchantId: "main-1", epayMerchantId: 1, name: state.displayName, role: state.role, feeBps: state.feeBps, version: state.version }], administrationEnabled: true };
      } else if (path === "session") {
        const role = state.role;
        if (sessionGate) state.heldSessionReads++;
        await sessionGate;
        data = { merchantId: "main-1", role, canAdminister: role === "admin", csrfToken: role === "admin" ? "fixture-admin-token" : null, expiresAt: Date.now() + 600_000 };
      } else if (path === "fee" && request.method() === "POST") {
        if (state.role !== "admin" || request.headers()["x-csrf-token"] !== "fixture-admin-token") return route.fulfill({ status: 403, json: { ok: false, error: "forbidden" } });
        const body = request.postDataJSON() as typeof state.writes[number];
        if (body.expectedFeeBps !== state.feeBps || body.expectedVersion !== state.version) return route.fulfill({ status: 409, json: { ok: false, error: "fee_conflict" } });
        state.writes.push(body);
        state.feeBps = body.feeBps;
        state.version++;
        data = { merchantId: 1, feeBps: state.feeBps, version: state.version };
      } else if (path === "members") {
        if (state.role !== "admin") return route.fulfill({ status: 403, json: { ok: false, error: "forbidden" } });
        if (request.method() === "POST") {
          if (request.headers()["x-csrf-token"] !== "fixture-admin-token") return route.fulfill({ status: 403, json: { ok: false, error: "csrf_invalid" } });
          const body = request.postDataJSON() as typeof state.memberWrites[number];
          state.memberWrites.push(body); state.memberEnabled = body.action === "grant" ? true : body.enabled!;
        }
        data = { merchantId: "main-1", members: [{ userId: "member-1", username: "回归测试成员", enabled: state.memberEnabled }] };
      } else if (path === "fee") {
        data = { merchantId: 1, feeBps: state.feeBps, version: state.version };
      } else if (path === "fee/history") {
        if (state.role !== "admin") return route.fulfill({ status: 403, json: { ok: false, error: "forbidden" } });
        data = { changes: [{ sequence: 1, occurredAt: 1_800_000_000_000, actor: "受限管理员", oldFeeBps: 600, newFeeBps: 500, reason: "仅管理员可见的合同说明" }] };
      } else if (path === "management") {
        if (state.role !== "admin") return route.fulfill({ status: 403, json: { ok: false, error: "forbidden" } });
        data = { merchants: [{ merchantId: "main-1", name: "回归测试商户", enabled: true, epayMerchantId: 1 }, { merchantId: "main-2", name: "另一商户", enabled: state.otherMerchantEnabled, epayMerchantId: 2 }], canEdit: true, csrfToken: "management-token" };
      } else if (path === "management/status") {
        expect(state.role).toBe("admin"); expect(request.headers()["x-csrf-token"]).toBe("management-token");
        const command = request.postDataJSON() as { targetMerchantId: string; enabled: boolean };
        expect(command.targetMerchantId).toBe("main-2"); state.otherMerchantEnabled = command.enabled; state.merchantStatusWrites++; data = command;
      } else if (path === "profile") {
        if (request.method() === "POST") {
          expect(state.role).not.toBe("member");
          const body = request.postDataJSON() as { displayName: string; callbackUrl: string };
          state.displayName = body.displayName; state.callbackUrl = body.callbackUrl; state.profileWrites++;
        }
        data = { merchantId: "main-1", displayName: state.displayName, callbackUrl: state.callbackUrl, apiId: "lp-fixture", canEdit: state.role !== "member", csrfToken: "profile-token" };
      } else if (path === "merchants/creation-session") {
        data = { canCreate: state.role === "admin", csrfToken: "fixture-enrollment-token" };
      } else if (path === "merchants/create") {
        if (state.role !== "admin") return route.fulfill({ status: 403, json: { ok: false, error: "forbidden" } });
        expect(request.headers()["x-csrf-token"]).toBe("fixture-enrollment-token");
        const body = request.postDataJSON() as { requestId: string; userId: string };
        state.enrollmentRequests.push(body.requestId);
        if (state.loseEnrollmentResponse) { state.loseEnrollmentResponse = false; return route.abort("failed"); }
        data = { createdMerchantId: "created-merchant", epayMerchantId: 3, duplicate: state.enrollmentRequests.length > 1 };
      } else if (path === "keys/meta") {
        data = { merchantId: "main-1", epayPid: "1", apiId: "lp-fixture", keyConfigured: true };
      } else if (path === "keys") {
        data = { merchantId: "main-1", epayPid: "1", apiId: "lp-fixture", keyConfigured: true, md5Key: `fixture-key-v${state.keyVersion}` };
      } else if (path === "keys/rotation-session") {
        data = { canRotate: state.role !== "member", version: state.keyVersion, csrfToken: "fixture-rotation-token" };
      } else if (path === "keys/rotate") {
        if (state.role === "member") return route.fulfill({ status: 403, json: { ok: false, error: "forbidden" } });
        expect(request.headers()["x-csrf-token"]).toBe("fixture-rotation-token");
        const body = request.postDataJSON() as { requestId: string; expectedVersion: number };
        const duplicate = state.rotationRequests.includes(body.requestId);
        if (!duplicate) { expect(body.expectedVersion).toBe(state.keyVersion); state.keyVersion++; }
        state.rotationRequests.push(body.requestId);
        if (state.loseRotationResponse) { state.loseRotationResponse = false; return route.abort("failed"); }
        data = { version: state.keyVersion, duplicate };
      } else if (path === "settlements/session") {
        data = { enabled: true, canReview: state.role === "admin", csrfToken: "fixture-settlement-token" };
      } else if (path === "main-activity") {
        data = { records: [], hasNext: false };
      } else if (path === "settlements") {
        if (request.method() === "POST") {
          expect(request.headers()["x-csrf-token"]).toBe("fixture-settlement-token");
          const body = request.postDataJSON() as { requestId: string; amountCents: number; note: string };
          state.settlementRequests.push(body.requestId);
          let settlement = state.settlements.find(item => item.requestId === body.requestId);
          if (!settlement) {
            settlement = { ...body, id: "00000000-0000-4000-8000-000000000001", status: "PENDING", createdAt: Date.now(), reference: null };
            state.settlements.push(settlement); state.availableCents -= body.amountCents; state.frozenCents += body.amountCents;
          }
          if (state.loseSettlementResponse) { state.loseSettlementResponse = false; return route.abort("failed"); }
          data = settlement;
        } else data = { settlements: state.settlements, hasNext: false };
      } else if (path?.endsWith("/decision")) {
        if (state.role !== "admin") return route.fulfill({ status: 403, json: { ok: false, error: "forbidden" } });
        const body = request.postDataJSON() as { decision: string; reference: string }, settlement = state.settlements[0]!;
        if (settlement.status === "PENDING") { state.frozenCents -= settlement.amountCents; if (body.decision === "rejected") state.availableCents += settlement.amountCents; }
        settlement.status = body.decision.toUpperCase(); settlement.reference = body.reference; data = settlement;
      } else if (path === "balance") {
        data = { merchantId: "main-1", availableCents: state.availableCents, frozenCents: state.frozenCents, migrationBaselineVerified: true, version: state.balanceVersion };
      } else if (path === "balance/adjust" && request.method() === "POST") {
        if (state.role !== "admin" || request.headers()["x-csrf-token"] !== "fixture-admin-token") return route.fulfill({ status: 403, json: { ok: false, error: "forbidden" } });
        const body = request.postDataJSON() as typeof state.balanceWrites[number];
        const prior = state.balanceWrites.find(write => write.requestId === body.requestId);
        if (prior ? JSON.stringify(prior) !== JSON.stringify(body) : body.expectedVersion !== state.balanceVersion) return route.fulfill({ status: 409, json: { ok: false, error: "balance_conflict" } });
        state.balanceWrites.push(body);
        if (!prior) { state.availableCents += body.deltaCents; state.balanceVersion++; }
        if (state.loseAdjustmentResponse) { state.loseAdjustmentResponse = false; return route.abort("failed"); }
        data = { merchantId: "main-1", availableCents: state.availableCents, frozenCents: 0, migrationBaselineVerified: true, version: state.balanceVersion };
      } else if (path === "combined-orders") {
        data = { merchantId: "main-1", orders: [], hasNext: false };
      } else if (path === "ledger-entries") {
        data = { merchantId: "main-1", entries: state.balanceWrites.slice(0, state.balanceVersion).map(write => ({ id: write.requestId, type: "manual_adjustment", availableDeltaCents: write.deltaCents, frozenDeltaCents: 0, occurredAt: 1_800_000_000_000 })), hasNext: false };
      } else if (path === "ledger-adjustments") {
        if (state.role !== "admin") return route.fulfill({ status: 403, json: { ok: false, error: "forbidden" } });
        data = { merchantId: "main-1", adjustments: [{ id: "adjust-1", type: "manual_adjustment", availableDeltaCents: -100, frozenDeltaCents: 0, occurredAt: 1_800_000_000_000, actorId: "受限管理员", reason: "仅管理员可见的调整原因" }], hasNext: false };
      } else {
        return route.fulfill({ status: 404, json: { ok: false, error: "not_found" } });
      }
      return route.fulfill({ json: { ok: true, data } });
    });
    await page.goto("http://127.0.0.1:" + address.port + "/test/fixtures/merchant-console.html");
    await expect(page.getByRole("heading", { name: "商户工作台", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "费率与记录", exact: true }).click();
    await expect(page.getByRole("button", { name: "保存费率", exact: true })).toBeVisible();
    await expect(page.getByText("仅管理员可见的合同说明", { exact: true })).toBeVisible();
    return {
      state, feePanel, pageErrors, close,
      holdSessions: () => { sessionGate = new Promise<void>(resolveGate => { resumeSessions = resolveGate; }); },
      releaseSessions: () => { resumeSessions?.(); sessionGate = undefined; },
      holdDirectory: () => { directoryGate = new Promise<void>(resolveGate => { resumeDirectory = resolveGate; }); },
      releaseDirectory: () => { resumeDirectory?.(); directoryGate = undefined; },
    };
  } catch (error) { await close(); throw error; }
}

async function expectNoAdminControls(page: import("@playwright/test").Page) {
  await expect(page.getByRole("button", { name: "保存费率", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("新费率（%）", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "最近变更", exact: true })).toHaveCount(0);
  await expect(page.getByText("仅管理员可见的合同说明", { exact: true })).toHaveCount(0);
  await expect(page.getByText("操作人 受限管理员", { exact: true })).toHaveCount(0);
}

test("member permission changes refresh immediately and disappear after an administrator downgrade", async ({ page }) => {
  const fixture = await openEditableConsole(page);
  try {
    await page.getByRole("button", { name: "成员权限", exact: true }).click();
    await expect(page.getByText("回归测试成员", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "停用授权", exact: true }).click();
    await expect(page.getByRole("button", { name: "恢复授权", exact: true })).toBeEnabled();
    expect(fixture.state.memberWrites).toEqual([{ action: "set_status", userId: "member-1", enabled: false }]);
    await page.getByLabel("StarMC 账户 ID", { exact: true }).fill("../invalid");
    await page.getByRole("button", { name: "添加成员", exact: true }).click();
    await expect(page.getByText("请输入现有 StarMC 账户的完整 ID。", { exact: true })).toBeVisible();
    expect(fixture.state.memberWrites).toHaveLength(1);
    await page.getByLabel("StarMC 账户 ID", { exact: true }).fill("member-1");
    await page.getByRole("button", { name: "添加成员", exact: true }).click();
    await expect(page.getByRole("button", { name: "停用授权", exact: true })).toBeEnabled();
    expect(fixture.state.memberWrites[1]).toEqual({ action: "grant", userId: "member-1" });
    fixture.state.role = "member";
    await page.getByRole("button", { name: "刷新权限", exact: true }).click();
    await expect(page.getByText("商户成员", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "成员权限", exact: true })).toHaveCount(0);
    await expect(page.getByText("回归测试成员", { exact: true })).toHaveCount(0);
    expect(fixture.state.balanceWrites).toEqual([]);
    expect(fixture.pageErrors).toEqual([]);
  } finally { await fixture.close(); }
});

for (const role of ["owner", "member"] as const) {
  test("permission downgrade removes balance audit details for " + role, async ({ page }) => {
    await page.clock.install();
    const fixture = await openEditableConsole(page);
    try {
      await page.getByRole("button", { name: "余额账本", exact: true }).click();
      await expect(page.getByText("仅管理员可见的调整原因", { exact: true })).toBeVisible();
      await expect(page.getByRole("region", { name: "管理员调整余额", exact: true })).toBeVisible();
      fixture.state.role = role;
      await page.clock.fastForward(16_000);
      const updated = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/epay/access"));
      await page.evaluate(() => {
        for (const visibility of ["hidden", "visible"]) {
          Object.defineProperty(document, "visibilityState", { configurable: true, value: visibility });
          window.dispatchEvent(new Event("visibilitychange"));
        }
      });
      await updated;
      await expect(page.getByText(role === "owner" ? "商户所有者" : "商户成员", { exact: true })).toBeVisible();
      await expect(page.getByRole("region", { name: "管理员余额调整记录" })).toHaveCount(0);
      await expect(page.getByRole("region", { name: "管理员调整余额", exact: true })).toHaveCount(0);
      await expect(page.getByText("仅管理员可见的调整原因", { exact: true })).toHaveCount(0);
      await expect(page.getByText("操作人：受限管理员", { exact: true })).toHaveCount(0);
      expect(fixture.state.writes).toEqual([]);
      expect(fixture.state.balanceWrites).toEqual([]);
      expect(fixture.pageErrors).toEqual([]);
    } finally { await fixture.close(); }
  });

  test("manual permission refresh removes administrator controls and history for " + role, async ({ page }) => {
    const fixture = await openEditableConsole(page);
    try {
      fixture.state.role = role;
      fixture.holdDirectory();
      await page.getByRole("button", { name: "刷新权限", exact: true }).click();
      await expect.poll(() => fixture.state.heldDirectoryReads).toBe(1);
      await expect(page.getByRole("status")).toHaveText("正在核对权限…");
      await expectNoAdminControls(page);
      fixture.releaseDirectory();
      await expect(page.getByText(role === "owner" ? "商户所有者" : "商户成员", { exact: true })).toBeVisible();
      await expectNoAdminControls(page);
      // A role-keyed remount must not merely hide the old panel until it is opened again.
      await page.getByRole("button", { name: "费率与记录", exact: true }).click();
      await expect(fixture.feePanel.getByText("5.00%", { exact: true })).toBeVisible();
      await expectNoAdminControls(page);
      expect(fixture.state.writes).toEqual([]);
      expect(fixture.pageErrors).toEqual([]);
    } finally { await fixture.close(); }
  });

  test("background permission refresh removes administrator controls for " + role + " before session refresh finishes", async ({ page }) => {
    await page.clock.install();
    const fixture = await openEditableConsole(page);
    try {
      fixture.state.role = role;
      fixture.holdSessions();
      // Advance the query freshness window, then simulate returning to this tab without clicking refresh.
      await page.clock.fastForward(16_000);
      const directoryRefresh = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/epay/access"));
      await page.evaluate(() => {
        for (const visibility of ["hidden", "visible"]) {
          Object.defineProperty(document, "visibilityState", { configurable: true, value: visibility });
          window.dispatchEvent(new Event("visibilitychange"));
        }
      });
      expect((await directoryRefresh).status()).toBe(200);
      await expect(page.getByText(role === "owner" ? "商户所有者" : "商户成员", { exact: true })).toBeVisible();
      await expect.poll(() => fixture.state.heldSessionReads).toBeGreaterThan(0);
      await expectNoAdminControls(page);
      await page.getByRole("button", { name: "费率与记录", exact: true }).click();
      await expectNoAdminControls(page);
      fixture.releaseSessions();
      await expect(fixture.feePanel.getByText("5.00%", { exact: true })).toBeVisible();
      await expectNoAdminControls(page);
      expect(fixture.state.writes).toEqual([]);
      expect(fixture.pageErrors).toEqual([]);
    } finally { await fixture.close(); }
  });
}

for (const width of [390, 1280]) {
  test(`balance adjustment refreshes overview and ledger at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const fixture = await openEditableConsole(page);
    try {
      await page.getByRole("button", { name: "余额账本", exact: true }).click();
      await page.getByLabel("金额（元）", { exact: true }).fill("1.23");
      await page.getByLabel("调整原因", { exact: true }).fill("隔离测试扣减");
      await page.getByRole("button", { name: "确认调整", exact: true }).click();
      await expect(page.getByRole("region", { name: "余额概览" }).getByText("¥ 122.22", { exact: true })).toBeVisible();
      await expect(page.getByText("-1.23", { exact: true })).toBeVisible();
      await expect(page.getByLabel("金额（元）", { exact: true })).toHaveValue("");
      expect(fixture.state.balanceWrites).toHaveLength(1);
      expect(fixture.state.balanceWrites[0]).toMatchObject({ expectedVersion: 0, deltaCents: -123, reason: "隔离测试扣减" });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect(fixture.pageErrors).toEqual([]);
    } finally { await fixture.close(); }
  });
}

test("uncertain adjustment keeps its id and expected version after background balance refresh", async ({ page }) => {
  await page.clock.install();
  const fixture = await openEditableConsole(page);
  try {
    await page.getByRole("button", { name: "余额账本", exact: true }).click();
    await page.getByLabel("金额（元）", { exact: true }).fill("1.23");
    await page.getByLabel("调整原因", { exact: true }).fill("隔离测试断网重试");
    fixture.state.loseAdjustmentResponse = true;
    await page.getByRole("button", { name: "确认调整", exact: true }).click();
    await expect(page.getByRole("button", { name: "重试本次调整", exact: true })).toBeVisible();
    const original = { ...fixture.state.balanceWrites[0]! };
    await page.clock.fastForward(16_000);
    const refreshed = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/epay/balance"));
    await page.evaluate(() => {
      for (const visibility of ["hidden", "visible"]) {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: visibility });
        window.dispatchEvent(new Event("visibilitychange"));
      }
    });
    await refreshed;
    await expect(page.getByRole("region", { name: "余额概览" }).getByText("¥ 122.22", { exact: true })).toBeVisible();
    await expect(page.getByLabel("金额（元）", { exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "重试本次调整", exact: true }).click();
    await expect(page.getByLabel("金额（元）", { exact: true })).toHaveValue("");
    expect(fixture.state.balanceWrites).toEqual([original, original]);
    expect(fixture.state.balanceVersion).toBe(1);
    expect(fixture.pageErrors).toEqual([]);
  } finally { await fixture.close(); }
});

test("saving a fee refreshes both the overview and the fee view without manual refresh", async ({ page }) => {
  const fixture = await openEditableConsole(page);
  const overview = page.getByRole("region", { name: "余额概览" });
  try {
    await expect(overview.getByText("5.00%", { exact: true })).toBeVisible();
    await expect(fixture.feePanel.getByText("5.00%", { exact: true })).toBeVisible();
    await page.getByLabel("新费率（%）", { exact: true }).fill("3.50");
    await page.getByLabel("变更原因", { exact: true }).fill("回归测试合同费率调整");
    await page.getByRole("button", { name: "保存费率", exact: true }).click();
    await expect.poll(() => fixture.state.writes.length).toBe(1);
    expect(fixture.state.writes).toEqual([{ expectedFeeBps: 500, expectedVersion: 1, feeBps: 350, reason: "回归测试合同费率调整" }]);
    await expect(fixture.feePanel.getByText("3.50%", { exact: true })).toBeVisible();
    await expect(overview.getByText("3.50%", { exact: true })).toBeVisible();
    await expect(overview.getByText("5.00%", { exact: true })).toHaveCount(0);
    await expect(fixture.feePanel.getByText("5.00%", { exact: true })).toHaveCount(0);
    expect(fixture.pageErrors).toEqual([]);
  } finally { await fixture.close(); }
});
