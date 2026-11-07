import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { createAlipayCallbackRoute } from "../src/epay-compat/alipay-callback-route.ts";

it("acknowledges only authenticated callbacks committed with ledger and outbox", async () => {
  const dir = mkdtempSync(join(tmpdir(), "epay-alipay-route-"));
  const db = await AppDatabase.open(join(dir, "db.sqlite"), { masterKey: randomBytes(32) });
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  try {
    db.write((sql) => {
      sql.exec(`INSERT INTO epay_merchant_accounts(merchant_id,name,balance_cents,enabled,created_at,updated_at) VALUES (1,'merchant',0,1,0,0);
        INSERT INTO epay_orders(trade_no,out_trade_no,merchant_id,name,money_cents,notify_url,status,notify_status,notify_count,created_at,updated_at) VALUES ('trade','external',1,'item',100,'https://example.test','PENDING','PENDING',0,1,1)`);
      sql.prepare("INSERT INTO epay_alipay_intents VALUES ('trade',1,'app','seller',?,100,5,1)").run(publicKey);
      sql.exec("UPDATE epay_orders SET type_code='alipay' WHERE trade_no='trade'");
    });
    const fields: Record<string, string> = { app_id: "app", seller_id: "seller", out_trade_no: "trade", trade_no: "provider-trade", trade_status: "TRADE_SUCCESS", total_amount: "1.00" };
    const content = Object.keys(fields).sort().map((key) => `${key}=${fields[key]}`).join("&");
    const signed = { ...fields, sign_type: "RSA2", sign: sign("RSA-SHA256", Buffer.from(content), keys.privateKey).toString("base64") };
    const app = createAlipayCallbackRoute(db, () => 100);
    const send = (body: string) => app.request("/notify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    const forged = new URLSearchParams({ ...signed, total_amount: "2.00" }).toString();
    assert.equal(await (await send(forged)).text(), "failure");
    assert.equal(await (await send(`${new URLSearchParams(signed)}&trade_no=other`)).text(), "failure");
    assert.equal(await (await send(new URLSearchParams(signed).toString())).text(), "success");
    assert.equal(await (await send(new URLSearchParams(signed).toString())).text(), "success");
    const state = db.read((sql) => ({ order: sql.prepare("SELECT status FROM epay_orders WHERE trade_no='trade'").get(), confirmations: sql.prepare("SELECT count(*) AS n FROM epay_alipay_confirmations").get(), ledger: sql.prepare("SELECT count(*) AS n FROM epay_balance_ledger").get(), jobs: sql.prepare("SELECT count(*) AS n FROM epay_callback_jobs").get() }));
    assert.equal(state.order?.status, "PAID");
    assert.equal(Number(state.confirmations?.n), 1);
    assert.equal(Number(state.ledger?.n), 1);
    assert.equal(Number(state.jobs?.n), 1);
    assert.equal((await app.request("/notify", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 400);
    assert.equal((await send(`x=${"a".repeat(32768)}`)).status, 400);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
