import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { Hono, type Env } from "hono";
import type { AppConfig } from "../config.ts";
import type { AppDatabase } from "../database/database.ts";
import { NodeV3Transport } from "../infrastructure/alipay/node-transport.ts";
import { NodeWebhookTransport } from "../notifications/transport.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { readEncryptedChannelConfig } from "./channel-config.ts";
import { createIsolatedAlipayCallbackRoute } from "./alipay-callback-route.ts";
import { createIsolatedAlipayMAPI } from "./isolated-alipay-mapi.ts";
import { createIsolatedEPayQuery } from "./isolated-api-query.ts";
import { createIsolatedCheckoutStatus } from "./isolated-checkout-status.ts";
import { createIsolatedGatewayRuntime } from "./isolated-gateway-runtime.ts";
import { createIsolatedWechatMAPI } from "./isolated-wechat-mapi.ts";
import { createWechatCallbackRoute } from "./wechat-callback-route.ts";
import { hasVerifiedCutoverManifest } from "./cutover-manifest.ts";
import { inspectEPayReadiness } from "./gateway-readiness.ts";
import { createSourceSyncRoute } from "./source-sync-route.ts";
import { EPayPaymentQueryScheduler } from "./payment-query-scheduler.ts";
import { queryAndConfirmAlipaySubmission } from "./isolated-alipay-query.ts";
import { queryOrCloseExpiredWechat } from "./wechat-close.ts";
import { createMainOrderRoutes } from "./main-order-routes.ts";
import { verifyAlipayQueryAccount } from "./alipay-query-account.ts";
import { EPayRefundScheduler } from "./refund-scheduler.ts";
import { processNativeRefund } from "./refund-provider.ts";
import { auditNativeRefunds } from "./refund-audit.ts";
import { createAlipayWebGateway, createAlipayWebReturn } from "./alipay-web-route.ts";
import { readEPayParams } from "./shadow-gateway.ts";

type Database = Pick<AppDatabase, "read" | "write" | "instanceId">;
type GatewayConfig = NonNullable<AppConfig["epayGateway"]>;
type GatewayRuntime = ReturnType<typeof createIsolatedGatewayRuntime>;

