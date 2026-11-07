import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { epaySign, epaySignString, verifyEPaySign } from "../src/epay-compat/sign.ts";

describe("EPay legacy signatures", () => {
  it("uses the existing gateway's ordering and excludes empty and signature fields", () => {
    const params = { type: "alipay", pid: 1001, money: "0.01", name: "测试", empty: "", missing: null, sign: "ignored", sign_type: "MD5" };
    assert.equal(epaySignString(params), "money=0.01&name=测试&pid=1001&type=alipay");
    assert.equal(epaySign(params, "test-key"), "07136f917809bd11f0990b4ea6d2b5f1");
  });

  it("accepts uppercase signatures and rejects tampering and malformed input", () => {
    const params = { pid: "1001", money: "10.00", out_trade_no: "order-1" };
    const sign = epaySign(params, "test-key");
    assert.equal(verifyEPaySign({ ...params, sign: sign.toUpperCase() }, "test-key"), true);
    assert.equal(verifyEPaySign({ ...params, money: "11.00", sign }, "test-key"), false);
    assert.equal(verifyEPaySign({ ...params, sign: "zz" }, "test-key"), false);
    assert.equal(verifyEPaySign({ ...params, sign }, ""), false);
  });
});
