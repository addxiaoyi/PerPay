# StarPAY 商户数电开票接入

本轮为 PerPay `1.0.0-rc.13` 增加微信支付服务商电子发票接口和商户后台入口。数据库新增 migration 69，旧发票记录继续单独展示。代码接入不等于开通税务权限；当前未部署、未申请服务商产品、未签约、未开出真实发票。

上海舵星目前确认只有普通商户。该商户可以接受腾讯数电服务商邀请，但普通商户凭据不能调用下述服务商接口。采用外部服务商时，须先取得并适配其商户侧API或委托调用契约；不能仅凭邀请把外部服务商的共享私钥放入本系统。下述直连配置适用于本企业已合法拥有相应服务商能力的情形。

## 业务范围

- 由接入 StarPAY 的商户以自己的主体开票，不用平台公司的税号为其他商户开票。
- 当前适配微信 `issue-general` 的 `WECHAT_PAY` 交易，提供数电普通发票。支付宝订单和专用发票暂不支持。
- 订单必须由服务端确认支付成功，且实际微信收款商户号与已绑定的开票商户号一致。平台统一代收的订单不能直接套用其他商户主体；这种业务需另行接入合法的商户收款及开票方案。
- 一次申请对应一笔完整订单。正在退款、已退款、有旧发票或旧开票申请的订单不能重复开票。
- 可通过商户后台或业务服务器签名接口提交、查询及下载；后台自动同步处理中及结果不明的申请。没有客户免登录申请入口、自定义结果通知 webhook 或自动红冲操作。
- 自动化调用必须在真实销售及客户开票资料齐全后触发；不以支付成功或充值金额自动推断消费内容。当前每商户配置一套项目、税收分类和税率，仅适用于已确认使用同一税务分类的业务。

## 开通顺序

1. 在微信支付服务商平台开通“电子发票”，配置数电资源、发票卡券模板和产品开发选项。这些权限独立于普通微信收款权限。
2. 使用现有微信凭据注册流程保存服务商签名私钥及验签凭据。后台入口对应 `/api/admin/v1/epay/wechat-credentials`。签名钥必须属于同一服务商，凭据须在有效期内且未撤销；不要把支付直连商户凭据误当作服务商开票权限。
3. 通过部署环境引用已注册的凭据 ID；私钥、API v3 密钥不进入前端或商户表单：

   ```dotenv
   PERPAY_TAX_INVOICE_ENABLED=true
   PERPAY_TAX_INVOICE_AUTO_SYNC_ENABLED=true
   PERPAY_TAX_INVOICE_WECHAT_CREDENTIAL_ID=<已注册的服务商验签凭据ID>
   PERPAY_TAX_INVOICE_WECHAT_SIGNING_KEY_ID=<同一服务商签名密钥ID>
   ```

   默认关闭。未配置时，管理员可在处于正常运营模式的后台准备商户资料，申请按钮保持不可用。旧 `PERPAY_EPAY_INVOICE_ENABLED` 是历史申请流程的开关，不是本功能开关。
4. 平台管理员在商户“发票”页面绑定实际收款微信商户号、销方名称与税号，填写会计确认的税目名称、税收分类编码和税率。首次保存时关闭“启用本商户开票”，开票员 ID 可以留空。每个微信商户号只能绑定一个 StarPAY 商户。
5. 商户负责人打开“获取微信授权入口”，在微信及税务流程中完成授权。商户自身需满足数电发票资格、可用额度等条件，不能从支付产品已开通推断已经具备开票资格。
6. 点击“检查开票授权”，获取当前商户可用开票员名单。管理员明确选择开票员并启用。接口会验证数电资源、基础授权、授权有效期及开票员。
7. 以经过核实的真实微信订单验证提交、查询、票号、销方/购方、金额及文件下载。不要把未支付测试单用作真实开票交易。

## 状态和重试

HTTP 202 表示受理，对应“处理中”，不是已开票。查询必须验签，并核对申请、尝试 ID、交易金额、销方和购方；只有确认 `ISSUED` 才展示票号并允许获取文件。

每笔订单的申请号保持稳定，各次开具使用独立尝试 ID。未知结果或网络超时保留原申请，重复提交不会再次开具；应查询原记录。只有明确未发送、已被拒绝，或再次查询证实失败的申请，才允许修正资料后再提交，同一订单最多五次尝试。已经红冲的订单本轮不重新开票。

