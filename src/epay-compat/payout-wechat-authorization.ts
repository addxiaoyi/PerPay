import { randomUUID } from "node:crypto";
import type { RuntimeSecretCipher } from "../settings/crypto.ts";
import type { DatabaseSync } from "node:sqlite";
import { appendAuditEvent } from "../database/identity-store.ts";
import { payoutAccount, readPayoutDestination } from "./payout-accounts.ts";
import { payoutAccess, PayoutConflict, type PayoutAccess, type PayoutDatabase } from "./payout-model.ts";
import type { createWechatPayoutClient } from "./payout-wechat-client.ts";

type AuthRow = { account_id: string; merchant_id: number | bigint; owner_id: string; out_no: string; payer: string; app_id: string; scene_id: string;
  state: string; submitted_at: number | bigint | null; verified_at: number | bigint | null; expires_at: number | bigint; lease_token: string | null; lease_until: number | bigint | null;
  nonce: Uint8Array | null; ciphertext: Uint8Array | null; authentication_tag: Uint8Array | null; created_at: number | bigint; updated_at: number | bigint };
type Options = { database: PayoutDatabase; cipher: RuntimeSecretCipher; appId: string; payer: string; sceneId: string; notifyUrl: string; displayName: string; clock: () => number; client: ReturnType<typeof createWechatPayoutClient> };
const secretName = (outNo: string) => `epay:config:wechat-payout-authorization:${outNo}` as const;

