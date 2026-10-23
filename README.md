# Benefit Hub · 三创权益服务与轻量运营平台

**阶段：产品/架构讨论已整理，应用尚未实现。** 本仓库公开；严禁提交供应商密钥、用户记录、卡密、数据库或运行时日志。

Benefit Hub 独立提供权益供应商适配、内部发放订单与履约查询、轻量运营后台。第一家供应商为羊毛系统，覆盖 A/B/C/D 四种 Open API 模式；不替业务项目实现支付、抽奖、积分清算。

## 文档导航

| 入口 | 内容 |
| --- | --- |
| [数字权益模块 V1 业务战略](docs/digital-benefits-strategy-v1.md) | **上层数字中台战略背景**；不扩大 Benefit Hub 一期范围 |
| [产品一期范围](docs/product-scope.md) | 服务适配层、四页运营后台、首期不做的事项、验收目标 |
| [技术架构](docs/architecture.md) | Hono、React/Ant Design、pnpm、SQLite/Drizzle、代码架构和数据边界 |
| [羊毛接口契约摘要](docs/integrations/yangmao.md) | A/B/C/D 供应商流程、签名、限领、履约、待联调问题 |
| [部署运维方案](docs/operations.md) | 公司新阿里云 2C2G、Docker、Caddy、SQLite 挂载、dev 发布策略 |
| [AGENTS.md](AGENTS.md) | 项目工程约束、权限、安全红线与两级分支例外 |
| `design.md`（待视觉讨论） | **专门留给 UI 风格、布局与交互设计**；不承载技术选型 |

## 已确定的工程方向

- 第一阶段：`feat/* -> dev`，只有 `dev` 将作为部署来源，不建立额外环境分支。
- Node.js 22 + Hono + pnpm Workspace；React + Vite + Ant Design 6、React Router、TanStack Query、Zustand。
- SQLite + Drizzle 单实例；数据库脱离 Docker 镜像持久化。必要时经迁移计划切换 PostgreSQL。
- 单应用容器提供 API/运营前端；使用宿主机已有 Caddy，CI 侧编译并交付镜像，避免给 2C2G 服务器增加构建压力。

## 当前状态（以实际远程代码为准）

`dev` 目前只有仓库初始化 README。Draft PR #1 中已有 Dockerfile/Compose **草案**、工程规范和本轮讨论文档；尚缺应用代码、pnpm workspace 与 lockfile，因此不能构建可运行的应用镜像。没有执行真实供应商联调，也没有部署到服务器。

请先评审/确认文档边界，再决定是否拆实施卡并进入实际开发。
