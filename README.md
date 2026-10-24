# Benefit Hub · 三创权益服务与轻量运营平台

**阶段：基础运行/HTTPS 已上线；管理员账号密码登录与最小权限已在代码中实现（BHB-002，待线上验收）；内部商品数据层与 REST API 已在代码中实现（BHB-003，待合并/线上验收）；商品运营页面、订单与真实供应商履约尚未实现。** 本仓库公开；严禁提交供应商密钥、用户记录、卡密、数据库或运行时日志。

Benefit Hub 独立提供权益供应商适配、内部发放订单与履约查询、轻量运营后台。第一家供应商为羊毛系统，覆盖 A/B/C/D 四种 Open API 模式；不替业务项目实现支付、抽奖、积分清算。

## 文档导航

| 入口 | 内容 |
| --- | --- |
| [产品一期范围](docs/product-scope.md) | 服务适配层、四页运营后台、首期不做的事项、验收目标 |
| [技术架构](docs/architecture.md) | Hono、React/Ant Design、pnpm、SQLite/Drizzle、代码架构和数据边界 |
| [羊毛接口契约摘要](docs/integrations/yangmao.md) | A/B/C/D 供应商流程、签名、限领、履约、待联调问题 |
| [部署运维方案](docs/operations.md) | 公司新阿里云 2C2G、Docker、Caddy、SQLite 挂载、dev 发布策略 |
| [AGENTS.md](AGENTS.md) | 项目工程约束、权限、安全红线与两级分支例外 |
| [UI 设计规范 v0.1](design.md) | 蓝白色 Ant Design 后台、登录封面、商品双视图、映射版本与订单详情、交互状态 |
| [前端技术路线](docs/architecture.md#4a-前端技术路线ant-design-first施工强约束) | Ant Design First：组件、状态分工、禁止重复造轮子与验收纪律 |

## 已确定的工程方向

- 第一阶段：`feat/* -> dev`，只有 `dev` 将作为部署来源，不建立额外环境分支。
- Node.js 22 + Hono + pnpm Workspace；React + Vite + Ant Design 6、React Router、TanStack Query、Zustand。
- SQLite + Drizzle 单实例；数据库脱离 Docker 镜像持久化。必要时经迁移计划切换 PostgreSQL。
- 单应用容器提供 API/运营前端；使用宿主机已有 Caddy，CI 侧编译并交付镜像，避免给 2C2G 服务器增加构建压力。

## 当前状态（2026-10-24 有实证的范围）

- **已运行**：dev 具备 Node/Hono 与 React/Ant Design 基础占位页、pnpm workspace/lockfile、Docker CI/CD。原型公网入口为 https://benefit.proto.3cgroup.cn/ ，健康检查返回 service=benefit-hub。
- **BHB-002 已实现（待合并后线上验收）**：品牌封面登录页、SQLite 管理员账号（scrypt 哈希）、HttpOnly/Secure/SameSite 会话、CSRF 双重提交、登录限速、`admin`/`viewer` 服务端权限判断、退出/过期反馈、SQLite 迁移与审计事件、管理员初始化/重置 CLI。验证方式见 `apps/api/test`、`apps/admin/src/**/*.test.tsx` 与 [docs/operations.md](docs/operations.md)。
- **BHB-003 已实现（后端，待合并后验收）**：内部商品最小模型（独立内部 ID、唯一业务编码、名称/简短描述、启停、整数分展示价与预估成本、版本号）、SQLite 迁移 `0002_catalog_products`、`/api/v1/catalog/products` 创建/分页筛选/详情/编辑/启停 API、`admin` 写 + `viewer` 只读的服务端权限、版本前置条件冲突与最小操作审计。该切片不含供应商映射，所有商品 `vendorFulfillmentEnabled` 恒为 `false`；运营页面属 BHB-004。
- **尚未交付**：四模块实际运营页面（含内部商品 UI）、供应商商品目录与映射版本、订单履约持久化、真实羊毛系统 A/B/C/D 联调与发券能力。
- **UI 设计与技术路线**：以 [design.md](design.md) 和 [docs/architecture.md](docs/architecture.md) 为施工依据。Ant Design 能解决的 UI 不能自造替代组件。
- **安全边界**：基础页面在线不等于可真实对客提供权益，禁止把模拟数据/未实现功能表述为真实发放。
- **管理员账号**：代码与镜像中没有任何默认账号或默认密码；首次部署后必须通过服务器上的 `node dist/cli/admin.js` 创建，步骤见 [docs/operations.md](docs/operations.md#管理员账号初始化与重置bhb-002)。

基础容器部署证据：[Benefit Hub CI](https://github.com/sanchuang-dev/benefit-hub/actions/runs/39738038904)；独立 Caddy HTTPS 入口验证：[proto-infra](https://github.com/sanchuang-dev/proto-infra/actions/runs/39741032139)。后续功能须各自验收，不从基础健康检查推断实现。

> 分支约定仍为 feat/* → dev；当前 CI 对 dev 的 push **会触发容器构建及部署**。纯文档变更合入前也应确认不产生不必要的发布。
