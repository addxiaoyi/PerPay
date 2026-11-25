import { readFileSync, mkdtempSync, rmSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppDatabase } from "../dist/database/database.js";
import { readAuthenticatedEPaySnapshot } from "../dist/epay-compat/authenticated-snapshot.js";
import { importEPaySnapshotInTransaction } from "../dist/epay-compat/isolated-import.js";
import { RuntimeSecretCipher } from "../dist/settings/crypto.js";

if (process.env.EPAY_ISOLATED_TEST !== "1" || statfsSync("/dev/shm").type !== 0x01021994) {
  throw new Error("explicit isolated rehearsal on tmpfs is required");
}
const snapshotPath = process.env.EPAY_SNAPSHOT_PATH;
const keyPath = process.env.EPAY_SNAPSHOT_KEY_PATH;
const snapshotId = process.env.EPAY_SNAPSHOT_ID;
if (!snapshotPath || !keyPath || !snapshotId) throw new Error("snapshot path, key path and snapshot ID are required");
const keyText = readFileSync(keyPath, "utf8").trim();
if (!/^[a-f0-9]{64}$/i.test(keyText)) throw new Error("invalid snapshot key");
const key = Buffer.from(keyText, "hex");
const source = new DatabaseSync(snapshotPath, { readOnly: true, readBigInts: true });
const directory = mkdtempSync("/dev/shm/perpay-snapshot-rehearsal-");
let target;
try {
  const instanceId = source.prepare("SELECT value FROM system_metadata WHERE key='instance_id'").get()?.value;
  const sourceName = source.prepare("SELECT source_name FROM epay_snapshot_runs WHERE snapshot_id=?").get(snapshotId)?.source_name;
  if (typeof instanceId !== "string" || typeof sourceName !== "string") throw new Error("snapshot metadata missing");
  const options = { database: { read: operation => operation(source) }, masterKey: key, instanceId, sourceName, requireColumnMetadata: true };
  const snapshot = readAuthenticatedEPaySnapshot(options, snapshotId);
  const merchantFeeBps = Object.fromEntries(snapshot.tables.Merchant.map(row => [String(row.id), 0]));
  const targetPath = join(directory, "rehearsal.sqlite");
  target = await AppDatabase.open(targetPath, { masterKey: key });
  const targetId = target.instanceId();
  const cipher = new RuntimeSecretCipher(key, targetId);
  const guard = cipher.createGuard();
  target.write(db => db.prepare("INSERT INTO runtime_master_key_guard(singleton_key,cipher_version,nonce,ciphertext,authentication_tag,created_at) VALUES(1,1,?,?,?,0)").run(guard.nonce, guard.ciphertext, guard.authenticationTag));
  const report = target.write(db => importEPaySnapshotInTransaction({ ...options, merchantFeeBps, sourceOffsetMinutes: 480 }, snapshotId, { database: db, instanceId: targetId }));
  if (!target.integrityCheck().ok) throw new Error("imported database integrity check failed");
  target.close();
  target = await AppDatabase.open(targetPath, { masterKey: key });
  if (!target.integrityCheck().ok) throw new Error("reopened database integrity check failed");
  const counts = target.read(db => Object.fromEntries([
    ["merchants", "epay_merchant_accounts"], ["bindings", "epay_merchant_bindings"],
    ["orders", "epay_orders"], ["notifications", "epay_notify_logs"],
    ["invoices", "epay_invoices"], ["invoiceApplications", "epay_invoice_applications"],
  ].map(([name, table]) => [name, Number(db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count)])));
  console.log(JSON.stringify({ sourceCounts: snapshot.counts, importedCounts: counts, identifiersVerified: report.identifiersVerified, reopenedIntegrity: true, assumedFees: true, financiallyReconciled: false, productionReady: false }));
} finally {
  target?.close();
  source.close();
  key.fill(0);
  rmSync(directory, { recursive: true, force: true });
}
