# 2026-11-23 安全升级后续

本次范围：准备并验证共享 Nginx 安全升级；升级旧 Next.js 支付前端并验证历史入口；恢复服务器磁盘余量，保留数据库与财务备份；只读核对超时订单。真实开票开关保持关闭。

## Nginx：候选已准备并验证，线上未切换

候选为 Nginx 1.30.7、OpenSSL 3.5.9、PCRE2 10.49、Lua 模块 0.10.29 和 lua-resty-core 0.1.32R1。保留 devel kit、cache purge、sticky、substitutions filter、DAV 等原有模块。旧 Lua 模块仍使用 PCRE1，首次链接失败后采用支持 PCRE2 的匹配模块组合，未通过额外链接旧 PCRE 库掩盖不兼容。

Nginx 官方源码包通过发布者 PGP 签名验证。OpenSSL、PCRE2 和 Lua 取自各项目官方 GitHub 标签源，记录并核对传输前后的 SHA-256；未把本地校验和描述为发布者签名。

已完成原有完整配置的语法检查，以及独立回环端口上的 TLS 1.2、TLS 1.3、HTTP/2、Lua 正则、WAF 初始化/请求和 speed Lua 请求测试。WAF 与 speed 脚本使用独立副本；线上 Nginx 主进程和 Lua 文件未替换。

服务器可审阅材料：

- `/opt/nginx-security-20261123/release/nginx.candidate`：新二进制。
- `/opt/nginx-security-20261123/release/free_waf.candidate.conf`：加入匹配 lua-resty-core 搜索路径的配置，目标为 `/www/server/panel/vhost/nginx/free_waf.conf`。
- `/opt/nginx-security-20261123/release/nginx.validation.conf`：验证用完整配置，不能直接替代线上主配置。
- `/opt/nginx-security-20261123/release/manifest.json`：源码/二进制、配置状态及线上配置文件校验和。
- `nginx.before` 和 `free_waf.before.conf`：回滚材料。

候选二进制 SHA-256：`c96a1ea79959fe2c76b613e38221286f73d72668b136c19957f6fde4cce4bc1d`。

后续真正切换前应重新核对 manifest 中的线上配置校验和，保留新旧 Lua 库与旧二进制；切换后验证各虚拟主机的证书、静态文件、代理路由、支付回调和 WebSocket。当前线上仍为 1.26.3，其漏洞尚未因候选验证而消除。

## 旧 Next.js：16.4.6 已部署

实际运行目录 `/www/wwwroot/epay-next-releases/20261123-security-v1`，PM2 名称 `epay-next-reconcile-v1`，端口 3023，Node.js 24.22.3。原目录及原数据库保留；静态资源别名与新构建同时切换。

构建、类型检查和 9 项支付验签回归通过，48 条路由与旧生产构建相同。无效支付宝回调返回 `fail`，无效微信回调返回 400，无凭据对账请求返回 401；健康检查和静态资源内容哈希通过。验证未创建真实支付、退款、充值或开票。

部署包的 29 个可识别包在官方 npm 公告查询中为 0 条匹配。完整开发锁文件仍有 Prisma CLI 链上的 4 个 high 条目（prisma、@prisma/config、deepmerge-ts、effect），这些包未进入部署包。未强行进行 Prisma 大版本迁移。

服务器原留存源码落后于已运行构建，缺少已部署的对账和 JSAPI 功能。本次恢复对应源码并核对路由清单；最终源码压缩包保存在 `/root/perpay-recovery-20261123-rc21/legacy-next-16.4.6-source.tar.gz`，本机依赖锁文件也已与部署对齐。源代码恢复清单见 `artifacts/security-20261123/legacy-source-restoration.json`。

## 磁盘：保留数据与发布目录，恢复余量

初始剩余约 175 MiB。逐文件核对历史 PerPay 依赖的内容、权限、属主和时间戳后，对非运行目录的相同文件使用硬链接去重；恢复到约 4,313 MiB 后停止继续去重。没有删除财务备份、生产库或回滚目录。后续候选构建占用部分余量，最终值以证据中的 `freeDiskMiB` 为准。

停用 19 个工作目录已删除的旧 EPay 进程；停用前核对 Nginx 端口引用、定时任务/服务文件和已建立连接。保留 PM2 私有快照，当前生产旧前端进程继续运行。

历史依赖目录现在可能共享 inode：后续修改历史依赖时应先创建独立副本，或用新文件原子替换，避免原地修改硬链接文件。

## 超时订单：60 笔官方查询，未发现待补偿支付

最初 59 笔；查询时另 1 笔跨过 24 小时阈值，共查 60 笔支付宝订单。5 笔为 `TRADE_CLOSED`，55 笔为 `TRADE_NOT_EXIST`。所有结果通过签名、时效及订单/账户绑定校验；已关闭订单同时核对金额，交易不存在响应不能提供金额证据。没有查到已付款但未入账的订单。

审计仅调用支付宝查单接口，SQLite 使用只读连接；没有修改订单状态，没有触发补偿、回调、退款或开票。查询前后所查订单的状态、金额、通知状态和支付时间字段一致。完整结果中的订单标识以哈希保存：`artifacts/security-20261123/aged-order-audit.json`。

## 运行稳定性与验证边界

批量去重和服务器编译期间出现高磁盘等待与交换分区活动，导致主站/PerPay 请求超时和源同步过期。已停止去重与编译，首次前端切换遇到超时后自动回滚；第二次切换因继承 PM2 控制字段导致工作目录错误而回滚。过滤 PM2 控制字段后第三次切换通过。PerPay 运行进程另做一次保留配置的重启。

后续连续检查曾再次观测到 PerPay 入口 504 和同步过期。旧 Next.js 健康检查持续通过。财务表无不一致记录，但同步过期会使总财务健康标志为 false；不能把一次成功探测等同于整机稳定，也不能据此屏蔽监控。失败阶段记录在 `artifacts/security-20261123/maintenance-final-observation.json`。

停止重型操作并重启 PerPay 后，最终旧前端存活、旧前端就绪、PerPay 支付就绪各检查三次，9 次均为 200。财务校验与支付恢复校验通过，源同步延迟 6,517 毫秒；磁盘余量 3,752 MiB。该结果是本次收尾窗口的恢复证据，保留此前的间歇故障记录，不视为长期压力验证。恢复证据为 `artifacts/security-20261123/maintenance-final-recovered.json`。

超时订单告警仍保留，未通过关闭订单或降低监控标准清除。源码、单元测试、候选启动、生产切换、整机持续健康分别记录，不互相替代。

官方依据：[Nginx 安全公告](https://nginx.org/en/security_advisories.html)、[OpenSSL 支持版本](https://openssl-library.org/source/)、[Next.js 独立部署输出](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)。
