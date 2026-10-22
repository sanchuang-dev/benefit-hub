# Benefit Hub · 代码、目录与质量规范 v0.1

> 2026-10-22。适用于本仓库人类开发与 AI Worker。遵守 [组织工程宪法](https://github.com/sanchuang-dev/.github/blob/main/AGENTS.md) 与 [组织测试标准](https://github.com/sanchuang-dev/.github/blob/main/docs/engineering/testing-standard.md)。本文件记录 **Benefit Hub 特有的工程执行规范**，不重写组织政策。
>
> 技术分层和选型见 [architecture.md](./architecture.md)，UI 规范见 [../design.md](../design.md)（UI 规范尚在 PR 审查阶段时以目标 PR 为准），部署风险见 [operations.md](./operations.md)。

## 1. 工程目标

- 少量目录、清楚归属、稳定契约；不要为了形式套用 DDD/Clean Architecture 的所有层。
- **一份业务事实只有一个拥有者**：外部供应商契约 / 本平台 DTO / DB schema / 页面状态互不混用。
- **一个功能切片一张 Issue/PR**，可独立测试、验收、回退；禁止随手全仓格式化或跨域大清理。
- 成熟组件优先。Ant Design 6 是 UI 基座，React Router 管路由，TanStack Query 管服务端状态，Zustand 只管理少量真正跨页的本地状态。
- 无据不宣称成功：测试通过不等于真实履约，健康检查通过不等于业务可用。

## 2. 目录规范（目标形态，按需生长）

下面是**逐步成长的目录归属**，不是要求一次性创建所有文件、空目录或空的抽象接口。目前保留已经存在的入口和测试路径。

```text
apps/
  admin/
    src/
      main.tsx                 # 入口/挂载
      app/                     # 路由、全局 Provider、主题和页面外壳（需要时）
      pages/                   # 页面级入口：登录/总览/商品/发放/设置
      features/                # 按真实业务域组织，不按组件类型平铺
        catalog/               # 内部/供应商商品：查询、列表、详情
        mapping/               # 草稿、校验、激活、版本历史
        fulfillment/           # 发放记录、履约时间线
      shared/                  # 已有跨域复用需求时才创建
        components/            # 非 Ant Design 已提供的薄业务通用组合
        lib/                   # 小型无副作用帮助函数
      App.tsx                  # 当前 bootstrap 根组件，后续按需迁入 app/
    # 测试首选与实现共置 *.test.ts(x)；需要真实服务的集成测试可放 test/
  api/
    src/
      app.ts                   # Hono 应用装配（保持薄）
      index.ts                 # Node 启动入口
      modules/
        auth/                  # 账户、Session、鉴权
        catalog/               # 商品与映射的领域逻辑
        orders/                # 业务订单与幂等
        fulfillment/           # 发放状态与核实
        operations/            # 运营查询、审计
      db/                      # Drizzle schema、迁移、repository 基础能力
      middleware/              # 仅放确实跨路由的中间件
    test/                      # HTTP/模块集成测试、DB 或外部边界测试
packages/                     # 只有真实跨工作区复用时才新增包
  contracts/                  # 我方公开 DTO/Zod schema，不含 Secret
  provider-yangmao/           # 上游契约、签名和适配，不泄露到前端
docs/
  architecture.md
  code-quality.md
  integrations/yangmao.md
  operations.md
  product-scope.md
design.md                     # 视觉与交互唯一真相源
```

### 归属规则

- 前端 **page 负责组合**，feature 负责有状态的领域交互，shared 仅承担真正跨两个以上业务域的稳定复用；不要发明 BasePage / UniversalTable / GenericForm。
- 某个业务独有的组件、Hook、API 调用、校验和类型，**放在该业务 feature 内**；避免所有文件按 components/hooks/services/types 四个巨大目录分桶。
- 后端一个模块的 route 只处理认证/输入校验/HTTP 映射；service 管业务规则，repository 管持久化；供应商协议适配放 provider 包。无业务复杂度时无需每模块强制拆 route/service/repository 三个空文件。
- `packages/` 不是「先建以后会用」的杂物箱：确认两个工作区需要共享且公共契约稳定时再抽取。不得让 admin import api 的内部文件、DB Schema 或供应商密钥实现。
- **跨业务域依赖先看契约**：catalog 不直接触碰 fulfillment 私有存储；需要共享订单领域数据时由 API/契约显式暴露；禁止循环引用和路径穿透。
- 前端远程数据由 TanStack Query 持有；不要再复制进 Zustand。表单草稿由 Ant Design Form/React 局部状态持有，实际生效映射以服务端为准。
- 按需建目录：**当前没有业务代码的模块不用创建目录、README 和 barrel.ts**；不允许为了满足目录树而生成空占位。

### 文件与命名

- 路径/业务目录统一 `kebab-case`，React 组件文件 `PascalCase.tsx`，Hook 为 `useXxx.ts`；普通模块使用有语义的 `camelCase.ts` 或 `kebab-case.ts`，以所在目录统一为准。
- 单元/组件测试贴近源文件：`*.test.ts` / `*.test.tsx`。端到端测试按需求独立置于 `tests/e2e`（未来接入 Playwright 时）。
- 类型与 Schema 靠近所属领域；共享 Zod Schema 是契约源，禁止再维护矛盾的手工 DTO 副本。
- 不强设单文件行数/函数行数硬阈值；审查职责、依赖、复杂度和命名清晰度。避免深度嵌套；必要时按业务职责抽取，而非为了凑短函数乱拆文件。
- 不建立全局 `utils.ts`、`helpers.ts`、`types.ts` 大杂烩，确实通用的小函数用语义名称。

## 3. 代码卫生

- TypeScript strict + Oxlint 作为现行机械门禁；必要时逐步增加规则。**不要同时引入另一套 ESLint 规则体系**。
- 禁止无原因的 `any`、不安全强转、空 `catch`、隐藏 API 异常、未处理 Promise、生产日志输出手机号/密钥/卡密、动态假成功、硬编码测试凭证。
- 业务入参和供应商响应需要运行时 Schema 校验；不得把 TS 类型当外部输入校验。金额用整数最小货币单位，礼包个数和资金余额互不混算。
- 错误分层：HTTP/供应商错误、业务失败、结果未知是不同状态；未知发券结果不能通过换 `requestId` 盲重试。
- 只在确有复用价值时提取业务通用组件；**Ant Design 能做的绝不重写**，主题以 ConfigProvider Token 为准，不靠大片 `.ant-*` 私有 CSS 覆盖。
- 移除废弃代码时确认消费者；确需保留兼容层需记录消费者及移除条件。代码注释解释 WHY 和不变量，不逐句复述 WHAT。
- 新依赖需说明解决的缺口、仓库是否已有等效能力；使用 pnpm workspace lockfile，并保持 CI 的 frozen install。
- 格式化工具 **尚未决定/接入**，不能自行增加 Oxfmt/Prettier 并顺带全仓重排。

## 4. Vitest 测试基线及演进

- 单元/集成测试运行器统一 **Vitest 4**，各工作区 `test` 脚本使用非 watch 的 `vitest run`。前端交互测试使用 React Testing Library + jsdom，后端 API 测试保持 Node 环境并直接针对真实 Hono app。
- 当前已有的 bootstrap 测试迁移为 Vitest；**仅证明原型明确禁用业务功能，不能当作登录、商品或发放功能验收**。
- 测试尽量就近放置；涉及临时 SQLite / HTTP 供应商模拟边界的集成测试可集中于对应工作区 `test/`。生产 SQLite 数据禁止作为 CI 测试数据。
- Playwright **尚未接入**：只有真实 UI 路由/交互开始实现时再通过单独实施卡引入；不要将 jsdom 断言冒充真实浏览器视觉验收。
- Mock 只隔离无关的外部边界，不可 Mock 掉正在验证的行为；例如幂等测试不能用虚假的 in-memory map 替代数据库唯一约束。
- 不设全局覆盖率硬门槛；覆盖率只用于识别关键风险路径缺口。可重复的 Bug 应留下能阻止回归的测试。

### Q1 / Q2 / Q3 风险门禁

| 等级 | 变更类型 | 最低证据 |
| --- | --- | --- |
| Q1 · 基础 | 纯布局、展示、静态文案、纯函数 | Lint、typecheck、适用的单测、构建；视觉变更要有真实截图 |
| Q2 · 业务 | 筛选、商品编辑、映射草稿、订单查询、状态展示 | Q1 + 针对性 React/API 集成测试；关键页面浏览器交互/错误态验收 |
| Q3 · 高风险 | 登录权限、签名/密钥、额度扣减、发放、幂等、映射激活、DB 迁移、发布 | Q2 + 契约测试/失败路径/并发或迁移测试 + 对应环境运行证据 |

- **Q3 关键路径**：A/B/C vs D 不同签名；重复请求与并发唯一性；B `allClaimed=false` 与原 `requestId` 补发；D `dispatchStatus` 终态；映射版本并发激活与旧订单引用；DB 升级/重建持久化；未授权/过期会话。
- **发布/基础设施**：镜像构建、真实容器健康、数据挂载、宿主机隔离及 HTTPS 验证分别提供证据；纯文档不能被无意义地当作新业务发布。
- 实际供应商联调需要受控的测试资格、凭证与额度；普通 CI **禁止真实消耗权益额度**。

## 5. PR 审查与验收

1. **改动范围**：是否围绕单一 Issue？是否有不相关的依赖升级、批量重排、跨域重构？
2. **边界正确**：Ant Design First、React 状态归属、内部 DTO/上游适配/DB 边界是否守住？
3. **风险与失败**：输入无效、权限不足、请求超时、并发、部分履约、结果未知是否安全？
4. **可维护**：命名、无死代码、无重复抽象；任何可疑的大规模删除必须说明消费者与行为影响。
5. **证据有效**：测试针对本次提交/环境/页面；不得以 CI 绿灯、Mock 成功、截图示意图冒充业务验收。

- PR 描述列出：变更目的和影响范围、风险等级（Q1/Q2/Q3）、验证命令与真实结果、遗留缺口；Q2/Q3 附相关状态或失败路径证据；UI PR 附真实浏览器截图和操作结果。
- **15 个以上文件或大面积删除**是需要人工仔细看的预警，不是自动拒绝线。不能为了绿灯禁用检查、降低断言、删除出错测试或把真实函数 Mock 成必成功。
- 遵守组织级 AI Review 及 P0–P2 规则；AI Review 因配置或执行失败时明确记为 **未完成**，不能当作“未发现问题”；由具备授权的人工审查补足证据。
- P0/P1 阻塞合并，P2 必须修复或记录清晰的接受/延期理由。最终合并、关卡、发布仍需符合当前操作授权。
- 仓库第一期特例：`feat/* → dev`；dev push **会触发 CI/部署**。文档/工具链 PR 不自动获得“跳过发布或直接上线”授权。

## 6. 实施顺序与非目标

本轮只是为 Vitest 接入和目录归属立规矩，**不为对齐目录而移动所有现有代码**；不同时添加覆盖率插件、Playwright、Oxfmt、ESLint、全量架构重构。等出现真实使用场景再分别引入，并各自留可验证的任务和 PR。
