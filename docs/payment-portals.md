# StarPAY 管理员端与商户端

两端基于同一 React/Vite 构建，使用 StarMC 登录与实时权限校验。

- `/pay/admin/`：全站统计、商户管理、订单、通知、账本、退款与提现审批。
  商户详情 `/pay/admin/merchants/:merchantId/overview` 包含余额调整、费率、
  成员、资料和历史发票；普通商户直接打开管理端会看到无权限页面。
- `/pay/merchant/`：当前授权商户的统计、收款、订单、通知、账本、退款和提现
  申请、历史发票、API 接入和资料。管理员进入此入口也使用商户视图。
- 原 `/pay/merchant?merchantId=...`、`/pay/admin/merchants` 和
  `merchant-workspace` 书签保留兼容。深层页面可以直接打开和刷新。

## 数据与身份

收款趋势按北京时间汇总网关订单的原始收款金额和时间，缺少时间的记录单独
提示。主站历史订单保留来源和原始编号，不凭同额或相似编号合并。可用与冻结
余额来自核验后的统一账本，归属未确认的商户不显示可支配余额。

服务器在每次请求时核对主站会话和本地绑定，全站查询必须有管理员权限。
浏览器收到的目录只含当前身份可访问的商户。缓存恢复及身份变化会隐藏旧内容
并清除记录缓存。详细操作范围见 [权限说明](profile-permissions.md)。

## 实现与回归

- `web/src/portal/`：布局、导航、概览、记录和业务操作。
- `src/epay-compat/portal-routes.ts`：实时身份检查及读事务内绑定复核。
- `src/epay-compat/portal-read-model.ts`：不返回密钥、原始回调或渠道配置的投影。
- `ui-tests/payment-portals.spec.ts`：双端 320/390/1440px、主题、导航及权限降级。
- `ui-tests/portal-permissions.spec.ts`：所有者、成员、越权 URL 及缓存恢复隔离。
- `ui-tests/epay-merchant-fee-live.spec.ts`：合成商户真实后端费率写入、审计与登出。

页面测试使用隔离数据，不表示真实收款已确认。新开票保持关闭；资金闭环及
生产恢复要求见 [开发交接](starpay-handoff.md)。公开仓库不保存业务截图或生产快照。
