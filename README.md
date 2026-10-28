# Benefit Hub · 三创权益服务与轻量运营平台

**阶段（2026-10-28；以当前分支代码、合并记录与真实 CI 为准）：** 运营后台管理员登录、内部商品管理、订单持久化/幂等、供应商映射管理与版本冻结均已实现；**BHB-013-A 供应商商品只读运营页**已合入 `dev`，上力 D 商品列表/详情经有会话鉴权的只读 API 提供（真实凭证注入及线上读取尚未验收）。**本分支 BHB-012-A** 新增仅本地 `pending` 的下游订单 HTTP 接单、幂等和查询；合并前不代表 `dev` 或线上已具备该接口。供应商派发、查单和实际发放尚无完整的执行接口；平台不再以写死的禁用开关代替真实能力状态。本仓库公开；严禁提交供应商密钥、用户记录、卡密、数据库或运行时日志。

Benefit Hub 是三创拥有规则主权的权益服务平台，负责内部商品、订单、幂等、统一状态与运营审计；**上力是目前唯一的供应商 Provider，不是平台本身**。A/B/C/D 是首家供应商的履约模式和限制，不是要求所有未来 Provider 照搬的通用协议；不替业务项目实现支付、抽奖、积分清算。

## 2026-10-27 · 交付位置与供应商资料

- **已合入的本地能力**：BHB-002～010-B 中已交付的账户、商品、订单 Repository 和映射版本管理，不代表上游联调或真实派发上线。BHB-010-B：PR #37 已合入；BHB-001/#8、BHB-009/#31、BHB-010-A/#33 历史 Issue 尚需针对原合同单独验收收口，不能重复施工。
- **实证边界**：2026-10-27 授权开发环境 **仅**验证 D 模式签名商品列表读接口（HTTP 200，body `code=0`，21 个测试商品）；不能据此声明 A/B/C、D 实际派发、余额或终态已验收。
- **供应商协议与工程排卡**：[原始 2026-10-22 Open API 总览](docs/integrations/open-api-2026-10-22.md)、[工程摘要](docs/integrations/yangmao.md)、[未完成工作边界/任务依赖](docs/integrations/remaining-work-2026-10-27.md)。
- **禁止漂移**：`A/B/C` 用 `X-Sign` 且扣礼包数量，`D` 用 `X-Signature` 且扣人民币权益余额；映射激活不等于上游验真，供应商 `code=0` 不等于用户到账。完整细文档仍缺，不能自行猜参数或发券重试规则。
- **安全**：源代码与本公开仓库不存 AppKey/AppSecret、真实手机号、卡密；开发环境只读联调通过不授权任何真实扣额请求。

> 下方“2026-10-24 当前状态”是**当日历史快照**，不再表示 2026-10-27 代码状态。读者须以本段、最新 `dev`、关联 Issue/PR/CI 为准。

## 文档导航

