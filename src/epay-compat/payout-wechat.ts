import { z } from "zod";
import { createWechatPayoutClient, type WechatPayoutClientOptions } from "./payout-wechat-client.ts";
import { createWechatPayoutAuthorization } from "./payout-wechat-authorization.ts";
import { createWechatPayoutOAuth, type WechatPayoutOAuthOptions } from "./payout-wechat-oauth.ts";
import { verifyWechatPayoutQuery } from "./payout-evidence.ts";
import { payoutText, PayoutUnavailable, type PayoutAccess } from "./payout-model.ts";
import type { PayoutAdapter } from "./payout-worker.ts";

type Options = WechatPayoutClientOptions & { enabled?: boolean; sceneId: string; notifyUrl: string; displayName: string; reports: ReadonlyArray<{ info_type: string; info_content: string }>; oauth: WechatPayoutOAuthOptions };
export type WechatPayoutService = ReturnType<typeof createWechatPayoutService>;

export function createWechatPayoutService(options: Options) {
  z.string().regex(/^wx[A-Za-z0-9]{16}$/).parse(options.appId); z.string().regex(/^\d{6,32}$/).parse(options.payer);
  payoutText(36).parse(options.sceneId); payoutText(32).parse(options.displayName);
  z.array(z.object({ info_type: payoutText(32), info_content: payoutText(128) }).strict()).min(1).max(10).parse(options.reports);
  const notify = new URL(options.notifyUrl);
  if (notify.protocol !== "https:" || notify.search || notify.hash || notify.username || notify.password || options.notifyUrl.length > 256) throw new Error("invalid WeChat authorization callback");
  const clock = options.clock ?? Date.now, enabled = options.enabled === true, client = createWechatPayoutClient(options);
  const authorization = createWechatPayoutAuthorization({ ...options, client, clock });
  const oauth = createWechatPayoutOAuth({ ...options, enabled, clock });
  const adapter: PayoutAdapter = { payer: options.payer,
    async prepare(accountId, merchantId, signal) {
      if (!enabled) throw new PayoutUnavailable("WeChat payout unavailable");
      await authorization.requireActive(accountId, merchantId, signal);
    },
    async execute(lease, destination, signal) {
    if (lease.channel !== "wechat" || destination.kind !== "wechat" || lease.payer !== options.payer || destination.appId !== options.appId || !/^[a-f0-9]{32}$/.test(lease.outNo)) throw new PayoutUnavailable("WeChat payout identity unavailable");
    if (lease.action === "SUBMIT") {
      if (!enabled) throw new PayoutUnavailable("WeChat payout unavailable");
      const grant = await authorization.requireActive(lease.accountId, lease.merchantId, signal);
      if (grant.destination.account !== destination.account || grant.destination.holderName !== destination.holderName || grant.destination.appId !== destination.appId) throw new Error("WeChat payout recipient differs from authorized identity");
      const accepted = await client.request("POST", "/v3/fund-app/mch-transfer/transfer-bills/transfer", { appid: options.appId, out_bill_no: lease.outNo, transfer_scene_id: options.sceneId,
        user_name: client.encryptName(destination.holderName), transfer_amount: lease.amountCents, transfer_remark: "StarPAY 商户结算", authorization_id: grant.authorizationId, transfer_scene_report_infos: options.reports }, signal);
      if (accepted.fields.out_bill_no !== lease.outNo) throw new Error("WeChat transfer response requires original-order query");
    }
    const reply = await client.request("GET", `/v3/fund-app/mch-transfer/transfer-bills/out-bill-no/${lease.outNo}`, undefined, signal);
    return verifyWechatPayoutQuery(lease, destination, reply.bytes, reply.headers, client.credential(), reply.now);
  } };
  return { enabled, adapter, beginBinding: oauth.begin, completeBinding: oauth.complete, status: authorization.status, notify: authorization.notify,
    authorize(access: PayoutAccess, accountId: string) { if (!enabled) return Promise.reject(new PayoutUnavailable("WeChat authorization unavailable")); return authorization.authorize(access, accountId); } };
}
