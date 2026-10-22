# Benefit Hub · 技术架构与工程决策

> 状态：第一期设计基线（2026-10-22）。这里记录**已经讨论确定**的架构与工程边界，不代表功能已经实现。
>
> 视觉、颜色、排版、页面组件的风格规范只属于根目录 `design.md`。产品功能范围见 [product-scope.md](./product-scope.md)，羊毛供应商契约见 [integrations/yangmao.md](./integrations/yangmao.md)，部署见 [operations.md](./operations.md)。

## 1. 目标与边界

为三创各业务提供独立的权益供应服务，首期接入羊毛系统，并提供轻量运营层。业务前端不持有供应商凭证，也不直接访问羊毛 API。

```text
本地生活 / 卡博士 / 未来其他业务
             |
       Benefit Hub API
             |
    订单 / 商品映射 / 履约状态 / 审计
             |
       Provider Adapter
             |
         羊毛 Open API

运营后台 --(带登录的同源 API)--> Benefit Hub
```

单仓、单后端服务进程、单 SQLite 数据库。明确**不建**微服务、专门的权益结算中台、Redis/Kafka、复杂工作流引擎。业务职责按模块划分，不用过度通用抽象。

## 2. 已确认的选型

| 关注点 | 第一阶段方案 | 边界说明 |
| --- | --- | --- |
| Monorepo | pnpm Workspace | 不引入 Turborepo / Nx |
| 服务运行时 | Node.js 22 | Docker Debian slim 运行镜像 |
| API 框架 | Hono | 内部 API，运行于 Node；无需 Fastify |
| 语言与校验 | TypeScript strict + Zod | HTTP 入参、供应商响应与环境配置都做运行时校验 |
| 管理端 | React + Vite + Ant Design 6 + Lucide | 不直接引入完整 Ant Design Pro 模板 |
| 路由 | React Router | 页面/URL 查询参数是其职责 |
| 服务端状态 | TanStack Query | 请求、缓存、轮询、失效；不重复抄到 Zustand |
| 少量客户端状态 | Zustand | 菜单、弹窗等；局部状态留在 React |
| 数据库 | SQLite + Drizzle ORM | 第一阶段单实例；后期可迁 PostgreSQL，不承诺零成本 |
| SQLite 驱动 | better-sqlite3（初步） | 原生模块需验证 Node 镜像兼容性 |
| 日志 | Pino | 结构化日志和敏感字段脱敏 |
| 质量检查 | Oxlint + TypeScript + Vitest + 构建 | 测试力度按签名、数据、部署风险加强 |
| 对外接口 | 版本化 REST（计划前缀 `/api/v1`） | 业务方不依赖 Hono RPC；可提供 OpenAPI 说明 |
| 管理端内部类型 | Hono RPC 类型推导可选 | 不能替代真正的 HTTP 运行时校验 |
| 入口与 TLS | 服务器已有 Caddy | 不在业务容器里再运行一套反向代理 |

技术依赖精确版本以首次 lockfile 为准；这里是选型，不是已经完成安装的清单。

## 3. 代码组织（目标结构，尚未落地）

```text
apps/
  api/
    src/
      modules/
        auth/           # 管理员认证/会话
        catalog/        # 内部商品与供应商商品映射
        orders/         # 接单、幂等、业务订单
        fulfillment/    # 派发状态、查询、恢复
        operations/     # 后台汇总、日志、人工处理
      db/               # Drizzle schema/migrations 与 repositories
      app.ts
  admin/
    src/
      pages/            # 总览/商品/发放/系统设置
      features/
      components/
packages/
  contracts/            # 跨前后端的公共 DTO/Schema，不能含密钥
  provider-yangmao/     # 签名、协议、供应商返回的归一化
docs/
  architecture.md
  product-scope.md
  integrations/yangmao.md
  operations.md
AGENTS.md               # 工程约束
design.md               # UI 视觉设计（独立另定）
pnpm-workspace.yaml
pnpm-lock.yaml
Dockerfile
compose.yaml
```

业务模块不能直接引用 provider 内部签名实现或供应商表结构；供应商适配层不能直接决定运营侧的商品展示、定价和活动规则。

## 4. 代码与 API 纪律

- **一处真相源**：共享 Zod Schema 推导 TypeScript 类型；不手工维护冲突的 DTO 副本。外部供应商 Schema 与本平台公开 Schema 分离。
- **Strict TS**：禁用无说明的 `any`；边界数据不信任，须校验；异常不吞掉、不伪造成功。
- **业务分层**：HTTP 路由只做验证、认证和编排入口；业务服务控制流程；Repository 负责持久化；Adapter 负责上游协议。
- **稳定契约**：业务请求标识与内部权益编号不依赖供应商流水号。错误使用稳定内部码，另保留可脱敏追踪的供应商错误。
- **命名与改动**：模块按业务能力命名；一张实施卡对应可独立验证/回退的最小功能切片；PR 走 `feat/* -> dev`。
- **前端**：用 Ant Design 成熟组件实现表单/表格；URL 参数记录可分享筛选；TanStack Query 管理数据刷新，发券类动作不做“乐观成功”。
- **安全**：公开仓库不得提交真实 API 密钥、登录密码、手机号样本、卡密、数据库文件、备份或脱敏前日志。
- **CI 期望**：`pnpm install --frozen-lockfile`，lint、typecheck、test、build；关键调用链在适配、幂等和数据状态层提供针对性的集成证据。

