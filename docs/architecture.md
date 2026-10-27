# Benefit Hub · 技术架构与工程决策

> 状态：第一期技术路线（2026-10-24 更新）。**基础设施、账号密码登录、内部商品 CRUD 与运营后台商品管理已部署，BHB-004-A/B/C 已完成维护者真人线上验收；BHB-006 订单持久化/幂等底座已合入 dev；BHB-007 供应商映射草稿/本地校验/版本激活底座已合入 dev；BHB-008 订单创建冻结生效映射版本底座已合入 dev；BHB-009 供应商映射管理协议与 HTTP API（含最小共享 contracts package）已实现并处于合并验收中。供应商商品目录、订单 HTTP API、映射前端与真实供应商履约仍未实现。** 本文区分已运行的基础能力、选定技术与尚未落地的业务模块。
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

基础工作区与 lockfile 已存在；当前 apps/admin/package.json 中已声明 React 19、Ant Design ^6.0.0、React Router 7、TanStack Query 5、Zustand 5 和 lucide-react。**依赖声明不等于后台页面已交付**；以 lockfile 与 CI 的实际构建为准。

## 3. 代码组织（业务目标结构；基础工作区已建立，模块未全部落地）

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
      app/              # 路由、Provider、主题及页面骨架
      pages/            # 总览/商品/发放/系统设置
      features/         # 业务域内部组件与数据交互
      shared/           # 仅真实跨模块复用的能力
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

目录展示仅表示**目标归属而非必须预建的空目录**；详细命名和测试放置以 [code-quality.md](./code-quality.md) 为准。业务模块不能直接引用 provider 内部签名实现或供应商表结构；供应商适配层不能直接决定运营侧的商品展示、定价和活动规则。

## 4. 代码与 API 纪律

- **一处真相源**：共享 Zod Schema 推导 TypeScript 类型；不手工维护冲突的 DTO 副本。外部供应商 Schema 与本平台公开 Schema 分离。
- **Strict TS**：禁用无说明的 `any`；边界数据不信任，须校验；异常不吞掉、不伪造成功。
- **业务分层**：HTTP 路由只做验证、认证和编排入口；业务服务控制流程；Repository 负责持久化；Adapter 负责上游协议。
- **稳定契约**：业务请求标识与内部权益编号不依赖供应商流水号。错误使用稳定内部码，另保留可脱敏追踪的供应商错误。
- **命名与改动**：模块按业务能力命名；一张实施卡对应可独立验证/回退的最小功能切片；PR 走 `feat/* -> dev`。
- **前端**：用 Ant Design 成熟组件实现表单/表格；URL 参数记录可分享筛选；TanStack Query 管理数据刷新，发券类动作不做“乐观成功”。
- **安全**：公开仓库不得提交真实 API 密钥、登录密码、手机号样本、卡密、数据库文件、备份或脱敏前日志。
- **CI 期望**：`pnpm install --frozen-lockfile`，lint、typecheck、test、build；关键调用链在适配、幂等和数据状态层提供针对性的集成证据。

## 4A. 前端技术路线：Ant Design First（施工强约束）

设计及交互的唯一规范来源：[../design.md](../design.md)。**选用 Ant Design 6 就以其为 UI 基础，不再自建同类组件体系**。该规则适用于人工、牛马和任何代码生成工具；不因示例看起来更漂亮而绕开组件库。

### 组件选型与禁止项

