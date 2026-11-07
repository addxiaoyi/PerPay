import type { AppDatabase } from "../database/database.ts";
import { RuntimeSecretCipher } from "../settings/crypto.ts";
import { readEncryptedChannelConfig, writeEncryptedChannelConfig } from "./channel-config.ts";
import { verifyWechatMasterKeyGuard } from "./wechat-master-key.ts";

const MAX_CHANNELS = 10_000;

// Call only during an explicitly controlled offline migration after verifying backup recovery.
export function encryptLegacyChannelConfigs(database: Pick<AppDatabase, "write" | "instanceId">, masterKey: Uint8Array) {
  const cipher = new RuntimeSecretCipher(masterKey, database.instanceId());
  return database.write((db) => {
    verifyWechatMasterKeyGuard(db, cipher);
    const rows = db.prepare("SELECT channel_id,config_json FROM epay_channels WHERE config_json IS NOT NULL ORDER BY channel_id LIMIT ?").all(MAX_CHANNELS + 1) as Array<{ channel_id: number | bigint; config_json: string }>;
    if (rows.length > MAX_CHANNELS) throw new Error("too many plaintext channel configurations");
    let encrypted = 0, alreadyEncrypted = 0;
    for (const row of rows) {
      const id = Number(row.channel_id);
      if (!Number.isSafeInteger(id) || id < 1 || typeof row.config_json !== "string") throw new Error("invalid plaintext channel configuration");
      const existing = readEncryptedChannelConfig(db, cipher, id);
      if (existing !== null && existing !== row.config_json) throw new Error("channel configuration conflict");
      if (existing === null) {
        writeEncryptedChannelConfig(db, cipher, id, row.config_json);
        encrypted++;
      } else alreadyEncrypted++;
      const updated = db.prepare("UPDATE epay_channels SET config_json=NULL WHERE channel_id=? AND config_json=?").run(id, row.config_json);
      if (Number(updated.changes) !== 1) throw new Error("channel configuration changed during migration");
    }
    return { encrypted, alreadyEncrypted };
  });
}
