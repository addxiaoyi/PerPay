import assert from "node:assert/strict";
import { it } from "node:test";
import { createMainNativeOrder, readMainOrderContract } from "../src/epay-compat/main-native-order.ts";
import { mainOrderFixture, mainIdentity, mainInput } from "./epay-main-native-fixture.ts";
const now = 1_800_000_000_000;

it("atomically persists exact payment intent and an encrypted immutable main-site callback identity", async () => {
  const f = await mainOrderFixture();
  try {
    const order = createMainNativeOrder({ ...f, identity: mainIdentity, input: mainInput, now });
    assert.equal(order.created, true);
    assert.match(order.orderId, /^[a-f0-9-]{36}$/);
    const contract = f.database.read(sql => readMainOrderContract(sql, f.cipher, order.tradeNo, 1));
    assert.equal(contract?.apiId, mainIdentity.apiId);
    assert.equal(contract?.secret, mainIdentity.callbackSecret);
    assert.equal(contract?.orderId, order.orderId);
    const raw = f.database.read(sql => sql.prepare("SELECT * FROM epay_main_native_orders WHERE trade_no=?").get(order.tradeNo));
    assert.equal(JSON.stringify(raw, (_, value: unknown) => typeof value === "bigint" ? value.toString() : value).includes(mainIdentity.callbackSecret), false);
    const repeat = createMainNativeOrder({ ...f, identity: mainIdentity, input: mainInput, now: now + 1 });
    assert.equal(repeat.created, false);
    assert.equal(repeat.orderId, order.orderId);
    assert.equal(repeat.tradeNo, order.tradeNo);
    assert.throws(() => f.database.write(sql => sql.prepare("DELETE FROM epay_main_native_orders WHERE trade_no=?").run(order.tradeNo)), /immutable/);
  } finally { f.close(); }
});

it("rejects changed parameters and historic ownership without guessing; same external number stays merchant scoped", async () => {
  const f = await mainOrderFixture();
  try {
    const first = createMainNativeOrder({ ...f, identity: mainIdentity, input: mainInput, now });
    for (const patch of [{ amount: "1.02" }, { subject: "不同商品" }, { notifyUrl: "https://merchant.example/other" }]) {
      assert.throws(() => createMainNativeOrder({ ...f, identity: mainIdentity, input: { ...mainInput, ...patch }, now }), /conflict/);
    }
    assert.throws(() => createMainNativeOrder({ ...f, identity: mainIdentity, input: { ...mainInput, merchantOrderId: "historic-order" }, now }), /legacy/);
    assert.throws(() => createMainNativeOrder({ ...f, identity: { ...mainIdentity, epayMerchantId: 2 }, input: mainInput, now }), /binding/);
    const second = createMainNativeOrder({ ...f, identity: { ...mainIdentity, merchantId: "main-2", apiId: "lp-2", epayMerchantId: 2 }, input: mainInput, now });
    assert.notEqual(second.tradeNo, first.tradeNo);
    assert.equal(Number(f.database.read(sql => sql.prepare("SELECT count(*) n FROM epay_orders").get()?.n)), 2);
  } finally { f.close(); }
});

it("rolls back the payment intent if callback contract persistence fails", async () => {
  const f = await mainOrderFixture();
  try {
    f.database.write(sql => sql.exec("CREATE TRIGGER injected_main_failure BEFORE INSERT ON epay_main_native_orders BEGIN SELECT RAISE(ABORT,'injected contract failure'); END"));
    assert.throws(() => createMainNativeOrder({ ...f, identity: mainIdentity, input: mainInput, now }), /injected/);
    for (const table of ["epay_orders", "epay_alipay_intents", "epay_main_native_orders", "epay_callback_jobs", "epay_balance_ledger"]) {
      assert.equal(Number(f.database.read(sql => sql.prepare(`SELECT count(*) n FROM ${table}`).get()?.n)), 0, table);
    }
  } finally { f.close(); }
});

it("rejects unsupported channel modes and fractional cents before any write", async () => {
  const f = await mainOrderFixture();
  try {
    for (const patch of [{ channel: "wechat_jsapi" }, { channel: "wechat_h5" }, { channel: "alipay_unknown" }, { amount: "0.001" }, { amount: "0" }, { amount: 1.001 }, { merchantId: "main-2" }]) {
      assert.throws(() => createMainNativeOrder({ ...f, identity: mainIdentity, input: { ...mainInput, ...patch }, now }));
    }
    assert.equal(Number(f.database.read(sql => sql.prepare("SELECT count(*) n FROM epay_orders").get()?.n)), 0);
  } finally { f.close(); }
});