| 能力 | 第一选择 | 不接受的做法 |
| --- | --- | --- |
| 全局布局与菜单 | Ant Design Layout / Menu / Grid | 手写第二套 Layout、导航树和折叠交互 |
| 工作页签与商品 Tab | Tabs（工作页签可用 editable-card），业务两 Tab 使用受控 Tabs | 自制 tab DOM/状态库、重复打开同一路由 |
| 表格 | Table 的 pagination/columns/fixed/scroll/empty/ellipsis | 手写原生 table、分页与固定列系统 |
| 商品双视图 | Table + Card/Row/Col 或 Grid + Segmented | 第二套独立数据列表、手写分段控件 |
| 筛选与编辑 | Form / Form.Item + Input / Select / DatePicker / InputNumber / Switch | 手工 DOM 校验、自造 Input/Select 组件 |
| 商品/订单详情 | Drawer + Descriptions + Tabs/Timeline | 自造 Overlay/抽屉/时间线 |
| 映射流程 | Steps + Form + Modal/Popconfirm + Alert / Tag | 新造步骤条、确认框、状态标签 |
| 加载/空状态/反馈 | Skeleton、Spin、Empty、Result、Alert、App.useApp() 的 message/notification/modal | 自造 Toast、Spinner、Modal provider |
| 主题/全局尺寸 | ConfigProvider theme.token + theme.components | 大片 CSS 强行覆盖 .ant-* 内部 DOM 或再建一套 token 引擎 |

- 默认使用 Ant Design 6 **正式支持的属性、API 与 Design Token**；如实际 lockfile 版本与官方最新文档不一致，以仓库已安装版本为准。
- 入口以 ConfigProvider（zh_CN、主题）包裹 Ant Design App，并在组件下通过 App.useApp() 获取反馈实例。不要混杂静态 message 调用与另一套自制反馈系统。
- 外层页面网格和极少量品牌封面样式可以使用普通 CSS；业务状态编排可以写 React 组合组件，**但组合组件内部调用 Ant Design 标准控件，不重实现标准组件**。
- 当前仓库已安装 lucide-react：只作为已有的导航/语义图标方案；不再额外引入多套互相重复的 Icon/UI 组件库。禁止图标仅以颜色表达状态。
- **暂不引入** Tailwind、shadcn/ui、Material UI、Mantine、Ant Design Pro 整套脚手架、额外 form/table/state/UI 框架。未来如果确有 Ant Design 缺口，先提交具体差异与使用理由，再评审是否引入；本次讨论不授权新增。

### 页面、路由和状态的所有权

- React Router 管理登录入口、四个主导航页、独立订单详情、浏览器历史与 URL 查询参数。顶部工作页签使用受控 Tabs 与路由映射；路由才是页面位置的来源，避免再复制一套“当前页面”真相源。
- TanStack Query 管理 API 读写、分页缓存、失效、重试与可观察的加载/错误状态。**供应商扣额/发放/映射激活等写操作不做乐观成功**。
- React 局部 useState / Ant Design Form 实例承载当前编辑会话、草稿表单及临时 Drawer 状态。只有确属跨页面共享的 UI 偏好才使用 Zustand；不要把整份列表数据或 Query 缓存搬进 Zustand。
- 商品两个业务 Tab 分别保持筛选、分页、排序与表格/卡片偏好；卡片和 Table **消费相同的请求结果**。URL 查询参数可分享；用户切换页面不应悄悄丢失条件。
- 用户权限来自服务端会话与权限判断；前端可以隐藏/禁用操作并解释原因，但不能充当鉴权边界。

### 映射版本与权限属于服务端领域，不是组件状态

- 每个内部商品同一时刻最多一条生效供应商映射；版本历史与订单版本关联由数据库和 API 保证，不能靠只显示一个选中 Card 来保证。
- 保存草稿、校验、显式激活是**三次不同业务意图/操作**：保存草稿不生效，字段变化会使校验结果过期；激活前确认差异，服务端核查草稿版本与前置条件，审计保存和激活；切换生效版本要有并发保护。
- 校验区分本地规则与供应商实际契约测试；上游未联调时不能在正式业务页面显示“已验证成功”。
- 管理权限分只读查看者、管理员两层，不引入 RBAC 引擎/审批流；供应商原始商品数据只读，后台内不允许擅自修改上游。
- 订单详情必须分别呈现“供应商是否受理”“是否扣额度”“用户是否履约”“最后核实”，**不从 HTTP 200 或 code=0 推导业务完成**。

