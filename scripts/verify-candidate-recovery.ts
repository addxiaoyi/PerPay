import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/database/database.ts";
import { openLiveState } from "../src/epay-compat/live-state-envelope.ts";
import { readLiveStateArchive } from "../src/epay-compat/live-state-archive.ts";
import { readMainPaymentArchive } from "../src/epay-compat/main-payment-archive.ts";
import { verifyCandidateArchive } from "../src/epay-compat/candidate-import.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { readMerchantSecret } from "../src/epay-compat/merchant-secret.ts";
import { createExactAlipayOrder } from "../src/epay-compat/exact-alipay-order.ts";
import { createExactWechatOrder } from "../src/epay-compat/exact-wechat-order.ts";
import { epaySign } from "../src/epay-compat/sign.ts";
import { SiteStore } from "../src/sites/store.ts";

const [archivePath, keyArchivePath, mode] = process.argv.slice(2);
if (!archivePath || !keyArchivePath) throw new Error("candidate archive and encrypted key paths required");
if (mode !== undefined && mode !== "--rehearse-orders") throw new Error("unsupported recovery verification mode");
const privateKey = readFileSync(0);
const directory = mkdtempSync(join(tmpdir(), "perpay-recovery-"));
let plaintext: Buffer | undefined;
let masterKey: Buffer | undefined;
let database: AppDatabase | undefined;
try {
  const manifest = JSON.parse(readFileSync(`${archivePath}.manifest.json`, "utf8"));
  const envelope = readLiveStateArchive(archivePath, manifest.archiveSha256);
  plaintext = openLiveState(envelope, privateKey.toString("utf8"), manifest.snapshotId);
  assert.equal(createHash("sha256").update(plaintext).digest("hex"), manifest.sourceSha256);
  assert.equal(plaintext.length, manifest.sourceBytes);
  const keyEnvelope = JSON.parse(readFileSync(keyArchivePath, "utf8"));
  masterKey = openLiveState(keyEnvelope, privateKey.toString("utf8"), keyEnvelope.snapshotId);
  assert.equal(masterKey.length, 32);
  const path = join(directory, "recovered.sqlite3");
  writeFileSync(path, plaintext, { mode: 0o600, flag: "wx", flush: true });
  plaintext.fill(0);
  database = await AppDatabase.open(path, { masterKey });
  const cipher = new RuntimeSecretCipher(masterKey, database.instanceId());
  const archive = database.read(sql => readMainPaymentArchive(sql, cipher));
  assert.ok(archive);
  const verified = verifyCandidateArchive(database, masterKey, JSON.parse(archive));
  const counts = database.read(sql => ({
    merchants: Number(sql.prepare("SELECT count(*) n FROM epay_merchant_accounts").get()?.n),
    orders: Number(sql.prepare("SELECT count(*) n FROM epay_orders").get()?.n),
    invoices: Number(sql.prepare("SELECT count(*) n FROM epay_invoices").get()?.n),
    schemaVersion: Number(sql.prepare("SELECT max(version) n FROM schema_migrations").get()?.n),
  }));
  const instanceId = database.instanceId();
  database.close();
  database = undefined;
  database = await AppDatabase.open(path, { masterKey });
  assert.equal(database.instanceId(), instanceId);
  let orderRehearsal: ReturnType<typeof rehearseOrders> | undefined;
  if (mode === "--rehearse-orders") orderRehearsal = rehearseOrders(database, masterKey);
  console.log(JSON.stringify({ recovered: true, reopened: true, ...counts, ...verified, ...(orderRehearsal ? { orderRehearsal } : {}) }));
} finally {
  database?.close();
  masterKey?.fill(0);
  plaintext?.fill(0);
  privateKey.fill(0);
  rmSync(directory, { recursive: true, force: true });
}

// Runs only after decrypting into the disposable local recovery directory; no transport is constructed.
function rehearseOrders(database: AppDatabase, masterKey: Uint8Array) {
  const cipher = new RuntimeSecretCipher(masterKey, database.instanceId());
  const credentials = database.read(sql => {
    const rows = sql.prepare("SELECT merchant_id,client_id FROM epay_site_bindings ORDER BY merchant_id").all();
    return rows.map(row => ({ merchantId: Number(row.merchant_id), clientId: String(row.client_id), secret: readMerchantSecret(sql, cipher, Number(row.merchant_id)) }));
  });
  assert.ok(credentials.length >= 2);
  const marker = database.read(sql => sql.prepare("SELECT value FROM system_metadata WHERE key='epay_configured_channels'").get());
  assert.ok(marker);
  const provisioned = JSON.parse(String(marker.value)) as { credentialId: string };
  const count = (table: string) => database.read(sql => Number(sql.prepare(`SELECT count(*) n FROM ${table}`).get()?.n));
  const before = { orders: count("epay_orders"), ledger: count("epay_balance_ledger"), callbacks: count("epay_callback_jobs") };
  const tradeNos = new Set<string>();
  const now = Date.now();
  const sites = new SiteStore(database, masterKey);
  const admission = (clientId: string, enabled: boolean) => {
    const site = sites.get(clientId);
    assert.ok(site);
    sites.update(clientId, { revision: site.revision, configuration: { ...site.configuration, accepting_orders: enabled } }, { actorId: "recovery-rehearsal" });
  };
  for (const credential of credentials) {
    for (const type of ["alipay", "wxpay"]) {
      const fields = { pid: String(credential.merchantId), type, out_trade_no: `recovery-${type}-${now}`, money: "1.01", name: "隔离恢复测试", clientip: "127.0.0.1", notify_url: "https://example.com/callback", device: "pc" };
      const sign = (value: Record<string, string>, key = credential.secret) => ({ ...value, sign: epaySign(value, key), sign_type: "MD5" });
      const create = (value: Record<string, string>) => type === "alipay" ? createExactAlipayOrder(database, masterKey, value, "api", now) : createExactWechatOrder(database, masterKey, value, "api", provisioned.credentialId, now);
      assert.throws(() => create(sign(fields)), /authentication/);
      admission(credential.clientId, true);
      const created = create(sign(fields));
      assert.equal(created.created, true);
      assert.equal(tradeNos.has(created.tradeNo), false);
      tradeNos.add(created.tradeNo);
      assert.equal(create(sign(fields)).tradeNo, created.tradeNo);
      assert.throws(() => create(sign({ ...fields, money: "1.02" })), /conflict/);
      const another = credentials.find(item => item.merchantId !== credential.merchantId)!;
      assert.throws(() => create(sign(fields, another.secret)), /authentication/);
      const second = create(sign({ ...fields, out_trade_no: fields.out_trade_no + "-2" }));
      assert.notEqual(second.tradeNo, created.tradeNo);
      assert.equal(tradeNos.has(second.tradeNo), false);
      tradeNos.add(second.tradeNo);
      admission(credential.clientId, false);
    }
  }
  assert.equal(count("epay_orders"), before.orders + tradeNos.size);
  assert.equal(count("epay_balance_ledger"), before.ledger);
  assert.equal(count("epay_callback_jobs"), before.callbacks);
  assert.equal(count("epay_alipay_submissions"), 0);
  assert.equal(count("epay_wechat_submissions"), 0);
  return { isolated: true, merchants: credentials.length, uniqueOrders: tradeNos.size, providerRequests: 0, ledgerUnchanged: true, callbacksUnchanged: true };
}
