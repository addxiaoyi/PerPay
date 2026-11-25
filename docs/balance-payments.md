# 其他网站接入 StarPAY 商户余额支付

协议 v1，SDK rc.20。流程：接入网站创建业务订单 → StarPAY 收银台 → 买家选商户余额并确认 → 接入网站验签、查单、发货。

## 1. 下载与准备

下载 https://star-web.top/pay/epay/docs/balance-merchant-sdk.zip 。Node.js 22+，SDK 不需安装额外依赖。

文件：`balance-payment.mjs` 客户端、对应 `.d.mts` 类型、`balance-callback-handler.mjs` 回调模板及类型、`balance-selftest.mjs` 本地联调、本文。

在商户门户「API 接入」取收款商户的 **EPay PID** 和 **EPay MD5 签名密钥**，保存为服务器环境变量 STARPAY_PID、STARPAY_KEY。余额接口使用该密钥做 HMAC-SHA256，由 SDK 自动计算；不要混用 StarMC API 密钥。

已有 StarMC API ID/HMAC 接入也可用 `merchantId`、`apiId`、`apiSecret` 初始化客户端。两组凭据选择一组。主站模式的通知地址须匹配商户配置。

通知地址须是公网 HTTPS 域名，不能是 localhost 或 IP；返回地址必须与通知地址同源。密钥只放后端，不放浏览器、仓库或日志。买家需有另一个已启用、余额已核实的商户账户；不支持向同一商户付款。

## 2. 先运行无资金联调

```sh
node balance-selftest.mjs
```

脚本使用内存 transport，覆盖下单重试、查单、回调验签、重复发货保护、篡改拦截、时间戳超期、退款和退款后晚到通知。输出 passed:true、networkRequests:0、realDebits:0 才通过。它不连接任何网站。

门户「API 接入」和「功能文档 → API 与适配 SDK」也提供浏览器本地模拟验签。公开测试密钥不能用于真实商户，模拟成功不能代替真实凭据和回调连通验收。

## 3. 服务器下单

```js
import { StarPayBalanceClient } from './balance-payment.mjs';
const client = new StarPayBalanceClient({
  baseUrl: 'https://star-web.top/pay',
  pid: process.env.STARPAY_PID,
  key: process.env.STARPAY_KEY,
  notifyUrl: 'https://shop.example/api/payments/starpay/notify',
});
const payment = await client.create({
  merchantOrderId: 'ORDER_20261123_001',
  amount: '10.00',
  subject: '实际商品或服务',
  returnUrl: 'https://shop.example/payment-result',
});
// 先在数据库保存 payment.order.id 与本地业务订单、价格的关联。
// 保存完成后才把 payment.checkoutUrl 返回前端并跳转。
```

金额取服务器商品价格，使用元单位字符串，最多两位小数，不接受前端任意价格。业务单号为 3–64 位字母、数字、下划线或连字符。

本地至少保存业务订单号、平台订单 ID、金额分值、两位小数金额文本、商品、支付状态、下单密钥版本。下单超时复用原订单号和全部原参数重试；改金额或回调等字段会冲突。

订单有效期 20 分钟。余额不足时买家可以按差额充值并返回原订单，充值不延长有效期，不自动支付原订单。过期后须从接入网站取得新的支付订单，保留原订单记录。

## 4. 接收回调

回调为 POST JSON，必须保留原始请求体和三个头：`x-lightpay-timestamp`、`x-lightpay-signature`、`x-idempotency-key`。不能先 parse 再 stringify 来验签。Express 请在 JSON 中间件前保存 raw body；标准 Request 的示例可使用随包回调模板。

```js
import { balanceCallbackHandler } from './balance-callback-handler.mjs';
export const POST = balanceCallbackHandler({
  clientForOrder: async saved => client,
  orders: {
    findByMerchantOrderId: async merchantOrderId => {
      // 从自己的数据库读取已保存订单，未找到返回 null。
      return database.findPayment(merchantOrderId);
    },
    confirmPaymentOnce: async notice => {
      // 需自行实现事务：通知去重、订单唯一确认、唯一发货任务。
      await database.confirmPaymentAndQueueFulfillment(notice);
    },
  },
});
```