## 5. 核心领域与状态原则

第一阶段建议最少具备以下持久化实体（是领域草案，非已经批准的最终 SQL Schema）：

| 对象 | 核心职责 |
| --- | --- |
| provider_credentials / provider_config | 环境、供应商账户引用、密钥存储引用；不存可直接展示的明文 Secret |
| product_mapping | 内部商品 ID 与供应商 productCode/模式映射；运营启停、展示/成本配置 |
| benefit_orders | 内部业务单号、业务来源、用户联系信息的受保护引用、幂等键、扣额模式 |
| fulfillment_attempts | 每次上游调用记录、requestId/partnerOrderNo、响应摘要、状态与时间 |
| fulfillment_items | B 多张券、D 履约明细等必要的子项状态 |
| operation_audit | 后台操作人、行为、对象、结果；敏感数据脱敏 |
| balance_snapshots | 有来源与时间的余额快照，不能冒称“实时余额” |
| admin_accounts / sessions | 简单的账号密码管理登录与会话 |

履约状态在**内部统一语义**下至少区分：待处理、处理中、待用户领取、部分完成、已完成、失败、结果未知待核实。各模式状态转移需要在实施卡中逐项冻结，不能把所有模式一概视为同步成功。

关键不变量：

1. 同一业务单号对应唯一的业务意图；数据库唯一约束与事务保护本地幂等。
2. 不跨外部 HTTP 调用持有数据库事务。先落业务意图，再调上游，最后记录可观察结果。
3. 网络超时与接口报错不能直接推断上游未扣费/未派发；先查单核实，再依据供应商支持的幂等语义恢复。
4. B 模式允许**原 requestId** 对部分失败按对接文档补发；不得创建新 requestId 代替重试。
5. `code=0` 不必然代表到账：B 需检查 `allClaimed`；D 需查 `dispatchStatus`。
6. 礼包额度按“个”，权益额度按“元”，两本账不可混算；内部钱款金额使用整数分。
7. 任何订单状态变更都要可追踪，禁止静默覆盖失效和人工强行改成功。

## 6. SQLite 与迁移策略

决定：**第一期使用 SQLite 单机持久化**，不是内存库或容器内临时文件。

- 单运行实例；应用层/数据库层明确串行写冲突处理与忙时重试边界。
- 数据库文件位于宿主机挂载目录，启用适当 WAL 配置，并落实一致性备份。
- Repository 层封装数据库方言；业务层不嵌入 SQLite 特殊 SQL。
- ID 使用稳定非自增业务 ID/UUID；金额用整数分、时间用明确 UTC 语义；避免 SQLite 隐含弱类型造成数据质量问题。
- **后续迁往 PostgreSQL 方便的是业务层复用，不是数据库文件一键切换**：需另建 Schema/migration、进行数据转换和约束核验，并安排停写、对账、回滚计划。
- 触发重新评估：多实例共享写入、单写入者成为瓶颈、需要更严格的并发事务或专用数据库运维。不要按某个未经测量的日订单数拍板迁移。

## 7. 认证与运营边界

第一期后台采用**账号密码登录**，不接公司统一 SSO、不上复杂角色审批体系。服务器端保管密码哈希（优先 Argon2id）、安全的 HttpOnly/Secure/SameSite 会话 Cookie、登录限速和关键操作审计。上线前决定管理员初始账号注入/重置与 CSRF 防护的实际方案。

运营后台可展示供应商余额**最近快照**，但对接总览没有余额实时查询契约，不能暗示可随时查询准确余额。商品与价格属于我们的运营配置，除非供应商明确提供写接口，不反向修改上游商品。

## 8. 决策与未完成项

### 已定
- 独立三创公开仓库 `sanchuang-dev/benefit-hub`；`feat/* -> dev`，`dev` 直接走公司新服务器。
- Hono、React/Ant Design、React Router、TanStack Query、Zustand、pnpm Workspace、SQLite/Drizzle、Docker 单应用容器。
- Caddy 留在宿主机；应用镜像在 CI 构建，不把编译负担放在 2C2G 服务器。
- 首期是服务适配层 + 轻量运营层，不是完整积分中台。

### 待验证/待选
- AppKey/AppSecret、refCode、测试/生产地址以及 A/B/C 与 D 的完整细分文档、商品编码；是否提供供测试使用的安全沙箱。
- 订单最终状态表、管理员初始化与权限颗粒度、后台 UI 视觉风格（写入 `design.md`）。
- 服务器 Docker/Compose 版本、磁盘余量、可用端口、Caddy 路由与 HTTPS 域名。
- 镜像从 CI 到服务器的具体传输及鉴权方式、数据备份/恢复演练、迁移时序。
- 外部业务系统调用 Benefit Hub 的身份认证与业务来源授权细节，不能用管理后台的登录方案替代。

**实施状态**：仓库当前只有初始 README，以及 Draft PR #1 内的 Docker 草案和本文档。应用、工作区锁文件、自动部署流水线、实机运行与接口联调都未交付。
