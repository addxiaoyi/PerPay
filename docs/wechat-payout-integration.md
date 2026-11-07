# 微信零钱授权与出款接入

rc.12 实现普通商户的“用户授权免确认”模式，默认关闭。生产已配置的收款证书不等于
商家转账、授权免确认场景和公众号 OAuth 已获授权。需先核对商户平台产品、场景和额度。

## 接入条件与组合

服务内部配置必须包含固定付款商户号、绑定 AppID、已注册的签名密钥/平台证书 ID、
已批准场景 ID、真实场景报备资料、HTTPS 无参数授权通知地址和用户展示名称。
OAuth 需要同一 AppID 的公众号 AppSecret、网页授权域名与返回地址，密钥仅从受控配置读取。

`createWechatPayoutService` 提供授权、回调和 `PayoutAdapter`；
`createPayoutRuntime` 接受显式的限额策略和适配器，返回可传给 `createApp` 的 `payouts`。
宿主负责调用 runtime.start/stop，并保证授权服务、worker、API 使用同一配置。
示意（凭据通过内部配置取得，不能来自商户请求）：

```ts
const wechat = createWechatPayoutService(trustedWechatOptions);
const payouts = createPayoutRuntime({ database, cipher, policy, adapters: { wechat: wechat.adapter }, wechat, onError });
const app = createApp({ ...dependencies, payouts: payouts.services });
// 仅完成渠道权限与真实小额验收的候选环境才能启用 policy.enabled。
await payouts.start();
```

当前主程序未配置此注入，生产真实出款继续关闭。本版本增加可运行组合与隔离测试，
不将未确认的银行/钱包权限伪装成可用通道。

## 商户流程

1. 所有者在微信打开提现页面，填写真实姓名并完成 OAuth。服务端向固定官方地址交换
   一次性 code，state 绑定当前会话、商户、用户及 AppID，十分钟过期，只能消费一次。
2. 创建加密收款账户后等待管理员核对、批准。以前手填 OpenID 的账户仍保留，不能据此授权出款。
3. 本人点击“确认或刷新微信授权”，后端创建持久授权单。前端使用
   `WeixinJSBridge.invoke('requestMerchantTransfer', {mchId, appId, package})` 打开微信授权页。
   JSBridge 返回成功只代表页面返回；后端再次查授权才能显示生效。
4. 每次新出款前查询授权，必须为 `TAKING_EFFECT`，核对固定商户、应用、场景和收款身份。
   收款姓名使用平台公钥 RSA-OAEP 加密。查询出款时逐项核对付款人、收款人、原单、金额和渠道流水。
5. 授权撤销回调验签、AES-GCM 解密并持久化后应答。迟到的生效通知不能重开已关闭的授权。
   新授权保留旧历史。超时只查原授权/原出款，已关闭授权不影响在途原单查询。

队列在标记“已提交”前先核验授权。预检查失败的订单保留待发送，管理员可以取消并解冻。
提交阶段遇到结果不明仍保持冻结，仅查原单；不能把授权关闭当成该笔付款失败。

前端需要微信内置浏览器与支持该接口的版本；正式环境必须验收授权域名、AppID 关联、
JSAPI 可用性及真实手机跳转。普通浏览器会显示“请使用微信打开”，不会把缺少 JSBridge 当成功。
隔离浏览器测试使用桥接替身，不等于微信真机验收。

## 路由

以 `/api/merchant/epay/payouts` 为基础路径：

- POST `/wechat/binding/begin`：`{holderName}`。
- POST `/wechat/binding/complete`：`{state,code}`，消费前后核对当前主站权限。
- GET `/accounts/:id/wechat`：当前商户授权状态，不返回授权令牌。
- POST `/accounts/:id/wechat/authorize`：空 JSON，只有绑定该账户的本人可以操作。
- POST `/wechat/notify`：渠道通知，无用户会话，必须通过渠道签名和解密校验。

商户路由需 `merchantId`、实时主站会话；POST 另需同源和 CSRF token。成员不能绑定/授权，
管理员也不能替另一个用户点击本人授权。通知地址包含部署基础路径，例如
`https://example.test/pay/api/merchant/epay/payouts/wechat/notify`。

授权 package、授权号、收款身份和 OAuth 临时姓名均加密保存；code/access token 不入库。
重启保留授权和出款记录，禁止将授权撤销视为付款失败并自动解冻。

## 官方参考

- [申请授权](https://pay.wechatpay.cn/doc/v3/merchant/4015901167)
- [授权查询](https://pay.wechatpay.cn/doc/v3/merchant/4014399423)
- [授权后转账](https://pay.wechatpay.cn/doc/v3/merchant/4014399371)
- [授权通知](https://pay.wechatpay.cn/doc/v3/merchant/4014512908)
- [JSAPI 授权](https://pay.wechatpay.cn/doc/v3/merchant/4015930512)