### 交付和代码卫生

1. **先实现标准组件页**：登录封面 + Form；Layout/Menu/Tabs 骨架；商品 Table/Card/Segmented；Drawer 详情；再接草稿/校验/激活与履约时间线。无必要不先抽象通用业务框架。
2. 设计 Token 统一放在顶层 ConfigProvider；业务 CSS 仅写布局/封面/必要局部空隙，不穿透篡改 Ant Design 私有类名；重复功能一处实现。
3. 验收必须包含浏览器实图：1366px 桌面与窄屏；表格/卡片切换、两个 Tab 筛选状态保持、路由/页签一致性、抽屉关闭未保存提示、无数据/异常/权限态、键盘焦点。
4. 使用真实 API 前不允许靠随机假订单或永远成功的 mock 形成“功能已完成”结论。功能未接入就展示明确的未实现提示；合同测试可用隔离的固定测试夹具。
5. 后端仍遵守签名、幂等、权限、审计和 SQLite 持久化约束；前端组件选型不降低真实履约的验收门槛。

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

第一期后台采用**账号密码登录**，不接公司统一 SSO、不上复杂角色审批体系。BHB-002 已实现的最小闭环如下（发布与线上验收仍需独立完成）：

- 账号与角色：`admin_accounts` 表，只有 `admin` / `viewer` 两级；权限由服务端中间件判断，隐藏按钮不构成鉴权。
- 密码：Node 标准库 `scrypt`（N=2¹⁵, r=8, p=1，随机盐，timing-safe 比较）。架构原偏好 Argon2id，当前选择 scrypt 以避免在运行镜像中额外引入原生 KDF 模块；存储格式自带参数，后续可在登录成功时透明重算为 Argon2id。
- 会话：随机 32 字节不透明令牌，数据库只保存其 SHA-256 摘要；Cookie 为 `HttpOnly; Secure(生产); SameSite=Strict; Path=/`，绝对有效期默认 8 小时（`SESSION_TTL_HOURS`）。重启不使会话失效，过期、退出、改密、停用都会立即使其失效。
- CSRF：双重提交令牌（`bh_csrf` Cookie + `X-CSRF-Token` 头），非安全方法同时校验 `Origin` 与 `Host` 一致。
- 登录限速：内存失败计数，同一账号 15 分钟 5 次、同一来源地址 15 分钟 20 次；超过后返回 429 与 `Retry-After`。单实例阶段不引入 Redis。
- 审计：`auth_events` 仅记录事件类型、账号 ID 与稳定原因码，不含密码、令牌、Cookie、IP 或请求体。
- 权限边界：BHB-002 切片没有管理写 API；`GET /api/v1/admin/accounts` 是当时唯一管理员专属接口，只读身份由服务端返回 403。后续写接口必须复用 `requireSession` + `requireRole('admin')`，不能只靠前端隐藏；BHB-003 商品写接口已按此实现。
- 管理员初始化/重置：只能通过 `node dist/cli/admin.js`（密码由标准输入提供），代码中不存在默认账号或默认密码。
- 商品目录（BHB-003，仅后端）：`GET /api/v1/catalog/products`（分页/关键词/状态）与详情只要求有效会话；创建、编辑、启停要求 `admin`。编辑与启停必须携带当前版本号，条件更新失败返回 `PRODUCT_VERSION_CONFLICT`，不静默覆盖；写操作记录 `catalog_product_events`（操作者、动作、商品、时间）。业务编码由数据库唯一索引保证不重复。本切片没有供应商映射，API 对任何商品都返回 `vendorFulfillmentEnabled: false`；停用商品不得被后续发放逻辑使用。
- 迁移：启动时按序应用未执行的增量迁移并记录在 `schema_migrations`，只允许向前变更；不做自动降级或删库。
- 订单持久化底座（BHB-006，仅后端领域与 Repository）：`benefit_orders` 由数据库唯一索引保证 `business_source + business_order_no` 唯一，等价重复请求返回同一订单，关键参数冲突稳定失败，状态变更以版本号条件更新；`benefit_order_status_events` 与订单写入处于同一事务，保存每个已接受版本对应的内部状态与时间，保证状态轨迹可追溯；`fulfillment_attempts` 只记录操作类别、受限长度的上游关联号、内部结果/观察状态与时间，不保存凭证、手机号、卡密或原始供应商响应。该切片不提供发放 HTTP API、真实供应商调用或前端页面，外部 HTTP 调用必须在本地事务之外进行。
- 供应商映射持久化底座（BHB-007，仅后端领域与 Repository）：`supplier_product_mappings` 由 `product_id` 唯一索引保证一个内部商品只有一个映射聚合，保存当前草稿与当前 active 版本指针；`supplier_product_mapping_versions` 保存每次显式激活的完整不可变快照、单调版本号、激活操作者引用与时间，迁移 0004 的触发器拒绝快照 UPDATE/DELETE 以及指向其他映射的 active 指针。草稿写入以版本号条件更新保护，任何编辑都会清除既有校验事实；`validateDraft` 只执行本地规则（内部商品存在、`yangmao`、受限 productCode、A/B/C/D，以及 A/B/C=礼包/次数、D=金额的扣减语义），**不代表上游验证成功**；`activateDraft` 仅接受当前已校验版本，在同一本地事务内插入快照并切换指针，过期/并发激活确定性失败。该切片不调用羊毛接口、不保存凭证或原始响应、不提供映射 HTTP API（由 BHB-009 提供）或前端。
- 订单冻结映射版本（BHB-008，仅后端领域与 Repository）：迁移 0005 为 `benefit_orders` 增加可空 `mapping_version_id` 外键，指向 `supplier_product_mapping_versions`；0003/0004 时代的历史订单保持 `NULL`，明确表示创建时尚无该机制，**不做猜测式回填**。真正新建订单时不再由调用方选择履约模式：Repository 在同一个 `BEGIN IMMEDIATE` 本地事务内校验内部商品存在且为 `active`、读取该商品当前 active 映射快照，并把快照的 `fulfillment_mode` 与快照 id 一起冻结进订单和初始状态事实，因此与 BHB-007 的激活写事务串行；等价业务单号 replay 优先于任何当前状态检查，即使商品已停用或映射已切换仍返回原订单与原快照；同一业务身份换商品稳定冲突。迁移 0005 的触发器在数据库边界拒绝缺少快照、跨商品/跨模式或非当前 active 的新 INSERT，并禁止事后 UPDATE 修改 `product_id`、`fulfillment_mode` 或 `mapping_version_id`（历史行同样适用），status/version/updated_at 仍可正常更新。该切片仍不调用羊毛接口、不提供订单 HTTP API 或前端，也不实现履约状态机。
- 供应商映射管理协议/API（BHB-009，HTTP 切片）：新增 `packages/contracts` 最小共享协议包，Zod schema 是 mapping wire contract 的唯一来源，导出 provider、A/B/C/D、扣减单位、本地校验 issue codes、draft/version/overview DTO、strict 请求 schema 与稳定 mapping 错误码；API 通过 workspace dependency 使用同一 schema，不重复手写请求 DTO。`GET /api/v1/catalog/products/:id/mapping` 允许 viewer/admin 读取，内部商品不存在返回 404 `PRODUCT_NOT_FOUND`，商品存在但尚无映射稳定返回 200 空 overview；`PUT .../mapping/draft`、`POST .../mapping/validate`、`POST .../mapping/activate` 仅 admin 可写，viewer 写操作返回 403。save draft 的 `expectedVersion = null` 表示首次创建，非 null 表示更新当前草稿；首次重复创建 409 `MAPPING_ALREADY_EXISTS`，陈旧或并发写入/激活 409 `MAPPING_VERSION_CONFLICT`。validate 只执行 BHB-007 的**本地结构校验**，成功响应固定 `validationScope: "local"`、`upstreamVerified: false`，失败返回 422 `MAPPING_VALIDATION_FAILED` 与稳定 issue codes（不回显提交值）；任何 draft 编辑都会清除既有校验事实，未校验激活返回 409 `MAPPING_NOT_VALIDATED`。activate 的 actor 来自当前 authenticated admin session，客户端提交 actor/未知字段会被 strict schema 拒绝为 400。mapping 响应统一 `no-store`，写操作继续经过全局 CSRF/Origin 防护。该切片仍不调用羊毛 HTTP、不保存凭证、不做上游验证、不提供映射前端或真实发放。