export function createEPayRuntime(options: {
  database: Database;
  masterKey: Uint8Array;
  config: GatewayConfig;
  publicOrigin: string;
  basePath: string;
  identityOrigin?: string | undefined;
  onError: (code: string) => void;
}) {
  const { database, masterKey, config } = options;
  if (config.mode === "live" && !database.read(hasVerifiedCutoverManifest)) throw new Error("EPay live mode requires a verified cutover manifest");
  const configurationStatus = () => inspectEPayReadiness(database, masterKey, config);
  const startupHealth = configurationStatus();
  // A failed legacy reader must not prevent recovery of callbacks for native orders.
  if (config.mode === "live" && startupHealth.status !== "ready" && startupHealth.code !== "epay_source_sync_unavailable") throw new Error("EPay live mode requires configured channels and accepting merchants");
  const callbackRoot = `${options.publicOrigin}${options.basePath === "/" ? "" : options.basePath}/epay`;
  const shared = { database, masterKey };
  const signer = config.alipayChannelId === undefined ? null : readAlipaySigner(database, masterKey, config.alipayChannelId, config.alipayCertificateFile);
  if (config.mode === "live" && signer && !signer.account) throw new Error("EPay live Alipay queries require a pinned account certificate");
  const alipay = config.alipayChannelId === undefined ? unavailableChannel() :
    createIsolatedAlipayMAPI({ ...shared, ...signer!, notifyUrl: `${callbackRoot}/alipay/notify`, transport: new NodeV3Transport() });
  const alipayWeb = signer?.account ? createAlipayWebGateway({ ...shared, ...signer, account: signer.account,
    notifyUrl: `${callbackRoot}/alipay/notify`, returnBase: `${callbackRoot}/alipay/return` }, signer.product === "wap" ? "wap" : "pc") : undefined;
  const alipayEntry = alipayWeb && ["pc", "wap"].includes(signer?.product ?? "") ? new Hono().all("*", async context => {
    let existingQr = false;
    try {
      const fields = await readEPayParams(context.req.raw.clone());
      if (/^[1-9]\d{0,14}$/.test(fields.pid ?? "") && fields.out_trade_no) existingQr = database.read(sql => Boolean(sql.prepare(`SELECT 1 FROM epay_orders o
        JOIN epay_alipay_submissions s ON s.trade_no=o.trade_no WHERE o.merchant_id=? AND o.out_trade_no=?
        AND NOT EXISTS(SELECT 1 FROM epay_alipay_web_orders w WHERE w.trade_no=o.trade_no)`).get(Number(fields.pid), fields.out_trade_no!)));
    } catch { return context.json({ code: -1, msg: "订单请求格式无效。" }, 400); }
    return (existingQr ? alipay : alipayWeb).fetch(context.req.raw);
  }) : alipay;
  const wechat = !config.wechatCredentialId || !config.wechatSigningKeyId ? unavailableChannel() :
    createIsolatedWechatMAPI({ ...shared, credentialId: config.wechatCredentialId, signingKeyId: config.wechatSigningKeyId, notifyUrl: `${callbackRoot}/wechat/notify`, transport: fetch });
  let bridgeSecret: string | undefined;
  if (config.mainBridgeSecretFile) {
    bridgeSecret = readFileSync(config.mainBridgeSecretFile, "utf8").trim();
    if (!bridgeSecret || bridgeSecret.length > 4096 || /[\x00-\x20\x7f]/.test(bridgeSecret)) throw new Error("main merchant bridge secret is invalid");
  }
  const mainOrders = options.identityOrigin ? createMainOrderRoutes({ ...shared, identityOrigin: options.identityOrigin, publicOrigin: options.publicOrigin,
    basePath: options.basePath, bridgeSecret, alipay, alipayWeb, wechat, wechatCredentialId: config.wechatCredentialId, onError: options.onError,
    alipayScanEnabled: Boolean(signer && !["pc", "wap"].includes(signer.product)),
    invoiceFeeCents: config.invoiceFeeCents, canRequestInvoice: () => config.invoiceEnabled === true && config.mode === "live" && configurationStatus().status === "ready" }) : undefined;
  const runtime = createIsolatedGatewayRuntime({
    ...shared,
    ...(mainOrders ? { mainOrders } : {}),
    admitOrder: () => config.mode === "live" && configurationStatus().status === "ready",
    gateway: {
      alipay: alipayEntry, wechat,
      alipayCallback: createIsolatedAlipayCallbackRoute(database),
      wechatCallback: createWechatCallbackRoute(database, masterKey),
      checkoutStatus: createIsolatedCheckoutStatus(database, masterKey),
      apiQuery: createIsolatedEPayQuery({ ...shared, allowActions: () => config.mode === "live" }),
    },
    transport: origin => new NodeWebhookTransport(origin),
    scheduler: {
      intervalMilliseconds: 5_000,
      maximumPerRun: 20,
      policy: { timeoutMilliseconds: 10_000, leaseMilliseconds: 30_000, maximumAttempts: 12, retryDelayMilliseconds: 30_000 },
      onError: () => options.onError("epay_callback_scheduler_failed"),
    },
  });
  runtime.app.route("/", createSourceSyncRoute({ database, masterKey, onError: options.onError }));
  runtime.app.route("/", createAlipayWebReturn(shared, options.basePath));
  const queries = new EPayPaymentQueryScheduler({ database, intervalMilliseconds: 5_000, maximumPerRun: 5, onError: options.onError, query: {
    alipay: tradeNo => {
      if (!signer) return Promise.reject(new Error("Alipay query channel unavailable"));
      return queryAndConfirmAlipaySubmission({ database, tradeNo, ...signer, transport: new NodeV3Transport(), absentOrderExpiry: { masterKey, instanceId: database.instanceId() } });
    },
    wxpay: tradeNo => {
      if (!config.wechatSigningKeyId) return Promise.reject(new Error("WeChat query channel unavailable"));
      return queryOrCloseExpiredWechat({ ...shared, tradeNo, signingKeyId: config.wechatSigningKeyId, transport: fetch });
    },
  } });
  const refunds = new EPayRefundScheduler({ database, onError: options.onError, process: lease => processNativeRefund({ ...shared,
    ...(signer?.account ? { alipay: { ...signer, account: signer.account, transport: new NodeV3Transport() } } : {}),
    ...(config.wechatSigningKeyId ? { wechat: { signingKeyId: config.wechatSigningKeyId, transport: fetch } } : {}) }, lease) });
  // Quiescing is synchronous up to the returned drain promise, before a listener can start.
  if (config.mode === "maintenance") void runtime.quiesceOrders();
  const readiness = () => {
    const configured = configurationStatus();
    if (configured.status !== "ready") return configured;
    const admission = runtime.admission();
    if (!admission.acceptingRequests || !admission.acceptingOrders) return { ...configured, status: "not_ready" as const, code: "epay_draining" };
    const scheduler = runtime.health();
    if (scheduler.state !== "running" || scheduler.consecutiveFailures > 0) return { ...configured, status: "not_ready" as const, code: "epay_callbacks_unavailable" };
    if (queries.health().state !== "running") return { ...configured, status: "not_ready" as const, code: "epay_payment_queries_unavailable" };
    if (refunds.health().state !== "running" || database.read(auditNativeRefunds).inconsistent > 0) return { ...configured, status: "not_ready" as const, code: "epay_refunds_unavailable" };
    return configured;
  };
  runtime.app.get("/readyz", context => {
    context.header("Cache-Control", "no-store");
    try {
      const health = readiness();
      return context.json(health, health.status === "ready" ? 200 : 503);
    } catch {
      options.onError("epay_readiness_failed");
      return context.json({ status: "not_ready", code: "epay_readiness_failed" }, 503);
    }
  });
  return {
    ...runtime,
    readiness,
    queryHealth: () => queries.health(),
    refundHealth: () => refunds.health(),
    start: async () => {
      if (!config.callbackDelivery) return 0;
      const processed = await runtime.start();
      await queries.start();
      await refunds.start();
      return processed;
    },
    stop: async () => {
      const stopped = await Promise.allSettled([runtime.stop(), queries.stop(), refunds.stop()]);
      const failures = stopped.filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(entry => entry.reason), "EPay gateway stop failed");
    },
    close: async () => {
      const closed = await Promise.allSettled([runtime.close(), queries.stop(), refunds.stop()]);
      const failures = closed.filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(entry => entry.reason), "EPay gateway close failed");
    },
  };
}

