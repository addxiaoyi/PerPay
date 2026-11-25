# StarPAY 通道实测 — 2026-11-07

测试使用现网保存的凭据，通过已配置跳板机执行。用户已授权自行测试各通道。
仅创建 ¥0.01 的未付测试订单；没有付款、退款、余额调整或测试商户回调。

## 已验证可用

- 支付宝电脑网站支付：经公网 `/api/merchant/orders` 下单返回 201，本站收银入口
  返回 303 到支付宝官方收银台。真实浏览器显示正确测试商品、收款方、¥0.01 和
  扫码付款二维码；图片加载成功。这里可用的是网页收银台提供的扫码方式。
- 微信 Native：同一公网入口下单返回 201，得到 `weixin://` code_url，本站收银页
  返回 200 和 280×280 二维码。对实际页面中的 PNG 解码，结果与官方响应中的
  code_url 完全相同。

## 已发现限制

- 支付宝独立当面付预下单：保存的主站模式包含 alipay_scan，密钥和证书均已保存。
  实际调用 V3 `/v3/alipay/trade/precreate` 返回 HTTP 400、`ACQ.ACCESS_FORBIDDEN`；
  再用原系统使用的 `alipay.trade.precreate` 验证，HTTP 200 中的业务 code 为 40004、
  sub_code 同为 `ACQ.ACCESS_FORBIDDEN`。两份响应均通过平台 RSA 验签，没有二维码。
  不能把“已填写配置”或“网页支付可用”当作独立当面付接口已经授权。
- 微信公众号 JSAPI：原 MySQL 通道和迁移后的通道均为 enabled=false。通道使用与
  Native 相同的支付凭据，但未保存 appSecret；主站 jsapiAppId、jsapiNotifyDomain
  也未配置。没有此次测试用户的有效授权 OpenID，因此未创建 JSAPI 预支付会话。
- 微信小程序：同样保持原来的停用状态，没有独立 miniprogramAppId 或实际小程序
  授权上下文。不能通过生成一个 Native 二维码来宣称小程序支付已经跑通。
- 微信 H5：原库没有 H5 通道记录；主站模式只有 wechat_native，h5Domain 为空。
  未配置完整，未作为可用通道调用。

微信官方说明 JSAPI 下单必须传对应 AppID 下的 OpenID；公众号和小程序返回的是
唤起支付所用的 prepay_id，而非通用付款二维码：
https://pay.weixin.qq.com/doc/v3/merchant/4012791870

## 测试订单与收尾

测试只在管理员自己的商户（1001）创建两笔带 `SPV_` 前缀的 ¥0.01 订单。
微信关单接口返回已验签响应，后续官方查单为 CLOSED，本地同步 CLOSED。
支付宝网页虽展示收银码，但尚未在交易查询侧创建交易；查单及关闭请求返回已验签的
TRADE_NOT_EXIST，本地测试记录关闭。此结果不应写成“支付宝已有交易已关闭”。
两笔本站收银链接重新访问均显示“订单已关闭”。原始记录和关闭审计保留。

测试订单账本入账为 0、回调任务为 0。最终只读检查 financialHealthy=true，四个
商户余额核对一致；两笔原有真实成功付款和已送达回调保持原状态。现网仍为 live/ready。

服务器证据在 `/root/perpay-recovery-20261106-rc10/channels-acceptance-20261107.json`，
本地脱敏副本在 `release/channels-acceptance-20261107.json`。签名支付链接和原始响应
仅保存于私有验收文件，原始响应加密保存；不得提交到公共仓库。
实际页面截图为 `release/alipay-channel-verified.jpg`、`release/wechat-channel-verified.jpg`。

## 可复用检查脚本

- `probe-alipay-qr-live.ts`：一次 V3 当面付预下单，验证平台签名，成功时关闭测试交易。
- `probe-alipay-legacy-qr-live.ts`：一次原版接口预下单，校验原始响应片段签名。
- `probe-public-collections-live.ts`：使用现有商户 HMAC 验证公网下单和收银页。
- `close-channel-probes-live.ts`：仅处理对应私有清单中的两个 ¥0.01 测试单，以官方
  验签结果关闭，保留审计；不处理已付款订单，不修改金额和余额。

这些是显式人工验收工具，不得加入普通单元测试、定时任务或自动发布检查。