同一申请号重试须保留原购方类型、抬头、税号和邮箱；允许修正税目、税率等开票配置，购方资料变化会拒绝且不会再次调用开具接口。

开票状态不明、处理中、已开票或红冲中的订单不能直接退款。通过上游完成红冲后，在 StarPAY 查询到 `REVERSED` 才解除这一限制；红冲失败会恢复原有效发票状态。新旧开票路径有双向数据库约束，避免并发重复开票。

下载链接从微信即时获取，有效期约 30 秒。后端重新核对状态并组装官方要求的参数，不把短期链接作为永久文件地址存库。过期后重新点击获取即可。

自动查询默认每 30 秒启动一批，单批最多 20 笔，请求间隔 1 秒、单次查询最多 10 秒；只处理 `UNKNOWN / PROCESSING / REVERSING`，不会自动重提开票。待处理索引与原子认领避免重复查询和扫描全部历史，停止进程时取消查询并丢弃迟到结果。已终态的 `ISSUED` 不持续轮询外部红冲，下载前和人工刷新时会重新核对。

`PERPAY_TAX_INVOICE_AUTO_SYNC_ENABLED=false` 可单独停用后台查询；全局开票默认仍关闭。页面仅在有待处理记录且服务启用时每 5 秒读取本地列表，所有记录终态或页面在后台时停止。

## 业务服务器自动化接口

部署前缀为 `/pay` 时，入口为 `/pay/epay/tax-invoices`。三项操作均为 POST JSON，签名沿用现有商户 API ID/secret，但要求签名正文内有固定 `operation` 及绑定的主站 `merchantId`。`merchantId` 不是易支付 pid。不能使用 Cookie 替代接口签名，也不能通过此入口修改销方、税目或授权。

- `/applications`：`{operation:"starpay.invoice.create.v1",merchantId,application:{requestId,tradeNo,buyerType,title,taxId,email}}`。`requestId` 为业务服务器持久保存的 16–80 位唯一请求标识；`tradeNo` 是平台订单号。禁止传金额、税率或销方覆盖参数。
- `/query`：`{operation:"starpay.invoice.query.v1",merchantId,invoiceId}`。只读本地状态，由后台同步微信结果；建议调用方每 30 秒查询，达到终态即停止。
- `/files`：`{operation:"starpay.invoice.files.v1",merchantId,invoiceId}`。已开票并再次核实有效后返回临时文件 URL。

签名头为 `x-lightpay-api-id`、`x-lightpay-timestamp`（Unix 秒）和 `x-lightpay-signature`。签名计算 `sha256=` 加 `HMAC-SHA256(secret, timestamp + "\n" + 原始JSON正文)` 的小写十六进制值。服务端只接受前后 5 分钟以内的时间戳，且通过本机 identity bridge 校验当前商户绑定。

Node 服务端调用示例（secret 仅放服务端；申请正文须由实际业务生成并持久保存）：

```js
import { createHmac } from "node:crypto";

async function invoiceRequest(endpoint, command) {
  const root = new URL(process.env.STARPAY_INVOICE_URL);
  if (root.protocol !== "https:" || root.username || root.password || root.search || root.hash || !root.pathname.endsWith("/"))
    throw new Error("invalid invoice origin");
  const apiId = process.env.STARPAY_API_ID;
  const secret = process.env.STARPAY_API_SECRET;
  if (!apiId || !secret) throw new Error("merchant credentials are required");
  if (!["applications", "query", "files"].includes(endpoint)) throw new Error("invalid invoice endpoint");
  const body = JSON.stringify(command);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret).update(`${timestamp}\n${body}`).digest("hex");
  const response = await fetch(new URL(endpoint, root), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { "content-type": "application/json", "x-lightpay-api-id": apiId,
      "x-lightpay-timestamp": timestamp, "x-lightpay-signature": `sha256=${signature}` },
    body,
  });
  const reply = await response.json();
  if (!response.ok || reply.ok !== true) throw new Error(`invoice request failed: ${reply.code ?? response.status}`);
  return reply.data;
}
```

`STARPAY_INVOICE_URL` 设置为以 `/` 结尾的完整前缀，例如 `https://star-web.top/pay/epay/tax-invoices/`。创建返回 202 仅代表处理中/结果未知，不代表已开票。调用超时应保留原 `requestId` 和购方正文重新获取原记录，再用返回的 `invoice.id` 查询；不得生成新标识盲目补开。代码不自动向任意回调地址推送客户或发票资料。

