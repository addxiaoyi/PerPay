import { readFileSync } from "node:fs";
import { AppDatabase } from "../src/database/database.ts";
import { channelFields, channelText } from "../src/epay-compat/configured-channel-identity.ts";
import { provisionConfiguredChannels } from "../src/epay-compat/provision-configured-channels.ts";

const [databasePath, masterKeyFile, mainStoreFile, actor] = process.argv.slice(2);
if (!databasePath || !masterKeyFile || !mainStoreFile || !actor || process.argv.length !== 6) throw new Error("usage: provision-configured-channels <candidate-db> <master-key-file> <main-store-file> <operator>");
let database: AppDatabase | undefined;
let masterKey: Buffer | undefined;
let stage = "read-config";
try {
  const keyHex = readFileSync(masterKeyFile, "utf8").trim();
  if (!/^[a-fA-F0-9]{64}$/.test(keyHex)) throw new Error("invalid master key file");
  masterKey = Buffer.from(keyHex, "hex");
  const store = channelFields(JSON.parse(readFileSync(mainStoreFile, "utf8")));
  const channels = channelFields(channelFields(store.payment).channels);
  const alipay = channelFields(channels.alipay), wechat = channelFields(channels.wechat);
  if (alipay.enabled !== true || wechat.enabled !== true) throw new Error("main-site payment channels are not enabled");
  const pem = (path: unknown) => readFileSync(channelText(path), "utf8");
  const now = Date.now();
  stage = "open-candidate";
  database = await AppDatabase.open(databasePath, { masterKey });
  stage = "verify-and-provision";
  const report = provisionConfiguredChannels(database, masterKey, {
    actor, now, reviewUntil: now + 30 * 24 * 60 * 60 * 1000,
    alipayChannelId: 1, wechatChannelId: 2,
    alipay: { appId: channelText(alipay.appId), merchantId: channelText(alipay.merchantId), privateKey: pem(alipay.privateKeyPath), platformPublicKey: pem(alipay.platformPublicKeyPath), applicationCertificate: pem(alipay.appPublicCertificatePath) },
    wechat: { appId: channelText(wechat.appId), merchantId: channelText(wechat.merchantId), privateKey: pem(wechat.privateKeyPath), platformPublicKey: pem(wechat.publicKeyPath), platformPublicKeyId: channelText(wechat.publicKeyId) },
  });
  console.log(JSON.stringify({ provisioned: true, ...report }));
} catch (error) {
  console.error(JSON.stringify({ provisioned: false, stage, reason: error instanceof Error ? error.name : "UnknownError" }));
  process.exitCode = 1;
} finally {
  database?.close();
  masterKey?.fill(0);
}
