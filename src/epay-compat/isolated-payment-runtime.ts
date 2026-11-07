import { createIsolatedAlipayCallbackRoute } from "./alipay-callback-route.ts";
import { createIsolatedAlipayMAPI } from "./isolated-alipay-mapi.ts";
import { createIsolatedGatewayRuntime } from "./isolated-gateway-runtime.ts";
import { createIsolatedWechatMAPI } from "./isolated-wechat-mapi.ts";
import { createWechatCallbackRoute } from "./wechat-callback-route.ts";
import { createIsolatedCheckoutStatus } from "./isolated-checkout-status.ts";
import { createIsolatedEPayQuery } from "./isolated-api-query.ts";

type RuntimeOptions = Parameters<typeof createIsolatedGatewayRuntime>[0];
type AlipayOptions = Parameters<typeof createIsolatedAlipayMAPI>[0];
type WechatOptions = Parameters<typeof createIsolatedWechatMAPI>[0];

export function validateGatewayCallbackUrls(alipayUrl: string, wechatUrl: string): void {
  const parse = (value: string, suffix: string) => {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error("invalid gateway callback URL"); }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || value.length > 255 || /[\x00-\x20\x7f]/.test(value) || url.pathname.includes("%") || !url.pathname.endsWith(suffix)) {
      throw new Error("gateway callback URL does not match its route");
    }
    return { origin: url.origin, prefix: url.pathname.slice(0, -suffix.length) };
  };
  const alipay = parse(alipayUrl, "/alipay/notify");
  const wechat = parse(wechatUrl, "/wechat/notify");
  if (alipay.origin !== wechat.origin || alipay.prefix !== wechat.prefix || alipay.prefix.includes("//") || alipay.prefix.endsWith("/")) throw new Error("gateway callback routes do not share an origin and prefix");
}

// This assembly has no listener or production mount; all transports remain caller supplied.
export function createIsolatedPaymentRuntime(options: {
  database: RuntimeOptions["database"];
  masterKey: Uint8Array;
  clock?: () => number;
  alipay: Omit<AlipayOptions, "database" | "masterKey" | "clock">;
  wechat: Omit<WechatOptions, "database" | "masterKey" | "clock">;
  callbackTransport: RuntimeOptions["transport"];
  scheduler: RuntimeOptions["scheduler"];
}) {
  validateGatewayCallbackUrls(options.alipay.notifyUrl, options.wechat.notifyUrl);
  const shared = { database: options.database, masterKey: options.masterKey, ...(options.clock ? { clock: options.clock } : {}) };
  return createIsolatedGatewayRuntime({
    ...shared,
    gateway: {
      alipay: createIsolatedAlipayMAPI({ ...options.alipay, ...shared }),
      wechat: createIsolatedWechatMAPI({ ...options.wechat, ...shared }),
      alipayCallback: createIsolatedAlipayCallbackRoute(options.database, options.clock),
      wechatCallback: createWechatCallbackRoute(options.database, options.masterKey, options.clock),
      checkoutStatus: createIsolatedCheckoutStatus(options.database, options.masterKey, options.clock),
      apiQuery: createIsolatedEPayQuery(shared),
    },
    transport: options.callbackTransport,
    scheduler: options.scheduler,
  });
}
