import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { RuntimeSecretCipher } from "../settings/crypto.ts";
import { readBoundedBody } from "./main-order-auth.ts";
import { addPayoutAccount } from "./payout-accounts.ts";
import { payoutAccess, payoutText, payoutTime, PayoutConflict, PayoutUnavailable, type PayoutAccess, type PayoutDatabase } from "./payout-model.ts";
import { wechatFields } from "./payout-wechat-client.ts";

export type WechatPayoutOAuthOptions = { appSecret: string; returnUrl: string; transport: typeof fetch };
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export function createWechatPayoutOAuth(options: { database: PayoutDatabase; cipher: RuntimeSecretCipher; appId: string; enabled: boolean; oauth: WechatPayoutOAuthOptions; clock: () => number }) {
  const target = new URL(options.oauth.returnUrl);
  if (target.protocol !== "https:" || target.username || target.password || target.search || target.hash || !options.oauth.appSecret) throw new Error("invalid WeChat OAuth configuration");
  return {
    begin(access: PayoutAccess, cookie: string, name: unknown) {
      if (!options.enabled) throw new PayoutUnavailable("WeChat authorization unavailable");
      const holder = payoutText(100).parse(name), state = randomBytes(24).toString("hex"), now = options.clock(); payoutTime(now);
      if (!cookie || cookie.length > 8192) throw new PayoutConflict("invalid OAuth binding session");
      options.database.write(sql => {
        payoutAccess(sql, access, "owner");
        const recent = Number(sql.prepare("SELECT count(*) n FROM epay_wechat_payout_oauth WHERE owner_id=? AND created_at>?").get(access.userId!, now - 600000)?.n);
        if (recent >= 10) throw new PayoutConflict("too many OAuth binding attempts");
        const sealed = options.cipher.encrypt(`epay:config:payout-oauth:${digest(state)}`, 1, holder);
        sql.prepare("INSERT INTO epay_wechat_payout_oauth VALUES(?,?,?,?,?,?,?,?,?,?,NULL)").run(digest(state), access.epayMerchantId, access.userId!, digest(cookie), options.appId, sealed.nonce, sealed.ciphertext, sealed.authenticationTag, now, now + 600000);
      });
      const redirect = new URL(target); redirect.searchParams.set("merchantId", access.merchantId);
      const url = new URL("https://open.weixin.qq.com/connect/oauth2/authorize");
      url.search = new URLSearchParams({ appid: options.appId, redirect_uri: redirect.href, response_type: "code", scope: "snsapi_base", state }).toString(); url.hash = "wechat_redirect";
      return { url: url.href };
    },
    async complete(access: PayoutAccess, cookie: string, state: string, code: string, reauthenticate?: () => Promise<PayoutAccess>) {
      if (!options.enabled) throw new PayoutUnavailable("WeChat authorization unavailable");
      z.string().regex(/^[a-f0-9]{48}$/).parse(state); z.string().regex(/^[A-Za-z0-9_-]{1,256}$/).parse(code);
      const now = options.clock(); payoutTime(now);
      const row = options.database.write(sql => {
        payoutAccess(sql, access, "owner");
        const found = sql.prepare(`SELECT * FROM epay_wechat_payout_oauth WHERE state_hash=? AND owner_id=? AND merchant_id=? AND cookie_hash=? AND app_id=? AND consumed_at IS NULL AND created_at<=? AND expires_at>?`)
          .get(digest(state), access.userId!, access.epayMerchantId, digest(cookie), options.appId, now, now);
        if (!found) throw new PayoutConflict("OAuth binding expired, consumed or belongs to another session");
        sql.prepare("UPDATE epay_wechat_payout_oauth SET consumed_at=? WHERE state_hash=?").run(now, digest(state));
        return found;
      });
      // Consume state before exchange. A lost code response requires a fresh OAuth round trip, never a guessed OpenID.
      const url = new URL("https://api.weixin.qq.com/sns/oauth2/access_token");
      url.search = new URLSearchParams({ appid: options.appId, secret: options.oauth.appSecret, code, grant_type: "authorization_code" }).toString();
      const response = await options.oauth.transport(url, { method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10000) });
      const fields = wechatFields(await readBoundedBody(response.body, 8192));
      if (response.status !== 200 || fields.errcode || typeof fields.openid !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(fields.openid) || typeof fields.access_token !== "string" || !fields.access_token || typeof fields.scope !== "string" || !fields.scope.split(",").includes("snsapi_base")) throw new Error("WeChat OAuth identity could not be verified");
      const verifiedAt = options.clock();
      if (verifiedAt < now || verifiedAt >= Number(row.expires_at)) throw new PayoutConflict("OAuth binding expired");
      const current = reauthenticate ? await reauthenticate() : access;
      if (current.userId !== access.userId || current.epayMerchantId !== access.epayMerchantId || current.merchantId !== access.merchantId || current.mainApiId !== access.mainApiId) throw new PayoutConflict("OAuth binding session changed");
      return options.database.write(sql => {
        payoutAccess(sql, current, "owner");
        const transaction: PayoutDatabase = { read: operation => operation(sql), write: operation => operation(sql) };
        const name = options.cipher.decrypt(`epay:config:payout-oauth:${digest(state)}`, 1, { cipherVersion: 1, nonce: Buffer.from(row.nonce as Uint8Array), ciphertext: Buffer.from(row.ciphertext as Uint8Array), authenticationTag: Buffer.from(row.authentication_tag as Uint8Array) });
        let account: ReturnType<typeof addPayoutAccount>;
        try { account = addPayoutAccount(transaction, options.cipher, access, { requestId: `wx-${state}`, kind: "wechat", appId: options.appId, account: fields.openid, holderName: name.toString("utf8") }, verifiedAt); }
        finally { name.fill(0); }
        sql.prepare("INSERT INTO epay_wechat_payout_identities VALUES(?,?,?,?,?)").run(account.id, access.userId!, options.appId, digest(state), verifiedAt);
        return account;
      });
    },
  };
}
