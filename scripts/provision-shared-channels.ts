import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { AppDatabase } from "../src/database/database.ts";
import { channelFields, channelText } from "../src/epay-compat/configured-channel-identity.ts";
import { provisionConfiguredChannels } from "../src/epay-compat/provision-configured-channels.ts";
import { readMainMemorySnapshot } from "../src/epay-compat/main-snapshot-client.ts";
import { inspectEPayReadiness } from "../src/epay-compat/gateway-readiness.ts";

let phase = "arguments";
async function provision() {
  process.umask(0o077);
  const [root] = process.argv.slice(2);
  if (!root || process.argv.length !== 3 || !/^\/var\/lib\/perpay-candidate-[a-z0-9-]+$/.test(root) || resolve(root) !== root) throw new Error("invalid channel candidate root");
  const readSecret = (path: string) => {
    if ((statSync(path).mode & 0o077) !== 0) throw new Error("channel secret permissions are unsafe");
    const hex = readFileSync(path, "utf8").trim();
    if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error("channel secret format is invalid");
    return Buffer.from(hex, "hex");
  };
  const key = readSecret(join(root, "secrets/master-key")), secret = readSecret("/etc/helstera/perpay-migration.secret");
  let database: AppDatabase | undefined;
  try {
    phase = "authenticated_main_configuration";
    const capture = await readMainMemorySnapshot({ origin: "http://127.0.0.1:8787", secret });
    const channels = channelFields(channelFields(capture.payment).channels), alipay = channelFields(channels.alipay), wechat = channelFields(channels.wechat);
    if (alipay.enabled !== true || wechat.enabled !== true) throw new Error("main configured channels are not enabled");
    const pem = (path: unknown) => readFileSync(channelText(path), "utf8");
    phase = "provision_candidate_channels";
    database = await AppDatabase.open(join(root, "data/perpay.sqlite3"), { masterKey: key });
    const now = Date.now();
    const report = provisionConfiguredChannels(database, key, { actor: "deployment:shared-cutoff", now, reviewUntil: now + 30 * 86400_000, alipayChannelId: 1, wechatChannelId: 2,
      alipay: { appId: channelText(alipay.appId), merchantId: channelText(alipay.merchantId), privateKey: pem(alipay.privateKeyPath), platformPublicKey: pem(alipay.platformPublicKeyPath), applicationCertificate: pem(alipay.appPublicCertificatePath) },
      wechat: { appId: channelText(wechat.appId), merchantId: channelText(wechat.merchantId), privateKey: pem(wechat.privateKeyPath), platformPublicKey: pem(wechat.publicKeyPath), platformPublicKeyId: channelText(wechat.publicKeyId) },
    });
    const readiness = inspectEPayReadiness(database, key, { mode: "maintenance", callbackDelivery: false, alipayChannelId: 1, wechatCredentialId: report.credentialId, wechatSigningKeyId: report.signingKeyId });
    if (!readiness.configurationReady || !readiness.balancesReady || readiness.acceptingMerchants !== 0 || readiness.callbackDeliveryEnabled) throw new Error("candidate channel readiness differs");
    console.log(JSON.stringify({ provisioned: true, mainCaptureAt: capture.capturedAt, mainResponseSha256: capture.responseSha256, channels: report, readiness, providerRequests: 0 }));
  } finally { database?.close(); key.fill(0); secret.fill(0); }
}
provision().catch(() => { console.error(JSON.stringify({ provisioned: false, error: "shared_channel_provision_failed", phase })); process.exitCode = 1; });
