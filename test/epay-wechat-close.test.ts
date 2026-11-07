import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { it } from "node:test";
import { mainOrderFixture } from "./epay-main-native-fixture.ts";
import { registerWechatCredential } from "../src/epay-compat/wechat-credentials.ts";
import { registerWechatSigningKey } from "../src/epay-compat/wechat-signing-keys.ts";
import { createExactWechatOrder } from "../src/epay-compat/exact-wechat-order.ts";
import { epaySign } from "../src/epay-compat/sign.ts";
import { closeExpiredWechatOrder } from "../src/epay-compat/wechat-close.ts";
import { countWechatSubmissionViolations } from "../src/epay-compat/wechat-submission-integrity.ts";
import { AppDatabase } from "../src/database/database.ts";
import { join } from "node:path";

it("closes only expired signed NOTPAY orders and waits for a verified CLOSED query before changing local state", async () => {
  const f = await mainOrderFixture(), now = 1_800_000_000_000;
  const signing = generateKeyPairSync("rsa", { modulusLength: 2048 });
  registerWechatCredential(f.database, f.masterKey, { id: "platform", appId: "wx-app", merchantId: "merchant", platformKey: f.platform.publicKey.export({ type: "spki", format: "pem" }).toString(), platformKeyId: "platform", apiV3Key: "x".repeat(32), validFrom: now, validUntil: now + 86400000, actor: "test" }, now);
  registerWechatSigningKey(f.database, f.masterKey, { id: "signing", appId: "wx-app", merchantId: "merchant", serial: "merchant-serial",
    privateKey: signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKey: signing.publicKey.export({ type: "spki", format: "pem" }).toString(), validFrom: now, validUntil: now + 86400000, actor: "test" }, now);
  f.database.write(sql => sql.exec("INSERT INTO epay_wechat_site_bindings SELECT client_id,'wx-app','merchant',0 FROM epay_site_bindings"));
  const fields = { pid: "1", type: "wxpay", out_trade_no: "expired", money: "1.01", name: "fixture", notify_url: "https://merchant.example/notify", clientip: "127.0.0.1", device: "pc" };
  const created = createExactWechatOrder(f.database, f.masterKey, { ...fields, sign: epaySign(fields, "epay-key-1"), sign_type: "MD5" }, "api", "platform", now);
  f.database.write(sql => sql.prepare("INSERT INTO epay_wechat_submissions VALUES(?,?,'UNCERTAIN',NULL,NULL,?,?)").run(created.tradeNo, "00000000-0000-4000-8000-000000000001", now, now));
  let clock = now, state = "NOTPAY", closes = 0, reads = 0, invalidFinal = true;
  const signedResponse = (body: string, status = 200) => {
    const timestamp = String(Math.floor(clock / 1000));
    return new Response(status === 204 ? null : body, { status, headers: { "content-type": "application/json", "wechatpay-serial": "platform", "wechatpay-timestamp": timestamp, "wechatpay-nonce": "fixture",
      "wechatpay-signature": sign("RSA-SHA256", Buffer.from(`${timestamp}\nfixture\n${body}\n`), f.platform.privateKey).toString("base64") } });
  };
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.origin, "https://api.mch.weixin.qq.com");
    if (init?.method === "POST") {
      closes++; assert.ok(url.pathname.endsWith(`/${created.tradeNo}/close`));
      assert.deepEqual(JSON.parse(String(init.body)), { mchid: "merchant" });
      assert.equal(f.database.read(sql => sql.prepare("SELECT status FROM epay_orders WHERE trade_no=?").get(created.tradeNo)?.status), "PENDING");
      state = "CLOSED"; return signedResponse("", 204);
    }
    reads++;
    const body = JSON.stringify({ appid: "wx-app", mchid: "merchant", out_trade_no: created.tradeNo, trade_state: state,
      amount: state === "CLOSED" && !invalidFinal ? undefined : { total: state === "CLOSED" ? 102 : 101, currency: "CNY" } });
    return signedResponse(body);
  };
  const options = { database: f.database, masterKey: f.masterKey, tradeNo: created.tradeNo, signingKeyId: "signing", transport, clock: () => clock };
  try {
    f.database.write(sql => sql.prepare("UPDATE epay_orders SET status='CLOSED' WHERE trade_no=?").run(created.tradeNo));
    assert.equal(f.database.read(countWechatSubmissionViolations), 1, "a closed order without authenticated closure evidence remains invalid");
    f.database.write(sql => sql.prepare("UPDATE epay_orders SET status='PENDING' WHERE trade_no=?").run(created.tradeNo));
    assert.equal((await closeExpiredWechatOrder(options)).closed, false);
    assert.equal(closes, 0); assert.equal(reads, 0);
    clock += 16 * 60000;
    await assert.rejects(closeExpiredWechatOrder(options), /amount/);
    assert.equal(closes, 1);
    assert.equal(f.database.read(sql => sql.prepare("SELECT status FROM epay_orders WHERE trade_no=?").get(created.tradeNo)?.status), "PENDING");
    invalidFinal = false;
    assert.equal((await closeExpiredWechatOrder(options)).closed, true);
    assert.equal(closes, 1, "signed CLOSED observation must not submit another close");
    assert.equal(f.database.read(sql => sql.prepare("SELECT status FROM epay_orders WHERE trade_no=?").get(created.tradeNo)?.status), "CLOSED");
    assert.equal(Number(f.database.read(sql => sql.prepare("SELECT count(*) n FROM epay_balance_ledger").get()?.n)), 0);
    assert.equal(Number(f.database.read(sql => sql.prepare("SELECT count(*) n FROM epay_callback_jobs").get()?.n)), 0);
    assert.equal(f.database.read(countWechatSubmissionViolations), 0, "verified closure must pass startup integrity checks");
    const restoredPath = join(f.directory, "closed-restored.sqlite3");
    await f.database.backup(restoredPath);
    const restored = await AppDatabase.open(restoredPath, { masterKey: f.masterKey });
    try { assert.equal(restored.read(countWechatSubmissionViolations), 0); }
    finally { restored.close(); }
  } finally { f.close(); }
});
