import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { EPayCallbackProcessor } from "../src/epay-compat/callback-processor.ts";
import { recordSyntheticAlipayConfirmation } from "./epay-payment-fixture.ts";
import { EPAY_CALLBACK_POLICY } from "../src/epay-compat/callback-policy.ts";

it("keeps retrying a merchant outage beyond three days and resumes after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "perpay-delivery-window-"));
  const filename = join(directory, "db.sqlite"), masterKey = Buffer.alloc(32, 34);
  let database = await AppDatabase.open(filename, { masterKey });
  let now = 1_000, deliveries = 0, merchantUp = false;
  const startedAt = now;
  const processor = () => new EPayCallbackProcessor({ database, clock: () => now, secret: () => "fixture-key", transport: () => ({
    async post() {
      deliveries++;
      return { status: merchantUp ? 200 : 503, body: Buffer.from(merchantUp ? "success" : "unavailable"), contentType: null, contentEncoding: null,
        responseFingerprint: "", resolvedAddressesFingerprint: "", connectedAddress: "" };
    },
  }) });
  try {
    database.write(sql => {
      sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES(1,'fixture',0,1,0,0);
        INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,type_code,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at)
        VALUES('outage','external',1,'alipay','fixture',100,100,'https://merchant.example/notify','PAID','PENDING',0,1,1)`);
      recordSyntheticAlipayConfirmation(sql, "outage", 1);
      sql.prepare("INSERT INTO epay_callback_jobs(trade_no,merchant_id,status,next_attempt_at,created_at,updated_at) VALUES('outage',1,'PENDING',?,?,?)").run(now,now,now);
    });
    const before = database.read(sql => sql.prepare("SELECT * FROM epay_balance_ledger").all());
    let worker = processor();
    while (now - startedAt < 72 * 60 * 60 * 1000) {
      assert.equal(await worker.processOne(EPAY_CALLBACK_POLICY), true);
      const job = database.read(sql => sql.prepare("SELECT status,next_attempt_at FROM epay_callback_jobs WHERE trade_no='outage'").get())!;
      assert.equal(job.status, "PENDING", "temporary merchant outage must remain recoverable for 72 hours");
      const delay = Number(job.next_attempt_at) - now;
      assert.ok(delay >= 30_000 && delay <= 3_600_000);
      assert.equal(await worker.processOne(EPAY_CALLBACK_POLICY), false);
      now = Number(job.next_attempt_at);
      if (deliveries === 8) {
        database.close();
        database = await AppDatabase.open(filename, { masterKey });
        worker = processor();
      }
    }
    merchantUp = true;
    assert.equal(await worker.processOne(EPAY_CALLBACK_POLICY), true);
    assert.equal(await worker.processOne(EPAY_CALLBACK_POLICY), false);
    assert.equal(database.read(sql => sql.prepare("SELECT notify_status FROM epay_orders WHERE trade_no='outage'").get()?.notify_status), "SUCCESS");
    assert.deepEqual(database.read(sql => sql.prepare("SELECT * FROM epay_balance_ledger").all()), before);
    assert.ok(deliveries <= 80, "retry volume is bounded");
  } finally { database.close(); rmSync(directory, { recursive:true, force:true }); }
});