`database.*` 为接入网站需要实现的持久化方法。必须在数据库事务中以平台订单 ID 和通知 ID 做唯一约束，即使回调 ID 改变也不能重复发货。外部发货任务应使用事务 outbox 或等效的持久任务，不能先发货再写订单。

SDK 的 `verifyPaidCallback(rawBody, headers, expected)` 检查原始 HMAC、5 分钟时间窗、保存的订单号及金额，并主动查当前状态。只有返回 paid:true 才能确认付款。事务成功后返回 HTTP 2xx 的 `{ok:true}` 或 `success`。验签、查单、数据库失败时返回非 2xx，等待重试，不发货。

回调不依赖买家 Cookie；接入网站的防火墙应允许该精确路径由服务器访问并保留签名头。**浏览器回跳和支付截图不能证明到账。**返回页只显示自己后端确认的状态。

### 密钥轮换

新 API 请求用当前密钥；既有订单回调使用下单时密钥。按订单安全保存密钥版本，并为回调构造客户端：

```js
const client = new StarPayBalanceClient({
  baseUrl: 'https://star-web.top/pay',
  pid: process.env.STARPAY_PID,
  key: currentMerchantKey,
  callbackKey: keyForSavedOrder,
});
```

`callbackKey` 仅用于验回调，查单仍用 `key`。不轮换时省略即可。密钥按后端安全配置或加密存储管理，不在业务订单中明文保存。

## 5. 查询与退款

```js
const { order } = await client.query(saved.paymentOrderId);
// pending / paid / refunded / expired
await client.refund(saved.paymentOrderId, 'refund_ORDER_20261123_001');
```

先保存退款请求号，重试使用相同值（16–80 位字母、数字、下划线或连字符）。当前仅支持全额退回原付款商户余额，收款商户须拥有原净入账余额。有关联发票时先完成发票对账或红冲。当前不发单独退款 webhook，网站应依据退款响应和主动查单更新。

## 6. 非 Node 网站协议

三个接口均为 POST JSON：

- `https://star-web.top/pay/epay/balance/orders`，operation=`starpay.balance.create.v1`，附 order 对象（merchantOrderId、amount、subject、notifyUrl、returnUrl）。
- `https://star-web.top/pay/epay/balance/query`，operation=`starpay.balance.query.v1`，附 orderId。
- `https://star-web.top/pay/epay/balance/refund`，operation=`starpay.balance.refund.v1`，附 orderId、requestId。

PID 模式请求头：`x-starpay-pid`、`x-starpay-timestamp`、`x-starpay-signature`。签名值为 `sha256=` + HMAC-SHA256(key, 秒级时间戳 + 换行 + 原始JSON) 的小写十六进制。时间差不得超过 300 秒。传统易支付插件只加 type=balance 不够，需适配此协议。

请求体最多 8 KB，字段按接口定义发送。成功响应是 `{ok:true,data:{order,...}}`。错误是 `{ok:false,code,error}`。

## 7. 排错与上线验收

401：PID/密钥/签名或系统时钟不正确。403：商户停用或权限不足。409：订单参数冲突、余额不足、状态不允许。429：请求过快，稍后复用原单。503：服务不可用或结果未确定，先查原单。HTML 404：网关根地址或反向代理路由不正确；JSON balance_order_not_found：接口已到达但指定订单不存在。

验收正常支付、重复回调、无效签名、余额不足、退款、超时恢复及退款后晚到通知。模拟环境用自己的测试凭据和订单；不要向生产接口提交伪造支付证据。

收款手续费按商户费率计。100元/365天开票服务是独立服务，不是SDK接入费。该服务也不会替接入网站为所售商品开票。