| 入口 | 内容 |
| --- | --- |
| [产品一期范围](docs/product-scope.md) | 服务适配层、四页运营后台、首期不做的事项、验收目标 |
| [技术架构](docs/architecture.md) | Hono、React/Ant Design、pnpm、SQLite/Drizzle、代码架构和数据边界 |
| [羊毛接口契约摘要](docs/integrations/yangmao.md) | A/B/C/D 供应商流程、签名、限领、履约、待联调问题 |
| [下游业务订单入站 API](docs/integrations/business-order-api.md) | 服务凭证、创建/重放/查询、稳定错误码与安全边界 |
| [部署运维方案](docs/operations.md) | 公司新阿里云 2C2G、Docker、Caddy、SQLite 挂载、dev 发布策略 |
| [AGENTS.md](AGENTS.md) | 项目工程约束、权限、安全红线与两级分支例外 |
| [UI 设计规范 v0.1](design.md) | 蓝白色 Ant Design 后台、登录封面、商品双视图、映射版本与订单详情、交互状态 |
| [前端技术路线](docs/architecture.md#4a-前端技术路线ant-design-first施工强约束) | Ant Design First：组件、状态分工、禁止重复造轮子与验收纪律 |

## 已确定的工程方向

- 第一阶段：`feat/* -> dev`，只有 `dev` 将作为部署来源，不建立额外环境分支。
- Node.js 22 + Hono + pnpm Workspace；React + Vite + Ant Design 6、React Router、TanStack Query、Zustand。
- SQLite + Drizzle 单实例；数据库脱离 Docker 镜像持久化。必要时经迁移计划切换 PostgreSQL。
- 单应用容器提供 API/运营前端；使用宿主机已有 Caddy，CI 侧编译并交付镜像，避免给 2C2G 服务器增加构建压力。

## 2026-10-24 历史快照（以下不代表 2026-10-27 当前实现）

- **已运行**：dev 具备 Node/Hono 与 React/Ant Design 基础占位页、pnpm workspace/lockfile、Docker CI/CD。原型公网入口为 https://benefit.proto.3cgroup.cn/ ，健康检查返回 service=benefit-hub。
- **BHB-002 已实现（待合并后线上验收）**：品牌封面登录页、SQLite 管理员账号（scrypt 哈希）、HttpOnly/Secure/SameSite 会话、CSRF 双重提交、登录限速、`admin`/`viewer` 服务端权限判断、退出/过期反馈、SQLite 迁移与审计事件、管理员初始化/重置 CLI。验证方式见 `apps/api/test`、`apps/admin/src/**/*.test.tsx` 与 [docs/operations.md](docs/operations.md)。
- **BHB-003 已实现（后端，待合并后验收）**：内部商品最小模型（独立内部 ID、唯一业务编码、名称/简短描述、启停、整数分展示价与预估成本、版本号）、SQLite 迁移 `0002_catalog_products`、`/api/v1/catalog/products` 创建/分页筛选/详情/编辑/启停 API、`admin` 写 + `viewer` 只读的服务端权限、版本前置条件冲突与最小操作审计。该切片不含供应商映射，实际供应商调用不属于当时的商品 CRUD 切片；运营页面属 BHB-004。
- **BHB-004 已实现（前端，待合并后验收）**：认证后的“商品管理”页接入 BHB-003 真实 API，提供分页列表、关键词/状态筛选、单商品详情，以及共用 Drawer 表单的新建、编辑和启停；真实后端校验/版本冲突/网络错误、保存中状态与刷新后的实际结果均来自 API，只读身份禁用写操作。列表与详情明确标注“未映射供应商 / 不能发放”。前端测试见 `apps/admin/src/pages/CatalogPage.test.tsx`；服务端权限仍由 BHB-003 API 独立保证。
- **尚未交付**：内部商品之外的运营页面（供应商商品、发放记录）、供应商商品目录与映射版本、订单履约持久化、真实羊毛系统 A/B/C/D 联调与发券能力。
- **UI 设计与技术路线**：以 [design.md](design.md) 和 [docs/architecture.md](docs/architecture.md) 为施工依据。Ant Design 能解决的 UI 不能自造替代组件。
- **安全边界**：基础页面在线不等于可真实对客提供权益，禁止把模拟数据/未实现功能表述为真实发放。
- **管理员账号**：代码与镜像中没有任何默认账号或默认密码；首次部署后必须通过服务器上的 `node dist/cli/admin.js` 创建，步骤见 [docs/operations.md](docs/operations.md#管理员账号初始化与重置bhb-002)。

基础容器部署证据：[Benefit Hub CI](https://github.com/sanchuang-dev/benefit-hub/actions/runs/39738038904)；独立 Caddy HTTPS 入口验证：[proto-infra](https://github.com/sanchuang-dev/proto-infra/actions/runs/39741032139)。后续功能须各自验收，不从基础健康检查推断实现。

> 分支约定仍为 feat/* → dev；当前 CI 对 dev 的 push **会触发容器构建及部署**。纯文档变更合入前也应确认不产生不必要的发布。
