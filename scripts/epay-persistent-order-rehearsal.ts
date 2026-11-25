import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { AppDatabase } from "../src/database/database.ts";
import { readEncryptedMainOrder } from "../src/epay-compat/main-order-source.ts";
import { importMainOrdersInTransaction } from "../src/epay-compat/main-order-import.ts";
import { importMainLedgerInTransaction } from "../src/epay-compat/isolated-import.ts";
import { readEncryptedMainLedgerSource } from "../src/epay-compat/main-ledger-source.ts";
import { verifyWechatMasterKeyGuard } from "../src/epay-compat/wechat-master-key.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";

export async function rehearsePersistentMainOrders(payment: unknown, merchants: Array<Record<string, unknown>>, bindings: Array<Record<string, unknown>>) {
  if (process.env.EPAY_ISOLATED_TEST !== "1" || statfsSync("/dev/shm").type !== 0x01021994) throw new Error("tmpfs isolation is required");
  const directory = mkdtempSync("/dev/shm/perpay-order-rehearsal-"), file = join(directory, "orders.sqlite");
  const key = randomBytes(32), badKey = randomBytes(32);
  let db: AppDatabase | undefined;
  try {
    db = await AppDatabase.open(file, { masterKey: key });
    const instanceId = db.instanceId();
    const cipher = new RuntimeSecretCipher(key, instanceId);
    const guard = cipher.createGuard();
    db.write(sql => {
    sql.prepare("INSERT INTO runtime_master_key_guard(singleton_key,cipher_version,nonce,ciphertext,authentication_tag,created_at) VALUES(1,1,?,?,?,0)").run(guard.nonce, guard.ciphertext, guard.authenticationTag);
    const account = sql.prepare("INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES(?,'isolated',0,1,0,0)");
    for (const merchant of merchants) {
      const id = Number(merchant.id);
      if (!Number.isSafeInteger(id) || id < 1) throw new Error("invalid restored EPay merchant ID");
      account.run(id);
    }
    const addBinding = sql.prepare("INSERT INTO epay_merchant_bindings VALUES(?,?,?,?,0,0)");
    for (const binding of bindings) {
      const id = Number(binding.epayMerchantId);
      if (typeof binding.id !== "string" || typeof binding.mainApiId !== "string" || typeof binding.mainMerchantId !== "string" || !Number.isSafeInteger(id) || id < 1) throw new Error("invalid restored merchant binding");
      addBinding.run(binding.id, binding.mainApiId, binding.mainMerchantId, id);
    }
    });
    const { count, ledgerCount } = db.write(sql => ({
      count: importMainOrdersInTransaction(sql, cipher, payment),
      ledgerCount: importMainLedgerInTransaction(sql, cipher, payment).count,
    }));
    db.close();
    db = undefined;
    db = await AppDatabase.open(file, { masterKey: key });
    db.read(sql => verifyWechatMasterKeyGuard(sql, cipher));
    let rejectedWrongKey = false;
    try { db.read(sql => verifyWechatMasterKeyGuard(sql, new RuntimeSecretCipher(badKey, instanceId))); } catch { rejectedWrongKey = true; }
    if (!rejectedWrongKey) throw new Error("wrong master key was accepted");
    const orders = (payment as { orders: Array<Record<string, unknown>> }).orders;
    for (const order of orders) {
      if (typeof order.id !== "string" || db.read(sql => readEncryptedMainOrder(sql, cipher, order.id as string)) !== JSON.stringify(order)) throw new Error("reopened main order mismatch");
    }
    const ledger = (payment as { ledger: Array<Record<string, unknown>> }).ledger;
    for (const entry of ledger) {
      if (typeof entry.id !== "string" || db.read(sql => readEncryptedMainLedgerSource(sql, cipher, entry.id as string)) !== JSON.stringify(entry)) throw new Error("reopened main ledger mismatch");
    }
    if (Number(db.read(sql => sql.prepare("SELECT entry_count FROM epay_main_ledger_import_runs WHERE singleton_key=1").get()?.entry_count)) !== ledgerCount) throw new Error("reopened main ledger count mismatch");
    if (!db.integrityCheck().ok) throw new Error("reopened database integrity check failed");
    return { count, ledgerCount, reopenedVerified: true as const, rejectedWrongKey: true as const };
  } finally {
    db?.close();
    key.fill(0);
    badKey.fill(0);
    rmSync(directory, { recursive: true, force: true });
  }
}
