import assert from "node:assert/strict";
import { it } from "node:test";
import { balanceFixture } from "./epay-live-balance-fixture.ts";
import { createPayoutRuntime } from "../src/epay-compat/payout-runtime.ts";
import { disabledPayoutPolicy } from "../src/epay-compat/payout-model.ts";

it("composes disabled transfers with one daily query run and retains interrupted evidence", async () => {
  const f = await balanceFixture(), errors: string[] = [], now = Date.now();
  const runtime = createPayoutRuntime({ database: f.db, cipher: f.cipher, policy: disabledPayoutPolicy, adapters: {}, clock: () => now, onError: code => errors.push(code) });
  try {
    f.db.write(sql => sql.prepare("INSERT INTO epay_payout_reconciliations(run_id,business_day,started_at,status,expected_count,scope) VALUES('interrupted','2020-01-01',?,'RUNNING',1,'known_payout_queries')").run(now - 86400000));
    await runtime.start(); await runtime.start();
    assert.equal(f.db.read(sql => sql.prepare("SELECT status FROM epay_payout_reconciliations WHERE run_id='interrupted'").get()?.status), "ATTENTION");
    assert.equal(Number(f.db.read(sql => sql.prepare("SELECT count(*) n FROM epay_payout_reconciliations").get()?.n)), 2);
    const day = new Date(now + 8 * 3600000 - 86400000).toISOString().slice(0,10);
    const first = runtime.reconcile(day);
    await assert.rejects(runtime.reconcile(day), /already running/); await first;
    assert.deepEqual(errors, []);
    await runtime.stop(); await assert.rejects(runtime.reconcile(day), /stopped/);
    assert.equal(Number(f.db.read(sql => sql.prepare("SELECT count(*) n FROM epay_balance_ledger").get()?.n)), 0);
  } finally { await runtime.stop(); f.close(); }
});
