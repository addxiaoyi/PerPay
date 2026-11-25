export const balanceCreateCode = `import { StarPayBalanceClient } from './balance-payment.mjs';

const client = new StarPayBalanceClient({
  baseUrl: 'https://star-web.top/pay',
  pid: process.env.STARPAY_PID,
  key: process.env.STARPAY_KEY,
  notifyUrl: 'https://shop.example/api/payments/starpay/notify'
});

const payment = await client.create({
  merchantOrderId: 'ORDER_20261123_001',
  amount: '10.00',
  subject: '实际商品或服务',
  returnUrl: 'https://shop.example/payment-result'
});
// 先保存 payment.order.id 与本地业务订单的关联，再跳转 payment.checkoutUrl。`;

export const balanceCallbackCode = `// request 为标准 Request；saved 必须来自本站已保存订单。
// 通知只用未验签的 merchantOrderId 查找订单，不能据此认定支付成功。
const rawBody = await request.text();
const verified = await client.verifyPaidCallback(rawBody, request.headers, {
  paymentOrderId: saved.paymentOrderId,
  merchantOrderId: saved.merchantOrderId,
  amount: saved.amount,           // "10.00"
  amountCents: saved.amountCents  // 1000
});
if (!verified.paid) return new Response('not paid', { status: 409 });
// 同一数据库事务：通知 ID 去重 + 订单唯一确认 + 唯一发货任务。
await orders.confirmPaymentOnce(saved.id, verified.callbackId);
return Response.json({ ok: true });
// 验签、查单或事务失败，记录内部错误并返回非 2xx；不要发货。`;

export const balanceGuideSections = [
  { title: '1. 准备商户和服务器', text: ['在 API 接入页读取收款商户的 EPay PID 和 EPay MD5 签名密钥，分别配置 STARPAY_PID、STARPAY_KEY。余额支付使用同一个密钥做 HMAC-SHA256，SDK 自动计算；不要混用 StarMC API 密钥。', 'Node.js 22 或以上；密钥仅保存在服务器环境中。其他网站须适配余额支付接口，传统易支付插件只增加 type=balance 无法完成接入。', '通知地址必须是公网 HTTPS 域名，返回地址与通知地址同源。买家须拥有另一个 StarPAY 商户账户及足够可用余额。'] },
  { title: '2. 创建订单并跳转', text: ['网站后端先生成唯一业务订单，再按服务器确认的价格下单。业务单号为 3–64 位字母、数字、下划线或连字符；金额是元单位字符串，最多两位小数。', '保存平台订单 ID、业务订单号和金额分值之后再跳转。超时后复用原订单号和全部原参数重试。订单有效期 20 分钟，充值不延长有效期。'], code: balanceCreateCode },
  { title: '3. 验签、查询与发货', text: ['回调是 POST JSON，保留原始请求体及 x-lightpay-timestamp、x-lightpay-signature、x-idempotency-key。不要先解析再重新序列化后验签。', 'SDK 验证原始签名、5 分钟时钟范围及保存的订单字段，并查询当前支付状态。回调接口采用签名鉴权，无需买家登录 Cookie。Express 中应在 JSON 中间件前保留 raw body。', 'orders.confirmPaymentOnce 是接入网站需要实现的事务方法，不是 SDK 方法。重复通知、浏览器回跳和晚到通知都不能再次发货。'], code: balanceCallbackCode },
  { title: '4. 查询和退款', text: ['查询结果为 pending、paid、refunded 或 expired。浏览器返回页面只展示本站后端确认的状态。', '当前仅支持全额退回原付款商户余额。退款请求号为 16–80 位字母、数字、下划线或连字符，先保存后提交，超时继续使用同一请求号。收款商户需有原净入账余额；关联发票需先完成对账。当前没有单独退款 webhook。'], code: "const { order } = await client.query(saved.paymentOrderId);\nawait client.refund(saved.paymentOrderId, 'refund_ORDER_20261123_001');" },
  { title: '5. 接口与常见错误', text: ['POST /pay/epay/balance/orders：创建；POST /pay/epay/balance/query：查询；POST /pay/epay/balance/refund：退款。请求签名串为秒级时间戳 + 换行 + 原始 JSON。', '401：PID、密钥、签名或服务器时钟有误；403：商户停用或权限不足；409：订单参数冲突、余额不足或当前状态不允许；429：请求过快；503：服务暂不可用，先查原单再重试。', '返回 HTML 404 通常表示网关地址或反向代理路由有误。密钥轮换后保留旧订单的回调密钥，查单使用当前密钥；详见 SDK README。', '收款手续费按商户费率计算；100 元／365 天开票服务是独立服务，不是 SDK 接入费。'] },
];
