# 2026-11-23 支付服务安全核查

后续进展：旧 Next.js 已升级至 16.4.6，磁盘余量已恢复，超时订单已完成官方只读查询；共享 Nginx 1.30.7 候选已验证但尚未切换。以下保留首次核查基线，最新状态见 [安全升级后续](maintenance-followup-20261123.md)。

范围：PerPay rc.20 的锁定依赖、实际生产运行时、共享 Nginx 及仍服务历史路径的旧 Next.js 支付前端。采用官方 npm Advisory API、GitHub Reviewed 公告、Node.js 和 Nginx 官方公告，并核对本机/服务器版本与相关配置。未执行针对生产的攻击载荷，没有创建真实支付、退款或开票。

## PerPay 已部署 rc.21

- Hono 4.13.13 → 4.13.21。原版本命中五条公告：GHSA-h7mg-cq63-vhpq（通配中间件绕过）、GHSA-4m76-xfj5-7975（mount 前缀绕过）、GHSA-3gg2-335m-rxc6（css 插值 HTML 注入）、GHSA-46wx-v44x-9hh2（csrf 未处理 text/ping）、GHSA-4h7h-rv7c-7m2v（form validator 绕过）。项目使用默认路由和通配中间件；未发现使用上述 mount/css/csrf/form validator API 的生产代码。版本命中不等同于五条均可在本项目利用。
- @hono/node-server 2.1.5 → 2.1.11。原版本命中 GHSA-jpvv-r467-5p4w（反斜线路径重写导致代理与应用路径判断不同）、GHSA-qv5m-9pm6-hqp3（异步 WebSocket upgrade 的 ECONNRESET 可崩溃）。项目有 Nginx 路径分流，因此前者应优先修补；未发现服务端 WebSocket upgrade。
- Node.js 生产 24.22.1 → 24.22.3 安全版。同步提高项目最低版本、CI 和容器基础镜像，镜像使用已核实 digest。新二进制来自 nodejs.org，校验官方 SHA-256，安装到独立目录。PerPay 是 Nginx 后面的 HTTP/1 服务，不能将公告里所有 Node HTTP/2/TLS 服务端漏洞直接认定为本服务可利用；升级同时修补运行时依赖。
- npm 镜像 registry.npmmirror.com 不提供安全审计接口；原来的失败不能解释为无漏洞。改用 registry.npmjs.org 审计，升级后锁定的 401 个依赖条目返回 0 条匹配公告。CI 明确使用官方审计端点，并将阻断阈值从 high 改为 moderate。

新增本地 HTTP 回归：反斜线请求在到达处理函数前返回 400；编码换行符仍经过全局中间件；重叠管理路径仍要求授权。数据结构保持 schema 74，生产部署前进行隔离启动和旧版恢复演练。

2026-11-23 已完成隔离启动、旧版恢复演练及生产切换。实际运行目录为 `/opt/perpay-candidate-20261123b/app`，运行时为 `/opt/perpay-runtime-20261123-node24.22.3/bin/node`；主服务、旧库同步任务及账本监控均配置使用新运行时。生产进程实测 Node.js 24.22.3、Hono 4.13.21、@hono/node-server 2.1.11，schema 74。

生产验证：公开 readyz 恢复 200，SDK 下载 200。三个余额接口的未签名请求均返回 401；签名但缺少合法订单的请求返回预期业务错误，下单为 400，查询/退款为 404（`balance_order_not_found`，不是代理路由缺失）。检查前后余额订单、确认和退款记录数一致，未创建真实交易。部署时比较 156 张表，启动后再次比较 32 张订单/账本表，保留原库与备份。三个开票环境开关及私有平台服务费开票开关仍关闭。

验证记录：类型检查、构建、版本和 API 契约检查通过。后端全量执行共 1,849 项，首次为 1,827 通过、2 失败、20 跳过；失败项均为旧 Docker digest/审计命令预期，更新发布契约后，该文件完整重跑 17 项通过。安全 HTTP 回归在全量执行中通过；修复契约后未重复全量测试，也未重跑未改动的前端套件。

