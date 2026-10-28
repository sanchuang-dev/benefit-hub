# Benefit Hub · 技术架构与工程决策

> **工程状态（2026-10-28；以 dev 代码、Issue 和 CI 为准）：** 管理后台登录与内部商品 CRUD 已完成；BHB-006 订单持久化/幂等 Repository、BHB-007/008 草稿/激活与订单映射版本冻结、BHB-009 共享 mapping contract + 管理 HTTP、BHB-010-A/B 管理端映射只读与操作均已合入 `dev`。**仍未**实现真实供应商履约 Adapter（发券/查单）与真实发放；BHB-012-A 已提供受服务凭证保护的下游业务订单意图 HTTP 入站（仅本地 `pending`，不调用供应商），`vendorFulfillmentEnabled=false` 仍成立。2026-10-27 仅在授权开发环境验证 D 商品列表有签名只读请求成功（21 个测试商品），不代表发券验收；BHB-011-A/B/C 已在 `packages/provider-yangmao` 提供 D 商品列表/详情与 A/B/C 只读客户端，BHB-013-A 已把 D 商品列表/详情接到登录态同源只读入口和商品管理「供应商商品」Tab；BHB-014-A 已提供下游应用登记与商品授权配置的持久化配置面（管理端与 HTTP，**未接入运行时鉴权**，不等于已发放机器凭证）；服务器未配置只读凭证时接口明确不可用，未使用真实凭证、未启用发放。原始接口总览见 [open-api-2026-10-22.md](./integrations/open-api-2026-10-22.md)，未来排卡约束见 [remaining-work-2026-10-27.md](./integrations/remaining-work-2026-10-27.md)。文内未逐段更新的 2026-10-24 实施状态文字视为历史记录，**不得**据其再次派重复实现。
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

## 1A. 平台优先，Provider 次之（2026-10-27 决策补充）