export function createWechatPayoutAuthorization(options: Options) {
  const { database, cipher, clock, client } = options;
  const read = (sql: DatabaseSync, accountId: string) => sql.prepare("SELECT * FROM epay_wechat_payout_authorizations WHERE account_id=? ORDER BY (state='CLOSED'),created_at DESC,out_no DESC LIMIT 1").get(accountId) as AuthRow | undefined;
  const secret = (row: AuthRow): { package?: string; authorizationId?: string } => {
    if (!row.nonce || !row.ciphertext || !row.authentication_tag) return {};
    const bytes = cipher.decrypt(secretName(row.out_no), 1, { cipherVersion: 1, nonce: Buffer.from(row.nonce), ciphertext: Buffer.from(row.ciphertext), authenticationTag: Buffer.from(row.authentication_tag) });
    try { return JSON.parse(bytes.toString("utf8")) as { package?: string; authorizationId?: string }; } finally { bytes.fill(0); }
  };
  const recipient = (sql: DatabaseSync, accountId: string, merchantId: number, ownerId?: string) => {
    const account = payoutAccount(sql, accountId, merchantId);
    const identity = sql.prepare("SELECT * FROM epay_wechat_payout_identities WHERE account_id=? AND app_id=?").get(accountId, options.appId);
    if (!identity) throw new PayoutConflict("verified OAuth recipient required");
    if (ownerId && identity.owner_id !== ownerId) throw new PayoutConflict("only the bound owner can authorize this recipient");
    if (account.kind !== "wechat" || account.status !== "APPROVED") throw new PayoutConflict("approved WeChat recipient required");
    const destination = readPayoutDestination(sql, cipher, accountId, merchantId);
    if (destination.kind !== "wechat" || destination.appId !== options.appId) throw new PayoutConflict("WeChat recipient app differs");
    return { destination, ownerId: String(identity.owner_id) };
  };
  function project(row: AuthRow | undefined, bridge: boolean) {
    if (!row) return { state: "NOT_REQUESTED", verifiedAt: null, expiresAt: null, bridge: null };
    const payload = secret(row), expired = row.state === "WAIT_USER_CONFIRM" && clock() >= Number(row.expires_at);
    return { state: expired ? "EXPIRED" : row.state, verifiedAt: row.verified_at === null ? null : Number(row.verified_at), expiresAt: Number(row.expires_at),
      bridge: bridge && !expired && row.state === "WAIT_USER_CONFIRM" && payload.package ? { mchId: row.payer, appId: row.app_id, package: payload.package } : null };
  }
  function save(fields: Record<string, unknown>, submitting: boolean, expected?: AuthRow) {
    return database.write(sql => {
      const row = sql.prepare("SELECT * FROM epay_wechat_payout_authorizations WHERE out_no=?").get(String(fields.out_authorization_no ?? "")) as AuthRow | undefined;
      if (!row || row.payer !== options.payer || row.app_id !== options.appId || row.scene_id !== options.sceneId || expected && row.out_no !== expected.out_no) throw new Error("WeChat authorization identity mismatch");
      const destination = readPayoutDestination(sql, cipher, row.account_id, Number(row.merchant_id));
      if (destination.kind !== "wechat" || (!submitting && (fields.appid !== row.app_id || fields.openid !== destination.account)) ||
        fields.transfer_scene_id !== undefined && fields.transfer_scene_id !== row.scene_id || !["WAIT_USER_CONFIRM", "TAKING_EFFECT", "CLOSED"].includes(String(fields.state))) throw new Error("WeChat authorization identity or state mismatch");
      const payload = secret(row), now = clock();
      if (now < Number(row.updated_at)) throw new Error("WeChat authorization clock regressed");
      if (fields.authorization_id !== undefined) {
        if (typeof fields.authorization_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(fields.authorization_id) || payload.authorizationId && payload.authorizationId !== fields.authorization_id) throw new Error("WeChat authorization reference differs");
        payload.authorizationId = fields.authorization_id;
      }
      if (fields.state === "TAKING_EFFECT" && !payload.authorizationId) throw new Error("WeChat authorization reference missing");
      if (fields.package_info !== undefined) {
        if (typeof fields.package_info !== "string" || fields.package_info.length < 1 || fields.package_info.length > 1024 || /[\x00-\x20\x7f]/.test(fields.package_info)) throw new Error("invalid WeChat authorization package");
        payload.package = fields.package_info;
      }
      // A delayed notification cannot reopen a closed grant or regress a confirmed grant to pending.
      const state = row.state === "CLOSED" ? "CLOSED" : row.state === "TAKING_EFFECT" && fields.state === "WAIT_USER_CONFIRM" ? "TAKING_EFFECT" : String(fields.state);
      if (state !== "WAIT_USER_CONFIRM") delete payload.package;
      const sealed = cipher.encrypt(secretName(row.out_no), 1, JSON.stringify(payload));
      sql.prepare("UPDATE epay_wechat_payout_authorizations SET state=?,verified_at=?,lease_token=NULL,lease_until=NULL,nonce=?,ciphertext=?,authentication_tag=?,updated_at=? WHERE out_no=?")
        .run(state, now, sealed.nonce, sealed.ciphertext, sealed.authenticationTag, now, row.out_no);
      if (state !== row.state) appendAuditEvent(sql, { occurredAt: now, actorType: "SYSTEM", actorId: "wechat-authorization", action: "epay.payout.authorization", outcome: "SUCCESS", subjectType: "payout_account", subjectId: row.account_id, details: { state } });
      return sql.prepare("SELECT * FROM epay_wechat_payout_authorizations WHERE out_no=?").get(row.out_no) as AuthRow;
    });
  }
  async function query(row: AuthRow, signal?: AbortSignal) {
    const reply = await client.request("GET", `/v3/fund-app/mch-transfer/user-confirm-authorization/out-authorization-no/${row.out_no}`, undefined, signal);
    return save(reply.fields, false, row);
  }
  return {
    status(access: PayoutAccess, accountId: string) {
      return database.read(sql => { payoutAccess(sql, access, "read"); payoutAccount(sql, accountId, access.epayMerchantId); return project(read(sql, accountId), false); });
    },
    async authorize(access: PayoutAccess, accountId: string) {
      const reservation = database.write(sql => {
        payoutAccess(sql, access, "owner"); const bound = recipient(sql, accountId, access.epayMerchantId, access.userId), now = clock();
        let row = read(sql, accountId);
        if (!row || row.state === "CLOSED") {
          const outNo = randomUUID().replaceAll("-", "");
          sql.prepare(`INSERT INTO epay_wechat_payout_authorizations(account_id,merchant_id,owner_id,out_no,payer,app_id,scene_id,state,expires_at,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,'REQUESTED',?,?,?)`).run(accountId, access.epayMerchantId, bound.ownerId, outNo, options.payer, options.appId, options.sceneId, now + 86400000, now, now);
          row = read(sql, accountId)!;
        }
        if (row.owner_id !== access.userId || row.payer !== options.payer || row.app_id !== options.appId || row.scene_id !== options.sceneId) throw new PayoutConflict("WeChat authorization owner or configuration differs");
        if (row.lease_token && Number(row.lease_until) > now) throw new PayoutConflict("WeChat authorization is being queried");
        const submit = row.submitted_at === null, token = randomUUID();
        sql.prepare("UPDATE epay_wechat_payout_authorizations SET submitted_at=coalesce(submitted_at,?),lease_token=?,lease_until=?,updated_at=? WHERE out_no=?").run(now, token, now + 30000, now, row.out_no);
        return { row, token, submit, destination: bound.destination };
      });
      try {
        if (!reservation.submit) return project(await query(reservation.row), true);
        const reply = await client.request("POST", "/v3/fund-app/mch-transfer/user-confirm-authorization", { out_authorization_no: reservation.row.out_no, appid: options.appId,
          openid: reservation.destination.account, transfer_scene_id: options.sceneId, user_display_name: options.displayName, authorization_notify_url: options.notifyUrl });
        if (reply.fields.state !== "WAIT_USER_CONFIRM" || typeof reply.fields.package_info !== "string") throw new Error("WeChat authorization submission requires query");
        return project(save(reply.fields, true, reservation.row), true);
      } catch (cause) {
        database.write(sql => sql.prepare("UPDATE epay_wechat_payout_authorizations SET state=CASE WHEN state='REQUESTED' THEN 'UNKNOWN' ELSE state END,lease_token=NULL,lease_until=NULL,updated_at=? WHERE out_no=? AND lease_token=?").run(clock(), reservation.row.out_no, reservation.token));
        throw cause;
      }
    },
    async requireActive(accountId: string, merchantId: number, signal: AbortSignal) {
      const before = database.read(sql => { recipient(sql, accountId, merchantId); return read(sql, accountId); });
      if (!before || before.state === "CLOSED" || before.payer !== options.payer || before.app_id !== options.appId || before.scene_id !== options.sceneId) throw new Error("WeChat authorization unavailable");
      const verified = await query(before, signal);
      return database.read(sql => {
        const bound = recipient(sql, accountId, merchantId); const current = read(sql, accountId);
        if (!current || current.out_no !== verified.out_no || current.state !== "TAKING_EFFECT") throw new Error("WeChat authorization not active");
        const id = secret(current).authorizationId;
        if (!id) throw new Error("WeChat authorization reference missing");
        return { authorizationId: id, destination: bound.destination };
      });
    },
    notify(bytes: Uint8Array, headers: Headers) { save(client.notification(bytes, headers), false); },
  };
}
