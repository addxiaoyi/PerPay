import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { Hono } from "hono";
import { AppDatabase } from "../src/database/database.ts";
import { RuntimeSecretCipher } from "../src/settings/crypto.ts";
import { createIsolatedEPayQuery } from "../src/epay-compat/isolated-api-query.ts";
import { createIsolatedGateway } from "../src/epay-compat/isolated-gateway.ts";
import { PublicCheckoutRateLimiter } from "../src/http/public-checkout-rate-limit.ts";

it("limits legacy order queries to the authenticated merchant and remains read-only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-api-query-"));
  const key = randomBytes(32);
  const db = await AppDatabase.open(join(dir, "db.sqlite"), { masterKey: key });
  try {
    const cipher = new RuntimeSecretCipher(key, db.instanceId());
    db.write((sql) => {
      sql.exec("INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'one',0,1,0,0),(2,'two',0,1,0,0)");
      for (const id of [1, 2]) {
        const secret = `fixture-key-${id}`;
        const sealed = cipher.encrypt(`epay:merchant:${id}:api_key`, 1, secret);
        sql.prepare("INSERT INTO epay_merchant_secrets VALUES (?,1,1,?,?,?,?,0)").run(id, sealed.nonce, sealed.ciphertext, sealed.authenticationTag, createHash("sha256").update(secret).digest("hex"));
        sql.prepare(`INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at)
          VALUES (?,?,?,?,?,'https://example.test','PENDING','PENDING',0,0,0)`).run(`trade-${id}`, `external-${id}`, id, `item-${id}`, 101);
      }
      const expiry = cipher.encrypt("epay:config:order_expire_minutes", 1, "30");
      sql.prepare("INSERT INTO epay_config_secrets VALUES ('order_expire_minutes',1,1,?,?,?,?,0)").run(expiry.nonce, expiry.ciphertext, expiry.authenticationTag, createHash("sha256").update("30").digest("hex"));
      sql.exec("UPDATE epay_orders SET buyer='buyer-1',pay_url='https://example.test/pay' WHERE trade_no='trade-1'");
    });
    const handler = createIsolatedEPayQuery({ database: db, masterKey: key });
    const limited = createIsolatedEPayQuery({ database: db, masterKey: key, limiter: new PublicCheckoutRateLimiter({ sourceBurst: 1, sourceRequestsPerSecond: 0.000001 }) });
    const limitedFirst = await limited.request("/api.php?pid=1&key=wrong");
    assert.equal(limitedFirst.status, 400);
    const limitedSecond = await limited.request("/api.php?pid=1&key=fixture-key-1&act=order&trade_no=trade-1");
    assert.equal(limitedSecond.status, 429);
    assert.equal(limitedSecond.headers.get("retry-after"), "1");
    assert.equal(limitedSecond.headers.get("cache-control"), "no-store");
    const empty = new Hono();
    const app = createIsolatedGateway({ wechat: empty, alipay: empty, wechatCallback: empty, alipayCallback: empty, apiQuery: handler });
    const query = (params: Record<string, string>) => app.request(`/api.php?${new URLSearchParams(params)}`);
    const own = await query({ act: "order", pid: "1", key: "fixture-key-1", trade_no: "trade-1" });
    assert.equal(own.headers.get("cache-control"), "no-store");
    assert.deepEqual(await own.json(), { code: 1, msg: "查询订单号成功", trade_no: "trade-1", out_trade_no: "external-1", api_trade_no: "", type: "", pid: 1, name: "item-1", money: "1.01", status: 0, status_text: "待支付", addtime: "1970-01-01T00:00:00.000Z", endtime: null, expiretime: "1970-01-01T00:30:00.000Z", param: "", buyer: "buyer-1", payurl: "https://example.test/pay" });
    assert.equal((await (await query({ act: "order", pid: "1", key: "fixture-key-1", out_trade_no: "external-1" })).json() as { code: number }).code, 1);
    const list = await (await query({ act: "orders", pid: "1", key: "fixture-key-1", limit: "1", offset: "0", status: "0" })).json() as { code: number; count: number; data: Array<{ trade_no: string }> };
    assert.equal(list.code, 1);
    assert.equal(list.count, 1);
    assert.deepEqual(list.data.map((order) => order.trade_no), ["trade-1"]);
    const emptyPage = await (await query({ act: "orders", pid: "1", key: "fixture-key-1", offset: "1" })).json() as { count: number; data: unknown[] };
    assert.equal(emptyPage.count, 1);
    assert.deepEqual(emptyPage.data, []);
    assert.equal((await (await query({ act: "orders", pid: "1", key: "fixture-key-1", limit: "51" })).json() as { code: number }).code, -1);
    assert.equal((await (await query({ act: "orders", pid: "1", key: "fixture-key-1", offset: "-1" })).json() as { code: number }).code, -1);
    const post = await app.request("/api.php", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ act: "order", pid: "1", key: "fixture-key-1", trade_no: "trade-1" }) });
    assert.equal((await post.json() as { code: number }).code, 1);
    assert.equal((await (await query({ act: "order", pid: "1", key: "fixture-key-1", trade_no: "trade-2" })).json() as { code: number }).code, -1);
    assert.equal((await query({ act: "order", pid: "2", key: "fixture-key-1", trade_no: "trade-2" })).status, 400);
    assert.equal((await (await query({ act: "refund", pid: "1", key: "fixture-key-1", trade_no: "trade-1" })).json() as { code: number }).code, -1);
    assert.equal((await (await query({ act: "notify", pid: "1", key: "fixture-key-1", trade_no: "trade-2" })).json() as { code: number }).code, -1);
    assert.equal((await (await query({ act: "order", pid: "1", key: "fixture-key-1", trade_no: "trade-1", out_trade_no: "external-1" })).json() as { code: number }).code, -1);
    db.write((sql) => sql.prepare("UPDATE epay_config_secrets SET secret_fingerprint=? WHERE config_key='order_expire_minutes'").run("0".repeat(64)));
    assert.equal((await query({ act: "order", pid: "1", key: "fixture-key-1", trade_no: "trade-1" })).status, 400);
    db.write((sql) => sql.exec("UPDATE epay_merchant_accounts SET enabled=0 WHERE merchant_id=1"));
    assert.equal((await query({ act: "order", pid: "1", key: "fixture-key-1", trade_no: "trade-1" })).status, 400);
    assert.equal(Number(db.read((sql) => sql.prepare("SELECT count(*) AS count FROM epay_orders WHERE status='PENDING'").get())?.count), 2);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