## 只读上线检查

在目标服务相同环境变量下执行：

```sh
node --experimental-strip-types scripts/audit-invoice-readiness.ts --database /absolute/path/store.sqlite --merchant-id 1001
```

此处 `--merchant-id` 是 StarPAY/易支付商户 ID。脚本仅检查数据库与配置元数据，不迁移、不解密、不请求微信；exit 0 表示本地配置齐全，exit 2 表示缺项，exit 1 表示检查未完成。`readyToIssue` 固定为 false，必须单独验收腾讯数电授权、税务票种及额度、卡券模板和真实交易。业务服务器调用还需要保留已有 `PERPAY_EPAY_SHADOW_IDENTITY_ORIGIN` 及 `PERPAY_EPAY_MAIN_BRIDGE_SECRET_FILE` 配置。

## 后台接口

以下路径相对于 `/pay/api/merchant/epay/tax-invoices`（实际前缀按部署 `basePath`）。每次请求带 `merchantId` 查询参数，使用现有 StarMC 商户会话认证；写入需同源 `Origin` 和 `/session` 签发的 `x-csrf-token`。

- `GET /session`：权限、服务配置、商户资料和 CSRF token。
- `GET /?page=1`：当前商户申请记录，每页 20 条。
- `POST /profile`：仅平台管理员保存主体及税目配置，使用 `expectedVersion` 防覆盖。
- `POST /invite`：获取商户授权入口。
- `POST /authorization`：核对授权，返回 `profile` 和 `billingPersonIds`；不会自动启用商户。
- `POST /applications`：商户负责人或管理员提交 `{requestId,tradeNo,buyerType,title,taxId,email}`。企业需要税号，个人税号为空；金额只从订单读取。
- `POST /:id/refresh`：查询该商户原申请。
- `POST /:id/files`：取得当前有效发票下载链接。

普通成员只能查看记录。跨商户读写、过期会话、跨站写入或 CSRF 不匹配均拒绝。开发测试仅使用隔离数据库和合成签名响应，不发真实税票。

## 发布与回退

部署前先备份生产数据库、现有代码及服务配置。先在生产数据库的隔离副本上应用 migration 69 并跑完整性检查；不把测试开票请求发送到真实接口。发布后先保持 `PERPAY_TAX_INVOICE_ENABLED=false`，完成平台开通与逐商户核对后再开启。

本轮在尚未发布的 schema 69 中增加 `epay_tax_invoice_pending_query` 部分索引，migration 校验和随之变化。早期本地 schema 69 候选副本应从迁移前备份重新演练，不能直接当作新版迁移验收；不得为通过校验而修改真实数据库中的历史校验和。2026-11-21 实际生产基线已核验为 rc.10 / schema 66，隔离副本已完成 66→69 及备份恢复至66的演练，详见 `artifacts/invoicing-20261121/migration-rehearsal.md`。

停用功能可将新开票开关关闭；已开票历史和税务义务不会因此撤销。现行生产 rc.10 的数据库为 schema 66，不能直接把该旧程序运行在 schema 69 数据库上。代码回退需配套维护窗口和备份恢复，且必须核对备份后新增的支付与发票记录，不能覆盖真实交易。

## 官方依据（2026-11-21 核对）

- [服务商开票准备](https://pay.wechatpay.cn/doc/v3/partner/4015792554)
- [开发指引](https://pay.wechatpay.cn/doc/v3/partner/4015792556)及[卡券模板](https://pay.wechatpay.cn/doc/v3/partner/4015792562)
- [商户授权状态](https://pay.wechatpay.cn/doc/v3/partner/4015792561)及[授权邀请](https://pay.wechatpay.cn/doc/v3/partner/4015941495)
- [通用行业开具接口](https://pay.wechatpay.cn/doc/v3/partner/4015792574)及[查询接口](https://pay.wechatpay.cn/doc/v3/partner/4015792567)
- [文件信息](https://pay.wechatpay.cn/doc/v3/partner/4015792576)及[文件下载](https://pay.wechatpay.cn/doc/v3/partner/4015792569)
- [服务商常见问题](https://pay.wechatpay.cn/doc/v3/partner/4016960715)
