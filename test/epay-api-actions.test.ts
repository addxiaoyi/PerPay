import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "node:test";
import { balanceFixture } from "./epay-live-balance-fixture.ts";
import { installBalanceOpenings, planBalanceOpenings } from "../src/epay-compat/balance-opening.ts";
import { recordSyntheticAlipayConfirmation } from "./epay-payment-fixture.ts";
import { createIsolatedEPayQuery } from "../src/epay-compat/isolated-api-query.ts";
import { EPayCallbackOutbox } from "../src/epay-compat/outbox.ts";
import { readLiveBalance } from "../src/epay-compat/live-balance.ts";

it("scopes legacy actions, keeps retry attempts and queues refunds without pretending money was returned", async () => {
  const f = await balanceFixture();
  let now = 1_800_000_000_000;
  f.db.write(sql => {
    installBalanceOpenings(sql, f.cipher, planBalanceOpenings(sql, f.cipher, "a".repeat(64)), 0);
    const key = f.cipher.encrypt("epay:merchant:1:api_key", 1, "fixture-key");
    sql.prepare("INSERT INTO epay_merchant_secrets VALUES(1,1,1,?,?,?,?,0)").run(key.nonce, key.ciphertext, key.authenticationTag, createHash("sha256").update("fixture-key").digest("hex"));
    sql.exec(`INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,real_money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at)
      VALUES('native','native',1,'native',100,100,'https://merchant.example/notify','PAID','PENDING',0,0,0)`);
    recordSyntheticAlipayConfirmation(sql, "native", 1);
  });
  const app = createIsolatedEPayQuery({ database: f.db, masterKey: f.key, clock: () => now, allowActions: () => true });
  const request = (fields: Record<string, string>) => app.request(`/api.php?${new URLSearchParams({ pid: "1", key: "fixture-key", ...fields })}`);
  const queue = new EPayCallbackOutbox(f.db);
  try {
    queue.enqueue("native", 1, now);
    const before = f.db.read(sql => readLiveBalance(sql, 1));
    const info = await (await request({ act: "query" })).json() as { code: number; money: string; pid: number };
    assert.equal(info.code, 1); assert.equal(info.pid, 1); assert.equal(info.money, "10.45");
    const first = queue.claim(now, 3000, 1)!;
    queue.complete({ ...first, now: ++now, acknowledged: false, retryable: true, httpStatus: 500, retryDelayMilliseconds: 10, maximumAttempts: 1 });
    assert.equal(queue.claim(++now, 3000, 1), null);
    const wrong = await request({ act: "notify", trade_no: "legacy-2" });
    assert.equal(wrong.status, 400);
    const retried = await request({ act: "notify", trade_no: "native", request_id: "notify-request-000001" });
    assert.equal(retried.status, 200);
    assert.equal((await retried.json() as { queued: boolean }).queued, true);
    const second = queue.claim(++now, 3000, 1)!;
    assert.equal(second.attemptNumber, 2);
    assert.notEqual(second.leaseToken, first.leaseToken);
    assert.equal((await request({ act: "notify", trade_no: "native", request_id: "notify-request-000002" })).status, 400);
    queue.complete({ ...second, now: ++now, acknowledged: true, retryDelayMilliseconds: 10, maximumAttempts: 1 });
    assert.equal(Number(f.db.read(sql => sql.prepare("SELECT count(*) n FROM epay_callback_attempts WHERE trade_no='native'").get()?.n)), 2);
    assert.equal((await (await request({ act: "notify", trade_no: "native", request_id: "notify-request-000001" })).json() as { duplicate: boolean }).duplicate, true);
    const refund = await request({ act: "refund", trade_no: "native" });
    assert.equal(refund.status, 200);
    const response = await refund.json() as { status: string; refund_no: string; msg: string };
    assert.equal(response.status, "REQUESTED"); assert.match(response.msg, /尚未完成/);
    assert.equal((await (await request({ act: "refund", trade_no: "native" })).json() as { refund_no: string }).refund_no, response.refund_no);
    assert.deepEqual(f.db.read(sql => readLiveBalance(sql, 1)), before);
    assert.equal(Number(f.db.read(sql => sql.prepare("SELECT count(*) n FROM epay_native_refunds").get()?.n)), 1);
    assert.equal((await request({ act: "refund", trade_no: "native", key: "wrong" })).status, 400);
  } finally { f.close(); }
});