> 合同所有权详见 [product-scope.md](./product-scope.md#1a-平台主体与供应商规则继承2026-10-27-补充共识)；UI 的供应商归属表现详见 [design.md](../design.md)。**现阶段唯一的上力接入并不等于“Benefit Hub = 上力后台”。**

```text
三创业务 → Benefit Hub 统一内部商品/订单/状态/幂等/审计
                           │
                    已激活映射快照
                           │
                   Provider 适配边界
                 ┌─────────┴─────────┐
            上力（当前一家）     其他供应商（未来）
           X-Sign / X-Signature    各自 API / 规则
           A/B/C/D 专属语义
```

- **平台领域与公开 API 负责**：内部商品与展示价格、授权、业务订单身份及幂等、映射不可变版本、履约状态归一化、未知结果追踪、日志脱敏、消费者可观察合同。这些规则对所有 Provider 生效。
- **Provider Adapter 负责**：自己的 API 路径/凭证/签名/请求与响应解析、供应能力、限制与扣额语义、上游错误及状态翻译、合法查询/恢复方式。供应商规则在平台共同基线上叠加更严限制，不能弱化平台级安全/一致性要求。
- **关键接口方向**：业务编排调用受限的 Provider 客户端端口并消费内部标准结果；Adapter 不直接控制 SQLite、内部定价、用户业务准入、全局订单状态转移或向下游输出上力原始报文；不能在核心业务路由里直接实现 A/B/C/D 签名。
- **模式作用域**：目前 `packages/contracts/src/mapping.ts` 的 `FULFILLMENT_MODES = ['A','B','C','D']` 同时被订单领域使用，`MAPPING_PROVIDERS=['yangmao']`，这是**已经存在的上力一期编码耦合**，不是“所有提供商必须按 A/B/C/D 实现”的产品决定。新增 Provider 时要先单独评审 provider-scoped `providerMode` / 平台 `capability` 的归一化合同及兼容迁移，不能直接给这两个枚举追加含义、修改已冻结订单或者把新的模式塞进上力模式枚举。本轮只记录边界，不改 schema/DTO/历史记录。
- **Provider 身份的稳定性**：已有 `yangmao` 为代码/数据库标识，运营文案使用“上力”这一当前业务名称；显示名称与内部 key 不应混作 API 字段。上力商品应以 **(providerKey, upstreamProductCode)** 看待其来源身份，不能因其他供应商也有同样编码而合并。同一内部商品一期仍只有**一个活跃映射**，未来要切换时按现有版本激活而非在订单执行中偷偷路由到别家。
- **不提前设计的东西**：供应商运行时插件系统、自动选商/比价、跨供应商共享钱包、动态加载映射配置引擎、多租户供应商后台。当前单 Provider 的小型受限实现优先，但接口与模块命名保持不冒充平台通用逻辑。

**风险分界**：当前 011-A/B/C/D 只读 Adapter 卡可落实独立签名和响应归一化，不负责平台 domain 的大迁移。若发现必须更改 `fulfillmentMode` 的合同才可新增供应商，另立独立迁移卡；不向只读任务偷偷追加数据库及运营 UI 施工。


## 1B. 应用配置驱动的业务接口（2026-10-28 目标架构）

此项是新的**待实现**功能合同，详细范围见 [平台一级导航与动态接口决策](./platform-config-and-api-delivery-2026-10-28.md)，不表示已完成。基础链路为：下游应用身份与商品/能力授权 → 已发布价值换算预设 → 接口管理按受限模板校验/生成/发布可调用业务路由及 OpenAPI 契约 → 现有 Benefit Hub 安全业务原语（鉴权、幂等、订单冻结与审计）→ 经独立验证的 Provider 适配器。

- 配置规则需要可验证、版本化、服务端持久化；业务订单保存当时的应用身份、映射和换算规则版本，不因后续更改而改写。
- 动态生成的 API **必须可用**，但仅通过预定义的操作模板和强制鉴权分发；不执行用户配置的 JS/SQL、不动态代理任意供应商地址，也不绕过现有 `/api/v1/business/orders` 机器身份边界。现有入站 API 不随产品调整而隐式破坏兼容。
- 价值换算预设只定义三创下游应用业务规则，不自动证明上游成本、实际扣余额、退款或到账；礼包数量和人民币必须分账，金额用可信整数最小单位/精确计算。
- 接口发布与供应商真实履约分开：`vendorFulfillmentEnabled=false` 时仍不得真实发放、扣额、补发。工程卡单独实现并验证数据库、鉴权、契约生成、操作幂等、取消与版本回滚。

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
- D 商品列表只读客户端（BHB-011-A，仅 `packages/provider-yangmao`）：唯一 D 签名实现为 Base64(HMAC-SHA256(`timestamp + "\n" + 紧凑 JSON`))，列表签名体为 `{}`，与 A/B/C 的 `X-Sign` 完全分离；客户端只接受 HTTPS 源（仅 loopback 测试例外）、沿用 Node 默认 TLS 验证、不跟随重定向，并把 HTTP 状态、body `code`、非法 JSON、形状不符、超时与调用方取消归一化为稳定错误码；`baseUrl`、凭证、clock 与 transport 全部由服务端调用方注入，错误与日志不含凭证或供应商原文。只解析有契约依据的 `productCode` 与按“元”精确转换为整数分的 `sellPrice`，未确认的展示名称与未知字段不解析、不补假数据；`data` 必须为数组，任一异常项使整次读取失败。该切片不提供 Hono 路由、缓存/落库、UI、商品详情、查单或派发，`vendorFulfillmentEnabled` 保持 false；固定签名向量与模拟传输测试不是真实供应商履约或凭证可用证据。
- 供应商商品只读运营入口（BHB-013-A，最小同源竖切）：`GET /api/v1/catalog/supplier-products` 与 `GET /api/v1/catalog/supplier-products/:productCode` 都要求有效会话，只转接上述 D 适配器（固定受控 origin，不接受调用方 URL/Host），响应统一 `no-store`。服务端只输出明确选定的 DTO：列表为 `provider`/`currency`/`observedAt`/`products[{productCode,sellPriceCents}]`，详情额外有经适配器校验的 `name`；`details`/`extraJson`/`goodsStatus`、签名、AppKey/AppSecret 与手机号不进入响应、日志或浏览器。凭证仅从可选服务器环境 `YANGMAO_INRICE_BASE_URL`/`YANGMAO_INRICE_APP_KEY`/`YANGMAO_INRICE_APP_SECRET` 全量读取，缺失/不完整返回 503 `SUPPLIER_NOT_CONFIGURED`，鉴权/HTTP/业务/超时分别返回非成功码，绝不伪装成空列表。商品管理页用 Ant Design Tabs 分「内部商品」「供应商商品」，供应商 Tab 为 Table/Card 只读视图，关键词与分页消费同一份真实结果，名称仅在选中单品时读取以避免 N+1；不派发、不导入 SQLite、不修改映射或订单，`vendorFulfillmentEnabled` 仍为 false。
- 下游业务订单 HTTP 入站（BHB-012-A，机器对机器竖切）：`POST /api/v1/business/orders` 只接受 strict `{businessOrderNo, productId}`，调用现有 `createOrGetIntent` 一次，新意图 201、精确重放 200；`GET /api/v1/business/orders?businessOrderNo=` 与 `GET /api/v1/business/orders/:orderId` 均按已认证来源查询，不存在与跨来源统一 404。调用方身份只来自服务器侧 `BENEFIT_ORDER_CLIENTS_JSON`（`businessSource -> Bearer token`，至少 32 位高熵令牌，SHA-256 摘要 + timing-safe 比较）；配置缺失返回 503 且零写入，格式非法在启动时失败，缺失/错误 Bearer 返回 401，不使用管理员 Cookie/会话。响应字段固定为平台订单 ID、来源/业务单号、内部商品、状态/版本、冻结履约模式与 `mappingVersionId`、时间戳（创建响应附带 `created`），统一 `no-store`，不回传供应商报文、凭证、收件信息或其他来源数据。CSRF 仅对该 Bearer POST 精确豁免，其它管理员写接口保持双重提交校验。新订单固定 `pending`，不调用供应商、不扣额、不发放；`vendorFulfillmentEnabled=false` 保持。
- 下游应用登记与商品授权配置（BHB-014-A，持久化运营竖切）：迁移 0006 新增 `business_applications`（唯一且不可变的规范化 `business_source`、名称、受限备注、`enabled`/`disabled` 配置状态、乐观锁 `version`、时间戳）、`business_application_products`（`(application_id, product_id)` 复合主键 + 两个外键，重复不可表示，任意供应商商品编码不能作为内部商品 ID 写入）与最小审计 `business_application_events`（操作者、动作、时间）。`GET /api/v1/applications`（分页/关键词/状态）、`GET /api/v1/applications/:id` 只要求有效会话；登记、重命名/备注、启停、整体替换商品集合要求 `admin` 并继续经过全局 CSRF；错误区分 401/403/400/404/409（来源冲突、版本冲突、未知/停用商品），响应统一 `no-store` 且不含令牌或密钥。重复提交相同名称/备注或相同商品集合不增加版本、不写审计；停用应用保留全部配置并可重新启用，没有删除路径。迁移 0006 的触发器拒绝改写已登记来源。该切片是**配置面**：不生成/导入/轮换机器凭证、不修改 `BENEFIT_ORDER_CLIENTS_JSON`、不把已配置商品变成机器调用授权，即登记与启用不等于可调用；现有业务订单 Bearer 边界与来源隔离完全不变。前端仅替换「下游应用」占位页，使用 Ant Design 列表/筛选/分页/抽屉与真实同源 API，商品选择通过现有分页目录接口按需查询，并明确展示“配置未生效于机器调用”。运行时绑定与强制执行由后续 BHB-014-B 独立合同授权。
- 平台本地订单只读运营页（BHB-013-B1，本分支待评审合并）：`GET /api/v1/operations/orders` 与 `GET /api/v1/operations/orders/:orderId` 只接受有效管理员 Session Cookie，不读取机器 Bearer，响应统一 `no-store`；列表支持 `page`（默认 1）、受限 `pageSize` 10/20/50（默认 20）、精确 `businessSource`（大小写归一）、精确 `businessOrderNo`、平台 `status` 与 UTC 毫秒 `createdFrom`/`createdTo`，非法分页/状态/时间/标识返回 400，匿名或过期会话返回 401。查询按 `created_at DESC, id DESC` 稳定排序并以独立 count 返回真实 total；仅使用现有索引与 schema，不新增迁移。列表 DTO 只含平台订单身份、当前内部商品名称（读取时 join，明确不是历史快照）、平台状态/版本、冻结履约模式与 `mappingVersionId`；详情按订单自身 `mappingVersionId` join 不可变映射版本，得到 provider、上游商品编码、映射版本与激活时间，历史 NULL 映射明确显示“无冻结映射（历史订单）”，绝不回退到商品当前映射。本地状态事件与已记录 attempt 事实原样展示，缺少记录只说明本地无记录，不推断供应商未处理、扣额或到账。前端替换「发放记录」占位页，使用 Ant Design Table/Drawer/Descriptions/Timeline，服务端分页筛选、空库/筛选空/401/错误态与窄屏全宽 Drawer 均可见；不提供派发、查单、补发、状态修改或任何供应商 HTTP 调用，`vendorFulfillmentEnabled=false` 保持。

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
