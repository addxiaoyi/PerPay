import type { KeyObject } from "node:crypto";
import { parseStrictJson } from "../http/strict-json.ts";
import { getHeader } from "../infrastructure/alipay/errors.ts";
import { signV3Request, verifyV3Response } from "../infrastructure/alipay/v3.ts";
import type { V3Transport } from "../infrastructure/alipay/types.ts";
import { alipaySigningFingerprint } from "./isolated-alipay-client.ts";
import { requireAlipayQueryAccount, type AlipayQueryAccount } from "./alipay-query-account.ts";
import { verifyAlipayPayoutQuery } from "./payout-evidence.ts";
import type { PayoutAdapter } from "./payout-worker.ts";
import { PayoutUnavailable } from "./payout-model.ts";

type Options = {
  account: AlipayQueryAccount; privateKey: string | KeyObject; platformPublicKey: string; appCertSn: string; alipayRootCertSn: string;
  sceneName: string; sceneReports: ReadonlyArray<{ info_type: string; info_content: string }>;
  transport: V3Transport; enabled?: boolean; clock?: () => number;
};

// This adapter is not registered by the production runtime until transfer permission and end-to-end acceptance are verified.
export function createAlipayPayoutAdapter(options: Options): PayoutAdapter {
  const clock = options.clock ?? Date.now;
  return { payer: options.account.sellerId, execute: async (lease, destination, signal) => {
    if ((!options.enabled && lease.action === "SUBMIT") || lease.channel !== "alipay" || destination.kind !== "alipay" || lease.payer !== options.account.sellerId) throw new PayoutUnavailable("Alipay payout channel unavailable");
    if (lease.amountCents < 10 || !options.appCertSn || !options.alipayRootCertSn || !options.sceneName || options.sceneReports.length === 0 || options.sceneReports.some(entry => !entry.info_type || !entry.info_content)) throw new Error("Alipay payout product configuration is incomplete");
    const fingerprint = alipaySigningFingerprint(options.privateKey);
    if (options.account.signingFingerprint !== fingerprint) throw new Error("Alipay payout signer differs");
    requireAlipayQueryAccount(options.account, { appId: options.account.appId, sellerId: lease.payer, platformPublicKey: options.platformPublicKey }, clock());
    const signer = { appId: options.account.appId, privateKey: options.privateKey, appCertSn: options.appCertSn, alipayRootCertSn: options.alipayRootCertSn, clock };
    if (lease.action === "SUBMIT") {
      const amount = `${Math.floor(lease.amountCents / 100)}.${String(lease.amountCents % 100).padStart(2, "0")}`;
      const request = signV3Request({ method: "POST", path: "/v3/alipay/fund/trans/uni/transfer", body: JSON.stringify({ out_biz_no: lease.outNo, trans_amount: amount,
        product_code: "TRANS_ACCOUNT_NO_PWD", biz_scene: "DIRECT_TRANSFER", order_title: "StarPAY 商户提现",
        payee_info: { identity_type: "ALIPAY_LOGON_ID", identity: destination.account, name: destination.holderName },
        transfer_scene_name: options.sceneName, transfer_scene_report_infos: options.sceneReports }) }, signer);
      const accepted = verifyV3Response(await options.transport.request(request, { timeoutMilliseconds: 10_000, signal }), options.platformPublicKey);
      const signedAt = Number(getHeader(accepted.headers, "alipay-timestamp"));
      const timestamp = signedAt < 100_000_000_000 ? signedAt * 1000 : signedAt;
      const fields = parseStrictJson(accepted.bodyBytes) as Record<string, unknown> | null;
      if (accepted.status !== 200 || !Number.isSafeInteger(timestamp) || Math.abs(clock() - timestamp) > 300_000 || !fields || fields.out_biz_no !== lease.outNo) throw new Error("Alipay transfer result requires original-order query");
    }
    const query = signV3Request({ method: "GET", path: "/v3/alipay/fund/trans/common/query", query: { product_code: "TRANS_ACCOUNT_NO_PWD", biz_scene: "DIRECT_TRANSFER", out_biz_no: lease.outNo } }, signer);
    const response = await options.transport.request(query, { timeoutMilliseconds: 10_000, signal });
    return verifyAlipayPayoutQuery(lease, destination, response, options.account, options.platformPublicKey, clock());
  } };
}
