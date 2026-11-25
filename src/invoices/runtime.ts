import type { AppDatabase } from "../database/database.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { activeWechatSigningKey } from "../epay-compat/wechat-signing-keys.ts";
import { verifyWechatMasterKeyGuard } from "../epay-compat/wechat-master-key.ts";
import { createWechatInvoiceProvider } from "./wechat-provider.ts";
import { createFaPiaoRuntime } from "./fa-piao-runtime.ts";

export function createInvoiceRuntime(options: {
  database: Pick<AppDatabase, "read" | "write" | "instanceId">;
  masterKey: Uint8Array;
  transport?: typeof fetch; clock?: () => number;
} & ({ provider?: "wechat"; credentialId: string; signingKeyId: string } | { provider: "fa-piao"; credentialFile: string; allowIssue: boolean })) {
  if (options.provider === "fa-piao") return createFaPiaoRuntime(options);
  const clock = options.clock ?? Date.now;
  const cipher = new RuntimeSecretCipher(options.masterKey, options.database.instanceId());
  const identity = options.database.read(sql => {
    verifyWechatMasterKeyGuard(sql, cipher);
    const now = clock();
    const row = sql.prepare(`SELECT c.app_id,c.provider_merchant_id FROM epay_wechat_credentials c
      LEFT JOIN epay_wechat_credential_revocations r ON r.credential_id=c.credential_id
      WHERE c.credential_id=? AND c.valid_from<=? AND c.valid_until>? AND c.created_at<=? AND r.credential_id IS NULL`)
      .get(options.credentialId, now, now, now);
    if (!row) throw new Error("invoice service-provider credential is unavailable or expired");
    const appId = String(row.app_id), merchantId = String(row.provider_merchant_id);
    activeWechatSigningKey(sql, options.signingKeyId, appId, merchantId, now);
    return { appId, merchantId };
  });
  return createWechatInvoiceProvider({ database: options.database, cipher, ...identity, credentialId: options.credentialId,
    signingKeyId: options.signingKeyId, transport: options.transport ?? fetch, clock });
}