运营后台可展示供应商余额**最近快照**，但对接总览没有余额实时查询契约，不能暗示可随时查询准确余额。商品与价格属于我们的运营配置，除非供应商明确提供写接口，不反向修改上游商品。

## 8. 决策与未完成项

### 已定
- 独立三创公开仓库 `sanchuang-dev/benefit-hub`；`feat/* -> dev`，`dev` 直接走公司新服务器。
- Hono、React/Ant Design、React Router、TanStack Query、Zustand、pnpm Workspace、SQLite/Drizzle、Docker 单应用容器。
- Caddy 留在宿主机；应用镜像在 CI 构建，不把编译负担放在 2C2G 服务器。
- 首期是服务适配层 + 轻量运营层，不是完整积分中台。

### 待验证/待选
- AppKey/AppSecret、refCode、测试/生产地址以及 A/B/C 与 D 的完整细分文档、商品编码；是否提供供测试使用的安全沙箱。
- A/B/C/D 的完整终态转换规则仍需随真实供应商契约逐模式冻结；管理员初始化/重置与 CSRF 已在 BHB-002 固定（见第 7 节）；后台壳层与商品管理 UI 已完成线上真人验收。
- 基础容器/HTTPS 已有实机验收记录；业务登录与真实数据能力仍需单独验收，后续服务器资源容量按实际负载检查。
- CI 镜像传输/基础部署已运行；数据库备份/恢复演练、业务 schema 迁移时序仍待验证。
- 外部业务系统调用 Benefit Hub 的身份认证与业务来源授权细节，不能用管理后台的登录方案替代。

