import assert from "node:assert/strict";
import { it } from "node:test";
import { validateGatewayCallbackUrls } from "../src/epay-compat/isolated-payment-runtime.ts";

it("requires provider callbacks to share the mounted gateway prefix", () => {
  assert.doesNotThrow(() => validateGatewayCallbackUrls("https://gateway.example/pay/new/alipay/notify", "https://gateway.example/pay/new/wechat/notify"));
  assert.doesNotThrow(() => validateGatewayCallbackUrls("https://gateway.example/alipay/notify", "https://gateway.example/wechat/notify"));
  const invalid: Array<[string, string]> = [
    ["https://gateway.example/notify", "https://gateway.example/wechat/notify"],
    ["https://gateway.example/pay/api/pay/alipay/notify", "https://gateway.example/pay/new/wechat/notify"],
    ["https://other.example/alipay/notify", "https://gateway.example/wechat/notify"],
    ["https://gateway.example/alipay/notify?x=1", "https://gateway.example/wechat/notify"],
    ["https://gateway.example/%61lipay/notify", "https://gateway.example/wechat/notify"],
    ["http://gateway.example/alipay/notify", "http://gateway.example/wechat/notify"],
    ["https://gateway.example//alipay/notify", "https://gateway.example//wechat/notify"],
  ];
  for (const [alipay, wechat] of invalid) assert.throws(() => validateGatewayCallbackUrls(alipay, wechat), /gateway callback/);
});