本机证据见 `artifacts/security-20261123/postdeploy.json`、`public-auth.json`、`npm-audit-after.json`、`node-tests.log` 和 `release-gates-retest.log`。这些证据只记录版本、统计和状态，不包含密钥。

来源：[Hono 路由公告](https://github.com/advisories/GHSA-h7mg-cq63-vhpq)、[Node 适配器路径公告](https://github.com/advisories/GHSA-jpvv-r467-5p4w)、[Node.js 24.22.3](https://nodejs.org/en/blog/release/v24.22.3)。

## 仍需单独处理的共享 Nginx

实际二进制报告 Nginx 1.26.3、OpenSSL 1.1.1w，包含 Lua、WAF 所需模块及其他自编译模块。star-web.top 及若干其他站点启用了 HTTP/2、TLS 1.3；未发现 QUIC 监听。官方公告列出当前版本在 HTTP/2 flow control 内存破坏 CVE-2026-123007、HTTP/2 use-after-free CVE-2026-123633、TLS 1.3 请求体读取死循环 CVE-2026-118899 的受影响范围内，修复版本包括 1.30.7 / 1.31.9。此处依据版本与配置判断，未进行远程利用，也未排除供应商自定义回补。

这不是 PerPay npm 升级能够修复的部分。应保留现有编译参数、Lua/WAF/粘性会话等模块，在独立目录构建修复版本；验证完整 nginx -T 配置、各站点证书/HTTP 路由、支付回调和 WebSocket 代理后，再安排全站二进制切换。保留旧二进制、配置和回滚步骤，不能直接套用通用发行版包替换自编译服务。本次未修改共享 Nginx 二进制或降低 TLS/鉴权保护。

来源：[Nginx 官方安全公告](https://nginx.org/en/security_advisories.html)。

## 旧 Next.js 支付前端

监听 3023 的实际工作目录为 `/www/wwwroot/epay-next-releases/20261025-reconcile-v2/.next/standalone`，Next.js 16.3.8、React 19.2.4。官方 npm 公告库对 Next.js 16.3.8 返回九条匹配，其中含两条 critical、一条 high；需安排至少 16.4.5 的升级，不能只依赖 PerPay 审计结果。

条件核查：sharp 0.35.5 已满足 GHSA-2464-fhr4-w9xw 的官方缓解条件；images.dangerouslyAllowSVG=false；cacheComponents=false、experimental.useCache=false，因此未发现 GHSA-673q-mjm6-r5xr 所需的 Cache Components 条件。构建的 Server Actions manifest 中 node/edge 均为 0，因此未发现 GHSA-p3m5-59mp-jv5r 所需的至少一个 Server Action。其余缓存、Edge 或响应转发公告仍需在该独立工程中逐项核实和升级，不将版本告警直接描述成已遭入侵。

来源：[Image Optimization 公告](https://github.com/advisories/GHSA-2464-fhr4-w9xw)、[Cache Components 公告](https://github.com/advisories/GHSA-673q-mjm6-r5xr)、[Server Actions DoS 公告](https://github.com/advisories/GHSA-p3m5-59mp-jv5r)。

## 仍存在的运行告警

生产财务校验与支付恢复校验通过，但总监控仍失败：61 笔待支付订单中，59 笔超过 24 小时，缺失支付详情为 0。此积压与部署前一致，未修改订单状态、告警标准或屏蔽失败；`perpay-integrity.timer` 保持运行，不能把整体监控描述为全绿。

部署后的根分区仅余约 175 MiB。只读检查本次暂存目录后确认，仅清理少量临时文件不足以恢复合理余量；应优先扩容或制定有保留期的日志/发布副本清理方案。当前生产库、财务备份和回滚版本均保留。

本次是限定范围的已知漏洞核查，不是完整渗透测试。官方审计为 0 不覆盖自有业务逻辑、共享 Nginx、旧 Next.js、操作系统或未来公告。
