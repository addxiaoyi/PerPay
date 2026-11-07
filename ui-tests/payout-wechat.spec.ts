import { test, expect } from "@playwright/test";
import { serve } from "@hono/node-server";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/http/app.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { createConfiguredHttpServices } from "../test/http-fixture.ts";
import { registerWechatCredential } from "../src/epay-compat/wechat-credentials.ts";
import { registerWechatSigningKey } from "../src/epay-compat/wechat-signing-keys.ts";
import { createWechatPayoutService } from "../src/epay-compat/payout-wechat.ts";
import { reviewPayoutAccount } from "../src/epay-compat/payout-accounts.ts";

for (const width of [390, 1280]) test(`WeChat binding and confirmation use isolated real routes at ${width}px`, async ({ page }) => {
  const directory = mkdtempSync(join(tmpdir(), "starpay-wechat-payout-ui-"));
  let app: ReturnType<typeof createApp> | undefined, role = "owner", outNo = "", grant = "WAIT_USER_CONFIRM", requests = 0;
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: request => app ? app.fetch(request) : new Response(null, { status: 503 }) });
  let services: Awaited<ReturnType<typeof createConfiguredHttpServices>> | undefined;
  try {
    if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture unavailable");
    const origin = `http://127.0.0.1:${address.port}`;
    services = await createConfiguredHttpServices({ directory, publicUrl: origin, apiSecret: null, collectionCodePayload: "https://qr.alipay.com/test" });
    const database = services.database, masterKey = services.config.masterKey, cipher = new RuntimeSecretCipher(masterKey, database.instanceId());
    database.write(sql => sql.exec("INSERT INTO epay_merchant_accounts VALUES(1,'隔离商户',0,1,500,0,0); INSERT INTO epay_merchant_bindings VALUES('binding','api-1','main-1',1,0,0)"));
    const platform = generateKeyPairSync("rsa", { modulusLength: 2048 }), merchant = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const now = Date.now(), appId = "wx1234567890123456", payer = "1234567890", openid = "openid-isolated-recipient";
    registerWechatCredential(database, masterKey, { id: "platform", appId, merchantId: payer, platformKey: platform.publicKey.export({ type: "spki", format: "pem" }).toString(), platformKeyId: "platform", apiV3Key: "x".repeat(32), validFrom: now - 1000, validUntil: now + 86400000, actor: "fixture" }, now);
    registerWechatSigningKey(database, masterKey, { id: "signer", appId, merchantId: payer, serial: "merchant", privateKey: merchant.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKey: merchant.publicKey.export({ type: "spki", format: "pem" }).toString(), validFrom: now - 1000, validUntil: now + 86400000, actor: "fixture" }, now);
    const transport: typeof fetch = async (input, init) => {
      const url = new URL(String(input)); requests++;
      if (url.hostname === "api.weixin.qq.com") return Response.json({ openid, access_token: "fixture-token", scope: "snsapi_base" });
      if (url.pathname.endsWith("/user-confirm-authorization")) outNo = JSON.parse(String(init?.body)).out_authorization_no;
      const body = JSON.stringify({ out_authorization_no: outNo, appid: appId, openid, transfer_scene_id: "fixture", state: grant,
        ...(grant === "TAKING_EFFECT" ? { authorization_id: "synthetic-grant" } : { package_info: "synthetic-package" }) });
      const timestamp = String(Math.floor(Date.now() / 1000));
      return new Response(body, { headers: { "content-type": "application/json", "wechatpay-serial": "platform", "wechatpay-timestamp": timestamp, "wechatpay-nonce": "fixture",
        "wechatpay-signature": sign("RSA-SHA256", Buffer.from(`${timestamp}\nfixture\n${body}\n`), platform.privateKey).toString("base64") } });
    };
    const wechat = createWechatPayoutService({ database, cipher, appId, payer, credentialId: "platform", signingKeyId: "signer", sceneId: "fixture", notifyUrl: "https://gateway.example/pay/api/merchant/epay/payouts/wechat/notify", displayName: "StarPAY", reports: [{ info_type: "fixture", info_content: "synthetic" }], enabled: true, transport,
      oauth: { appSecret: "fixture-secret", returnUrl: "https://gateway.example/pay/merchant/payouts", transport } });
    const identityFetch: typeof fetch = async (input, init) => {
      if (new Headers(init?.headers).get("cookie") !== "main_session=fixture") return Response.json({ ok: false }, { status: 401 });
      if (new URL(String(input)).searchParams.get("merchantId") !== "main-1") return Response.json({ ok: false }, { status: 403 });
      return Response.json({ ok: true, merchantId: "main-1", apiId: "api-1", userId: `fixture-${role}`, role });
    };
    app = createApp({ ...services, config: { ...services.config, basePath: "/pay", epayGateway: { mode: "live", callbackDelivery: false } }, merchantWorkspace: { identityOrigin: "http://127.0.0.1:8787", identityFetch }, payouts: { wechat }, startedAt: new Date() });
    const owner = { merchantId: "main-1", mainApiId: "api-1", epayMerchantId: 1, userId: "fixture-owner", role: "owner" as const };
    const binding = wechat.beginBinding(owner, "main_session=fixture", "合成用户"), state = new URL(binding.url).searchParams.get("state")!;
    await page.context().addCookies([{ name: "main_session", value: "fixture", url: origin }]); await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}/pay/merchant/payouts?merchantId=main-1&code=synthetic-code&state=${state}`);
    await page.getByRole("button", { name: "完成微信绑定", exact: true }).click();
    await expect(page.getByText("微信身份已核验，请等待收款账户审核。", { exact: true })).toBeVisible();
    await expect(page).not.toHaveURL(/code=|state=/);
    const accountId = database.read(sql => String(sql.prepare("SELECT account_id FROM epay_wechat_payout_identities").get()?.account_id));
    reviewPayoutAccount(database, { ...owner, role: "admin", userId: "fixture-admin" }, accountId, { decision: "approve", reference: "synthetic" }, Date.now());
    await page.reload();
    await page.getByRole("button", { name: "确认或刷新微信授权", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "请使用微信打开" })).toBeVisible();
    await page.exposeFunction("confirmSyntheticGrant", () => { grant = "TAKING_EFFECT"; });
    await page.evaluate(() => {
      const fixture = window as Window & { confirmSyntheticGrant?: () => Promise<void>; WeixinJSBridge?: { invoke: (name: string, fields: unknown, callback: (reply: { err_msg: string }) => void) => void } };
      fixture.WeixinJSBridge = { invoke(name, _fields, callback) { void fixture.confirmSyntheticGrant!().then(() => callback({ err_msg: `${name}:ok` })); } };
    });
    await page.getByRole("button", { name: "确认或刷新微信授权", exact: true }).click();
    await expect(page.getByText("微信收款授权已生效", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole("heading", { name: "提现日终核对", exact: true })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(openid);
    role = "member"; await page.reload();
    await expect(page.getByRole("button", { name: "确认或刷新微信授权", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "前往微信验证身份", exact: true })).toHaveCount(0);
    role = "admin"; await page.goto(`${origin}/pay/admin/merchants/main-1/payouts`);
    await expect(page.getByRole("heading", { name: "提现日终核对", exact: true })).toBeVisible();
    await expect(page.getByText("暂无本商户的提现核对记录。", { exact: true })).toBeVisible();
    expect(requests).toBeGreaterThan(2);
    expect(Number(database.read(sql => sql.prepare("SELECT count(*) n FROM epay_payouts").get()?.n))).toBe(0);
    expect(Number(database.read(sql => sql.prepare("SELECT count(*) n FROM epay_balance_ledger").get()?.n))).toBe(0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    services?.database.close(); rmSync(directory, { recursive: true, force: true });
  }
});
