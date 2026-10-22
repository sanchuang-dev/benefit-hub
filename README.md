# Benefit Hub · 三创权益服务系统级原型

**定位：系统级原型（System Prototype），非正式用户服务。** 目的是演示并验证“羊毛权益供应商适配 → 平台订单/履约 → 轻量运营后台”这一整套系统。当前公开的基础页仅用于确认工程及部署链路；真实权益发放、运营登录、业务订单均尚未启用。

## 演示入口与工程归属

- 目标演示域名：**https://benefit.proto.3cgroup.cn/**，纳入公司 `*.proto.3cgroup.cn` 原型体系。当前域名路由上线状态以 [proto-infra](https://github.com/sanchuang-dev/proto-infra) 的发布和 HTTPS 验收为准，不能只凭 DNS 解析或本仓库配置声称公网可访问。
- 本仓库：`sanchuang-dev/benefit-hub`，公开；`feat/* → dev`，`dev` 自动构建并部署独立 Docker 容器（仅宿主机 `127.0.0.1:18080`）。
- 公共站点与 HTTPS 入口归 `proto-infra` 管理，其环境分支及发布纪律不受本仓库简化分支规则影响。
- 不上传真实供应商密钥、个人数据、卡密、数据库、运行日志。演示默认使用非真实业务数据；如需进行对上游有副作用的联调，须另外约定权限和安全验证。

## 产品与技术

首期产品范围为**羊毛系统 A/B/C/D 服务适配层 + 四页轻量运营后台**。这是原型目标，不是当前已交付功能。

- Node.js 22 + Hono + TypeScript strict + pnpm Workspace。
- React + Vite + Ant Design；目标技术栈还包含 React Router、TanStack Query 和 Zustand。
- 单实例 SQLite + Drizzle（目标设计），Docker 构建在 GitHub Actions 完成，宿主机 Caddy 反代。当前基础服务尚未实现真实数据库订单能力。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [产品范围](docs/product-scope.md) | 系统级原型要演示什么、运营模块及验收目标 |
| [技术架构](docs/architecture.md) | 工程选型、业务模块边界、SQLite 迁移策略 |
| [羊毛协议](docs/integrations/yangmao.md) | 上游四种模式、签名、额度与待核实条件 |
| [部署运维](docs/operations.md) | 已验证的内网部署、拟纳入的原型域名和发布安全边界 |
| [组织自动化](docs/automation.md) | 免费/付费 Worker 与只读 AI Review |
| [仓库规范](AGENTS.md) | `feat/* → dev` 项目例外及工程红线 |
| `design.md`（待另定） | 仅用于视觉、布局、组件和交互风格设计 |

## 已有运行证据与缺口

2026-10-22，首次基础容器在公司新阿里云服务器上完成安装、启动和 HTTP 健康检查：镜像 `cb0e8973423b5052f660e1710031494bd0c2a005`，服务绑定 `127.0.0.1:18080`。证据：[GitHub Actions Run #39730933459](https://github.com/sanchuang-dev/benefit-hub/actions/runs/39730933459)。

**这一事实不代表公网 HTTPS 已验证，不代表运营后台/羊毛适配已实现，更不代表可以向真实用户发券。** 项目后续以系统原型的验收口径迭代。
