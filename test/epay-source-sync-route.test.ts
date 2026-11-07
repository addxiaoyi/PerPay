import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { installBalanceOpenings, planBalanceOpenings } from "../src/epay-compat/balance-opening.ts";
import { initializeLegacyCursor, type LegacyTables } from "../src/epay-compat/legacy-delta.ts";
import { readCurrentMainPayment } from "../src/epay-compat/main-delta-store.ts";
import { canonicalSource } from "../src/epay-compat/source-drift.ts";
import { createSourceSyncRoute, sealSharedCapture } from "../src/epay-compat/source-sync-route.ts";
import { sourceSynchronizationReady } from "../src/epay-compat/source-sync-status.ts";
import { balanceFixture } from "./epay-live-balance-fixture.ts";
import { join } from "node:path";

async function fixture() {
  const f = await balanceFixture();
  const now = Date.now(), cutoff = now - 10_000;
  const tables: LegacyTables = { Merchant: [{ id: 1 }, { id: 2 }, { id: 3 }], AdminSession: [], MerchantBinding: [], MerchantInvoiceConfig: [], PayType: [], Channel: [], Order: [], NotifyLog: [], Invoice: [], InvoiceApplication: [], Config: [] };
  tables.Order = [1, 2].map(id => ({ tradeNo: `legacy-${id}`, outTradeNo: `legacy-${id}`, merchantId: id, money: `${id}0.00`, getMoney: `${id}0.00`, status: "PAID", createdAt: "1970-01-01 00:00:00", paidAt: "1970-01-01 00:00:00", updatedAt: "1970-01-01 00:00:00", notifyStatus: "SUCCESS", notifyCount: 1, notifyLastAt: null }));
  const columns = { Merchant: ["id"], AdminSession: ["id"], MerchantBinding: ["id"], MerchantInvoiceConfig: ["merchantId"], PayType: ["id"], Channel: ["id"], Order: Object.keys(tables.Order[0]!), NotifyLog: ["id"], Invoice: ["id"], InvoiceApplication: ["id"], Config: ["key"] };
  f.db.write(sql => {
    installBalanceOpenings(sql, f.cipher, planBalanceOpenings(sql, f.cipher, "a".repeat(64)), cutoff);
    initializeLegacyCursor(sql, f.cipher, { tables, columns, capturedAt: cutoff, sourceOffsetMinutes: 0 });
  });
  const payment = f.db.read(sql => structuredClone(readCurrentMainPayment(sql, f.cipher).payment));
  const capture = { version: 1 as const, sharedCutoff: true as const, cutoff: new Date(now - 1000).toISOString(), lockedAt: now - 1500, lockCompletedAt: now - 500, tables, columns, mainPayment: payment, mainResponseSha256: "c".repeat(64), sourceSha256: createHash("sha256").update(canonicalSource({ tables, columns, payment })).digest("hex") };
  const route = createSourceSyncRoute({ database: f.db, masterKey: f.key, clock: () => now, onError: () => {} });
  const send = (body: unknown) => route.request("/internal/source-sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { ...f, now, capture, send };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function responseValue(response: Response, key: string): Promise<unknown> {
  const body: unknown = await response.json();
  assert.ok(isRecord(body) && isRecord(body.data) && key in body.data);
  return body.data[key];
}

it("applies encrypted shared captures through the live database owner without a second lease", async () => {
  const f = await fixture();
  try {
    await assert.rejects(AppDatabase.open(join(f.directory, "db.sqlite"), { masterKey: f.key }), /already owns/);
    const sealed = sealSharedCapture(f.cipher, f.capture, f.now);
    assert.equal(JSON.stringify(sealed).includes("main-1"), false);
    const first = await f.send(sealed);
    assert.equal(first.status, 200);
    assert.equal(await responseValue(first, "mainSequence"), 1);
    const second = await f.send(sealed);
    assert.equal(second.status, 200);
    assert.equal(await responseValue(second, "duplicate"), true);
    assert.equal(f.db.health().ok, true);
    assert.equal(f.db.read(sql => sourceSynchronizationReady(sql, f.now)), true);
    assert.equal(Number(f.db.read(sql => sql.prepare("SELECT count(*) n FROM epay_callback_jobs").get())?.n), 0);
  } finally { f.close(); }
});

it("rejects tampering, another instance and stale encrypted captures without financial writes", async () => {
  const f = await fixture();
  try {
    const sealed = sealSharedCapture(f.cipher, f.capture, f.now);
    for (const envelope of [
      { ...sealed, authenticationTag: "00".repeat(16) },
      sealSharedCapture(new RuntimeSecretCipher(f.key, "another-instance"), f.capture, f.now),
      sealSharedCapture(f.cipher, f.capture, f.now - 30_001),
      { version: 1, capture: f.capture },
    ]) assert.equal((await f.send(envelope)).status, 403);
    assert.equal(f.db.read(sql => sql.prepare("SELECT value FROM system_metadata WHERE key='epay_source_sync'").get()), undefined);
    assert.equal(Number(f.db.read(sql => sql.prepare("SELECT count(*) n FROM epay_main_sync_runs").get())?.n), 0);
  } finally { f.close(); }
});

it("rolls back both cursors and records a closed admission gate on authenticated source drift", async () => {
  const f = await fixture();
  try {
    f.capture.tables.Merchant[0]!.id = 999;
    f.capture.sourceSha256 = createHash("sha256").update(canonicalSource({ tables: f.capture.tables, columns: f.capture.columns, payment: f.capture.mainPayment })).digest("hex");
    assert.equal((await f.send(sealSharedCapture(f.cipher, f.capture, f.now))).status, 503);
    assert.equal(f.db.read(sql => sourceSynchronizationReady(sql, f.now)), false);
    assert.equal(Number(f.db.read(sql => sql.prepare("SELECT count(*) n FROM epay_main_sync_runs").get())?.n), 0);
    assert.equal(Number(f.db.read(sql => sql.prepare("SELECT count(*) n FROM epay_legacy_sync_runs").get())?.n), 1);
  } finally { f.close(); }
});
