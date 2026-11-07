# StarMC 个人中心与 StarPAY 权限边界

StarMC 个人中心负责登录身份、账号资料和角色来源；StarPAY 不从浏览器文本、URL
参数或自定义请求头推断管理员身份。支付接口每次都向主站身份接口重新确认
`merchantId`、`apiId`、`userId` 和角色，再核对本地绑定。

| 主站身份 | StarPAY 访问级别 | 可见范围 |
| --- | --- | --- |
| `superadmin` / `admin` | `admin` | 全站总览、所有已授权商户、审批、余额调整、费率、成员和运行状态 |
| 商户所有者 | `owner` | 自己的商户订单、通知、余额、收款、申请和设置 |
| 已授权商户成员 | `member` | 自己被加入的商户记录和允许的申请功能；不能审批、调整余额、改费率或管理成员 |
| 未登录、没有商户授权、被撤销或商户停用 | 拒绝 | 返回 401/403/404，不返回其他商户数据 |

角色判定沿用主站 `utils/permission.js` 的规则：`superadmin` 包含 `admin`；
`owner` 和 `member` 不包含管理员能力。StarPAY 的 `authorizeMainAdmin` 只接受
实时返回的 `role=admin` 且必须有当前 `userId`。

主站普通用户无需管理员角色，只要是商户所有者或被加入该商户，即可获得对应
商户权限。`reviewer`、`moderator` 和 `sponsor` 不因此获得支付管理权；个人中心
使用的 `canManageUsers` 来自服务器角色计算，浏览器提交同名字段不能提升权限。

## 所有者与成员的操作范围

- 所有者和成员均可读取已授权商户的订单、通知、余额、账本和历史发票，创建收款，
  发起退款或提现申请。申请不等于审批通过或完成出款。
- 现有接入策略允许所有者和成员查看该商户的签名密钥。成员应视为可信业务操作人，
  不应将只需看报表的人员加入为成员。
- 所有者可修改商户资料、回调设置和轮换 EPay 密钥；成员不能执行这些操作。
- 成员管理、费率修改、余额调整、退款和提现审批、全站记录及运行状态仅管理员可用。
- 自动出款候选中，收款账户绑定和自动提现申请仅所有者/管理员可提交，成员可看脱敏
  列表；账户完整资料核对及审核仅管理员可用。渠道默认关闭，不因审核账户而开通。
- 管理员进入商户端时使用商户视图；管理操作从管理员端进入。维护期间可进一步
  关闭写入，但不会扩大任何角色的权限。

个人中心显示的“超级管理员”等文案只是账号展示。管理员页面
`/pay/admin/`、商户页面 `/pay/merchant/` 和全部 `/api/merchant/epay/*` 请求都以
当前主站会话为准。页面切回、浏览器恢复缓存、重新连接和刷新权限时会清除旧记录
查询，等待新的身份结果后再渲染，避免前一个账号的商户列表短暂残留。

验证依据：

- `test/epay-main-role-contract.test.mjs` 锁定主站角色到 StarPAY 级别的映射。
- `test/epay-main-identity-integration.test.mjs` 验证主站 access 接口、owner/member
  隔离、管理员审批权限和绑定变化拒绝。
- `test/epay-portal-permissions.test.ts` 使用 owner/member 两种身份验证跨商户、
  全站查询、伪造管理员请求头和财务写入均被拒绝。
- `test/epay-wechat-credential-admin.test.ts` 验证支付凭据管理仍要求当前管理员、
  同源和 CSRF。
- `ui-tests/portal-permissions.spec.ts` 验证手机和桌面端导航隐藏管理入口，并在
  缓存页面恢复期间隐藏旧管理员内容。

## 验证与维护

运行 `npm run test:permissions` 检查接口边界，运行
`npx playwright test ui-tests/portal-permissions.spec.ts --project core --workers=2`
检查桌面和手机导航、越权地址与缓存恢复。两条命令已接入 GitHub Actions。

2026-11-07 只读核对了主站个人中心构建产物、角色能力函数、资料更新函数及商户
授权路由。源码版本和内容摘要见 `test/fixtures/legacy-source-manifest.json`。
个人中心资料更新会忽略角色、能力与余额字段；测试验证伪造这些字段不能提权。
主站升级这些接口后须重新核对并更新夹具，当前测试不是对未来生产版本的保证。

这些测试使用隔离身份夹具，不包含生产 Cookie、密码、API 密钥或数据库快照，
也不表示登录过真实普通商户账号或完成真实资金操作。