export function mountEPayGateway<E extends Env>(app: Hono<E, {}, string>, gateway: Pick<GatewayRuntime, "app">, basePath: string): void {
  const prefix = `${basePath === "/" ? "" : basePath}/epay`;
  for (const endpoint of ["submit.php", "mapi.php", "api.php"]) app.on(["GET", "POST"], `/${endpoint}`, context => {
    const url = new URL(context.req.url);
    url.pathname = `/${endpoint}`;
    return gateway.app.fetch(new Request(url, context.req.raw));
  });
  app.on(["GET", "POST"], "/api/merchant/orders", context => {
    const url = new URL(context.req.url);
    url.pathname = "/main/orders";
    return gateway.app.fetch(new Request(url, context.req.raw));
  });
  app.all("/api/payment/:kind{checkout|order|receipt|invoice}/:id", context => {
    const url = new URL(context.req.url);
    url.pathname = `/main/payment/${context.req.param("kind")}/${context.req.param("id")}`;
    return gateway.app.fetch(new Request(url, context.req.raw));
  });
  app.all("/epay/*", context => {
    const url = new URL(context.req.url);
    url.pathname = url.pathname.slice(prefix.length);
    // A fresh subrequest keeps submit.php mode and admission checks independent of deployment prefix.
    return gateway.app.fetch(new Request(url, context.req.raw));
  });
}

function unavailableChannel(): Hono {
  return new Hono().all("*", context => context.json({ code: -1, msg: "支付通道暂不可用" }, 503));
}

function readAlipaySigner(database: Database, key: Uint8Array, channelId: number, certificateFile?: string) {
  const cipher = new RuntimeSecretCipher(key, database.instanceId());
  return database.read(db => {
    const channel = db.prepare("SELECT provider,enabled,product FROM epay_channels WHERE channel_id=?").get(channelId);
    if (channel?.provider !== "ALIPAY" || Number(channel.enabled) !== 1) throw new Error("EPay Alipay channel is disabled or missing");
    const raw = readEncryptedChannelConfig(db, cipher, channelId);
    const config: unknown = raw === null ? null : JSON.parse(raw);
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("EPay Alipay configuration is missing");
    const fields = config as Record<string, unknown>;
    if (typeof fields.privateKey !== "string" || !fields.privateKey) throw new Error("EPay Alipay signing key is missing");
    const privateKey = createPrivateKey(fields.privateKey);
    if (privateKey.asymmetricKeyType !== "rsa" || (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error("EPay Alipay signing key is invalid");
    const appCertSn = serial(fields.appCertSn);
    const alipayRootCertSn = serial(fields.rootCertSn);
    const accounts = certificateFile ? db.prepare("SELECT DISTINCT app_id,seller_id,platform_public_key FROM epay_alipay_bindings").all() : [];
    const marker = certificateFile ? db.prepare("SELECT value FROM system_metadata WHERE key='epay_configured_channels'").get() : undefined;
    const pinned = marker ? JSON.parse(String(marker.value)) as { certificateSha256: string; alipayChannelId: number } : null;
    if (certificateFile && (accounts.length !== 1 || !pinned || pinned.alipayChannelId !== channelId || accounts[0]?.app_id !== fields.appId)) throw new Error("Alipay certificate provisioning identity is unavailable");
    const account = certificateFile ? verifyAlipayQueryAccount({ appId: String(accounts[0]!.app_id), sellerId: String(accounts[0]!.seller_id),
      platformPublicKey: String(accounts[0]!.platform_public_key), privateKey, certificate: readFileSync(certificateFile, "utf8"), certificateSha256: pinned!.certificateSha256 }, Date.now()) : undefined;
    return { privateKey, product: String(channel.product), ...(account ? { account } : {}), ...(appCertSn ? { appCertSn } : {}), ...(alipayRootCertSn ? { alipayRootCertSn } : {}) };
  });
}

function serial(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^[a-fA-F0-9_]{32,512}$/.test(value)) throw new Error("EPay Alipay certificate serial is invalid");
  return value;
}
