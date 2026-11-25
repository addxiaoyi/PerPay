import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { readCurrentMainPayment } from "../src/epay-compat/main-delta-store.ts";

const root = process.argv[2];
if (!root || !/^\/var\/lib\/perpay-candidate-\d{8}[a-z]$/.test(root)) throw new Error("explicit candidate root required");
const sql = new DatabaseSync(join(root, "data/perpay.sqlite3"), { readOnly: true });
const key = Buffer.from(readFileSync(join(root, "secrets/master-key"), "utf8").trim(), "hex");
try {
  sql.exec("BEGIN");
  const instance = String(sql.prepare("SELECT value FROM system_metadata WHERE key='instance_id'").get()?.value);
  const source = readCurrentMainPayment(sql, new RuntimeSecretCipher(key, instance)).payment;
  const channels = source.channels as Record<string, Record<string, unknown>>;
  const mainOrders: Record<string, number> = {};
  for (const order of source.orders) {
    const name = String(order.channel);
    if (/^(alipay_web|alipay_scan|wechat_native|wechat_h5|wechat_jsapi)$/.test(name)) mainOrders[name] = (mainOrders[name] ?? 0) + 1;
  }
  const configuration = Object.fromEntries(["alipay", "wechat"].map(provider => {
    const channel = channels[provider] ?? {};
    return [provider, { enabled: channel.enabled === true, modes: Array.isArray(channel.modes) ? channel.modes : [],
      h5DomainConfigured: Boolean(channel.h5Domain), jsapiAppIdConfigured: Boolean(channel.jsapiAppId), jsapiNotifyDomainConfigured: Boolean(channel.jsapiNotifyDomain) }];
  }));
  const legacy = sql.prepare("SELECT provider,product,enabled,count(*) channels FROM epay_channels GROUP BY provider,product,enabled").all()
    .map(row => ({ provider: row.provider, product: row.product, enabled: Number(row.enabled) === 1, channels: Number(row.channels) }));
  console.log(JSON.stringify({ mainOrders, configuration, legacy, databaseWrites: 0, providerRequests: 0 }));
} finally { sql.close(); key.fill(0); }