**实施状态（2026-10-24 已核对）**：dev 已有 pnpm workspace、lockfile、Node/Hono 服务、React/Ant Design 管理后台和 Docker/CI，原型入口为 https://benefit.proto.3cgroup.cn/，健康检查已通过。BHB-002 已实现管理员账号密码登录、会话持久化、CSRF、登录限速与两级权限；BHB-003 已实现内部商品持久化、迁移与受权限保护的商品 CRUD API（含版本冲突与最小操作审计）；BHB-004-A/B/C 已完成运营壳层与商品管理 UI 整改、dev 部署及维护者真人线上验收。**供应商商品目录、映射前端、订单 HTTP API 与真实羊毛接口发放、履约仍未实现**。BHB-006 已实现订单与履约尝试的持久化、数据库幂等唯一约束、版本保护和不可变状态历史，但仅有后端领域/DB/Repository 与测试，尚无发放 HTTP API、供应商调用或履约前端。BHB-007 已实现供应商映射的草稿持久化、本地校验事实、显式激活与不可变版本历史，其 HTTP 管理协议由 BHB-009 提供。BHB-008 已合入 dev，实现订单创建时冻结当前生效映射版本（迁移 0005、Repository 事务与数据库触发器边界），仅有后端领域/DB/Repository 与临时 SQLite 证据，尚无订单 HTTP API、前端或真实履约。BHB-009 已实现最小共享 `packages/contracts` 协议包与 mapping 管理 HTTP API（草稿保存/本地校验/激活、稳定错误码、viewer 只读/admin 写入、CSRF 与 no-store），仍只有本地结构校验，不包含映射前端、供应商商品目录、上游验证或真实发放。基础应用上线不代表可提供真实权益服务。
