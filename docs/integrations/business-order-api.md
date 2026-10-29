# Benefit Hub · 下游业务订单 HTTP 入站（BHB-012-A / BHB-014-B / BHB-012-C / BHB-012-E）

> **状态（2026-10-29）：创建意图 + 应用级运行时授权 + A 模式下单 / C 模式发券代码。**
>
> - `POST /api/v1/business/orders`（BHB-012-A）仍只创建/重放**本地业务意图**：新订单固定为 `pending`，不调用上力/羊毛供应商，不扣额度、不派发、不产生任何上游 HTTP 副作用。
> - `POST /api/v1/business/orders/:orderId/grant` 与 `/recover`（BHB-012-C，§6）是单独的 A 模式副作用入口：前者在显式付款声明与实时资格检查后扣 1 个礼包额度，后者只读找回链接。
> - `POST /api/v1/business/orders/:orderId/gift-voucher` 与 `/gift-voucher/recover`（BHB-012-E，§7）是 C 模式入口：C 对领取人免费，但供应商在签发时即预扣 `packCount`（1–12）个礼包；恢复只读使用已加密保存的券码。
> - 以上代码与隔离测试已实现，但**未执行真实上力扣额/发券，也未完成 live 验收**。平台不提供始终为 false 的虚构履约开关字段。BHB-014-B 起，凭证可在管理后台按应用签发，应用启停与内部商品白名单会真实约束机器调用；Draft PR 合入、CI 绿灯或本文件存在都不代表真实履约上线。

范围为机器对机器接口，与管理后台的人类 Cookie 登录是两套独立身份边界。实现归属 `apps/api/src/modules/orders/business-order-routes.ts`、`a-prepaid-grant.ts`、`c-gift-voucher.ts`、`service-auth.ts` 与 `apps/api/src/modules/applications/credentials.ts`。

## 1. 身份与服务凭证

- 只有 `Authorization: Bearer <token>` 参与鉴权；管理员 Cookie、管理员会话、CSRF Cookie 均不能替代服务凭证。业务来源绝不由请求体、查询参数或任意 Header 自报。
- 凭证有两种来源，均只解析出唯一 `businessSource`：
  1. **应用凭证（常规路径）**：管理员在「下游应用 → 详情 → 机器凭证」签发，服务端随机生成，绑定该应用。SQLite 只保存 SHA-256 摘要、应用绑定、签发/撤销元数据与最小审计；原文仅在签发响应中出现一次，不写日志、DTO、前端持久存储或 Git。
  2. **旧环境凭证（兼容路径）**：服务器侧 `BENEFIT_ORDER_CLIENTS_JSON`，格式为 `businessSource -> token` 的 JSON 对象。继续兼容已接入但尚未迁入应用的调用方，不强制一次性断流。
- 环境映射的键统一转为小写并须匹配 `[a-z0-9][a-z0-9._-]{0,63}`；令牌须为 32–512 位可见 ASCII 字符且不含空格。以下配置**整体失败**，服务在启动时拒绝继续运行（fail closed）：
  - 非法 JSON、非对象、空对象；
  - 非法的业务来源键、仅大小写不同的重复键；
  - 过短/含空白/非字符串令牌，或同一个令牌绑定两个来源。
- 机器接口的可用性：**既没有任何环境凭证、也从未签发过任何应用凭证**时返回 `503 SERVICE_UNAVAILABLE`，且在进入 Repository 前终止（零写入）。只要存在任一种凭证记录，接口就不再整体 503；已撤销凭证按无效凭证统一返回 401，具体调用是否被授权由凭证与应用配置决定。
- 令牌不会出现在响应、日志、URL 或 DTO 中；环境配置对象只保留 SHA-256 摘要，比较使用固定长度 timing-safe 比较；应用凭证按摘要索引以哈希等值匹配。一个令牌只代表一个应用/来源，无法通过请求体、查询参数或路径切换到另一个业务来源。不新增 CORS 放行。
- 应用凭证生命周期：签发、查看非敏感状态（有效/已撤销、签发/撤销时间）、追加新凭证、撤销。同一应用最多 5 个有效凭证；撤销立即生效且幂等，已撤销凭证立刻返回 401。原文无法再次查看，丢失只能重新签发。
- **应用登记配置是运行时授权**：若 `businessSource` 已登记为应用，`enabled`/`disabled` 与商品白名单同时对应用凭证和该来源的旧环境凭证生效；环境凭证不能绕过数据库配置。未登记来源继续走旧兼容路径（无白名单约束）。

部署配置示例（**只在服务器侧注入，变量值不得写入仓库、Issue、PR、CI 或截图**）：

```bash
# 运维在服务器环境/受控 compose override 中注入；此处仅为变量名示例。
BENEFIT_ORDER_CLIENTS_JSON='{"legacy-source":"<token>"}'
```

`compose.yaml`、CI 和 `.env.example` 均**不**保存真实令牌。环境变量变更需重启应用。

### 1.1 从环境凭证迁移到应用凭证

1. 在「下游应用」登记该 `businessSource`，配置需要下单的内部商品，签发新凭证。
2. 把新 Bearer 配置到调用方服务器侧并验证 `POST /api/v1/business/orders` 与查询正常。
3. 调用方切换完成后撤销旧凭证的替代物：应用页撤销已签发的旧凭证；环境变量中的同源条目由运维在受控环境删除并重启。
4. 本切片**不**自动导入环境明文、不删除环境变量、不做静默回退。迁移期间两种来源可以并存；只要该来源已登记，环境凭证同样受应用启停与白名单约束。

## 2. 端点

Base path：`/api/v1/business/orders`。所有响应都是 JSON 且带 `Cache-Control: no-store`。

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| `POST` | `/api/v1/business/orders` | 创建或精确重放一个业务订单意图。新订单 **201**，完全相同请求 **200**。 |
| `GET` | `/api/v1/business/orders?businessOrderNo=...` | 客户端丢失 POST 响应后，按**当前来源**的业务单号恢复。 |
| `GET` | `/api/v1/business/orders/:orderId` | 按平台内部订单 ID 查询，仍限定当前来源。 |

### 2.1 创建 / 重放

请求体为 strict JSON，只允许两个字段；未知字段（包括 `businessSource`、`fulfillmentMode`、状态、金额、收件信息）返回 400：

```json
{ "businessOrderNo": "FICTIONAL-ORDER-1001", "productId": "internal-product-id" }
```

`businessOrderNo` 为 1–128 位可见 ASCII（区分大小写）。新建订单的门槛按顺序为：

1. 凭证已认证；若该 `businessSource` 已登记应用，应用必须为 `enabled`（否则 **403 `APPLICATION_DISABLED`**）。
2. 若已登记，`productId` 必须在应用的商品白名单内（否则 **403 `PRODUCT_NOT_AUTHORIZED`**，未知商品同样返回该码，不探测是否存在）。
3. 内部商品必须存在且为 `active`，并拥有当前生效映射版本。履约模式与映射版本由服务端从快照冻结，调用方不能选择。

授权读取与订单写入在同一个 `BEGIN IMMEDIATE` 事务内完成，因此并发的应用停用或白名单更新不会在“检查已经通过、订单尚未写入”的间隙被绕过。任一未通过都不会产生订单、状态事件或履约尝试记录。

成功响应：

```json
{
  "order": {
    "id": "fictional-platform-order-id",
    "businessSource": "local-life",
    "businessOrderNo": "FICTIONAL-ORDER-1001",
    "productId": "internal-product-id",
    "status": "pending",
    "version": 1,
    "fulfillmentMode": "B",
    "mappingVersionId": "fictional-frozen-mapping-version-id",
    "createdAt": 1760000000000,
    "updatedAt": 1760000000000
  },
  "created": true
}
```

- `created: true` 只出现在 201；精确重放返回 200 与 `created: false`，且 `id`、`version`、`mappingVersionId`、`fulfillmentMode` 与首次创建完全相同。
- 时间戳为 UTC epoch 毫秒整数。
- 响应不包含供应商原始报文、凭证、其他业务的快照、真实收件信息，也不会把本地 `pending` 描述成履约成功。

### 2.2 查询

两个 GET 成功时返回 `{ "order": { ...同上... } }`（不含 `created`）。查询严格按已认证来源过滤：

- 订单不存在，或存在但属于另一个业务来源：统一 **404 `ORDER_NOT_FOUND`**，不区分两种情况，也不泄露订单是否存在。
- `?businessOrderNo=` 必须恰好出现一次；缺少、重复或携带其他查询参数（例如试图注入 `businessSource`）返回 400。

## 3. 幂等与冻结语义

- 同一 `businessSource + businessOrderNo` 永远对应一个已持久化订单；并发调用由 Repository 的 `BEGIN IMMEDIATE` 事务与数据库唯一约束收敛为一行。
- 已登记应用被停用或凭证被撤销时，该来源的机器调用（含读取与重放）先被拒绝：停用为 **403 `APPLICATION_DISABLED`**，撤销/无效凭证为 **401 `UNAUTHORIZED`**。订单与配置不会被删除，后台仍可查看；重新启用后按下面的重放规则继续。
- 重放优先于商品资格检查：应用仍启用时，商品后来被停用、移出白名单或映射被轮换，精确重放仍返回原订单、原履约模式与原 `mappingVersionId`，配置变更不会改写已创建的订单。
- 同一业务身份提交不同 `productId`：**409 `ORDER_INTENT_CONFLICT`**，不覆盖既有订单。
- 不同来源可以使用相同的业务单号，各自拥有独立订单；来源之间互不可见。
- 新订单状态固定 `pending`，初始状态事件与订单在同一事务写入；本切片没有状态机、没有供应商调用、没有重试/补发。

## 4. 稳定错误码

| HTTP | `error` | 触发条件 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | 非 JSON / strict schema 不通过 / 非法业务单号或查询参数；可带 `fields`（仅字段路径，不回显值） |
| 401 | `UNAUTHORIZED` | 缺少、格式错误、未匹配、已撤销或不属于任何应用的 Bearer 凭证（统一不区分） |
| 403 | `APPLICATION_DISABLED` | 凭证有效但所属/已登记应用已停用 |
| 403 | `PRODUCT_NOT_AUTHORIZED` | 已登记应用的商品白名单不包含该 `productId` |
| 403 | `CSRF_TOKEN_INVALID` / `CSRF_ORIGIN_REJECTED` | 仅适用于仍走 Cookie 的其它写接口；机器订单 POST 不要求 CSRF |
| 404 | `ORDER_NOT_FOUND` | 订单不存在或不属于当前来源 |
| 404 | `PRODUCT_NOT_FOUND` | 内部商品不存在（仅未登记来源的兼容路径） |
| 409 | `PRODUCT_NOT_ACTIVE` | 内部商品已停用，不能新建订单 |
| 409 | `ORDER_MAPPING_UNAVAILABLE` | 内部商品没有当前生效映射版本 |
| 409 | `ORDER_INTENT_CONFLICT` | 同一来源+业务单号已存在但商品不同 |
| 503 | `SERVICE_UNAVAILABLE` | 既未配置环境凭证，也从未签发过任何应用凭证 |
| 500 | `INTERNAL_ERROR` | 未预期错误；不返回 SQL、堆栈或请求内容 |

错误响应形如 `{ "error": "ORDER_NOT_FOUND", "message": "订单不存在" }`。

## 5. 安全与运维要点

- 机器 `POST /api/v1/business/orders`（创建意图）与 `POST /api/v1/business/orders/:orderId/grant|recover` 是全局 CSRF 的窄豁免：这些 method+path 自身必须通过 Bearer 鉴权，路径模式严格限定；所有人类 Cookie 写接口（登录、商品、映射、应用与凭证管理）继续要求 `bh_csrf` 双重提交和同源 `Origin`。
- 不要把令牌放入 URL、查询参数、前端 bundle、GitHub 普通变量或日志。应用凭证只在签发响应中出现一次，浏览器不持久保存。
- 停用应用、撤销凭证、移出商品白名单都在下一次请求立即生效；已创建订单的冻结快照不被改写。
- 该接口只承接本地业务意图。真实供应商派发/查单、扣额、重试、对账与运营 UI 属于后续独立卡片，需要逐模式实现供应商合同、幂等、失败恢复与结果核实。

## 6. A 预充值礼包下单与领取链接恢复（BHB-012-C）

> **状态（2026-10-29）：代码与隔离测试已实现；未在 CI 或 Worker 中执行任何真实上力扣额。** 真实 A 下单需要维护者单独批准、可用的测试礼包额度与收件手机号，并以脱敏联调证据另行验收；本文件不代表 live 验收通过。

A 模式在既有业务订单之上增加两个机器接口，仍只接受 `Authorization: Bearer <token>`，不接受管理员 Cookie。它们与其他机器 POST 一样是 CSRF 窄豁免，但每次都必须先通过服务凭证鉴权。

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| `POST` | `/api/v1/business/orders/:orderId/grant` | 对一个已创建的业务订单执行 A 模式下单；成功后扣 1 个礼包额度并返回 `claimUrl`。 |
| `POST` | `/api/v1/business/orders/:orderId/recover` | 用已持久化的 `requestId` 只读查询上力，取回原领取链接；不扣额度。 |

### 6.1 发起下单

请求体为 strict JSON，只允许三个字段：

```json
{
  "phone": "13800138000",
  "refCode": "ref_abc123",
  "paymentReference": "PAY-FICTIONAL-1001"
}
```

- `phone`：必填，`^1\d{10}$`；只用于本次资格检查和签名。平台**不持久化明文手机号**，只保存主密钥 HMAC 摘要用于拒绝冲突的重复输入，且不会写日志。
- `refCode`：必填，1–64 位可见 ASCII 子分销推广码。
- `paymentReference`：必填，1–128 位可见 ASCII。它是业务方**显式声明已收款/已授权**的事实；平台没有支付网关，也不从 `pending` 本地意图推断付款。
- 不接受 `businessSource`、`provider`、`fulfillmentMode`、供应商 `productCode`、`requestId`、状态或金额；供应商、模式与上游商品编码只来自订单创建时冻结的映射快照。

执行顺序：

1. 校验订单属于当前凭证绑定的 `businessSource`；不属于即 404，不区分“不存在”和“他人订单”。
2. 已登记应用必须为 `enabled` 且内部商品仍在白名单；未登记来源沿用既有兼容路径。
3. 订单冻结映射必须是 `yangmao` + `A`，上游商品编码取冻结快照，不取当前映射。
4. 必须配置服务器主密钥；否则 503 `SUPPLIER_KEY_UNAVAILABLE`，不发起供应商请求。
5. 先调用只读 `POST /open/v1/prepaid/purchase-check`。`purchaseRestricted`、`giftUnclaimed`、`lotteryUnbet` 任一为真即 409 `PURCHASE_NOT_ELIGIBLE`，不落下单记录、不扣额度。
6. 在同一短事务内持久化幂等身份并追加一条 `grant/unknown` 尝试记录，把订单从 `pending` 改为 `processing`；事务提交后才发起签名的 `POST /open/v1/prepaid/orders`，**网络调用期间不持有 SQLite 事务**。
7. 供应商 `code=0` 且同时具备 `orderNo` 与合法 `claimUrl` 才记为受理：订单进入 `awaiting_claim`，`claimUrl` 只在该响应中返回。**`awaiting_claim` 不是 `completed`，也不代表用户已领取到账。**

`requestId` 由平台订单 ID 确定性派生（前缀 `bhA` + SHA-256 摘要，共 63 字符），数据库唯一；重试不会生成新 ID。下单记录只保存 `requestId`、上游 `orderNo`、状态、推广码、付款引用、主密钥 HMAC 摘要与时间，不保存 claimUrl。

成功响应：

```json
{
  "order": { "id": "fictional-platform-order-id", "status": "awaiting_claim", "fulfillmentMode": "A", "...": "同业务订单 DTO" },
  "grant": {
    "state": "accepted",
    "requestId": "bhA0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab",
    "upstreamOrderNo": "PKG20261022000001",
    "attemptedAt": 1760000000000,
    "updatedAt": 1760000000100
  },
  "claimUrl": "https://h5.example.test/bet?orderNo=PKG20261022000001",
  "observedAt": 1760000000100
}
```

`claimUrl` 可能包含供应商侧的个人化参数，属于敏感结果：只返回给已认证的业务调用方，不落库、不写日志、不进前端 bundle。

### 6.2 重复、结果未知与恢复

- **完全相同输入重复调用 grant**：不再发送下单请求，改用同一 `requestId` 的只读 `orders/query` 取回链接；返回同一 `requestId` / 上游订单号。若原请求仍在处理中，409 `GRANT_IN_PROGRESS`。
- **同一订单不同手机号或推广码**：409 `GRANT_INPUT_CONFLICT`，不覆盖既有记录。
- **超时、网络失败、HTTP 5xx、`code=0` 但字段缺失/非法**：订单与下单记录明确保留为 `unknown`，绝不自动重发下单；用 `recover` 或稍后 grant 重试（同样只读）核实。
- **上力明确业务拒绝（400/401/403）**：记录为 `rejected`、订单 `failed`；后续重复调用 409 `GRANT_NOT_RETRYABLE`，不盲重试。
- **恢复成功**：只读查询返回合法 `claimUrl` 时，记录 `accepted` 并把订单置为 `awaiting_claim`；恢复接口本身永远不扣额度。
- **查询明确不存在**：仍保持 `unknown`（原请求可能未发出），不会自动生成新 `requestId` 或新下单。

`POST /:orderId/recover` 请求体为 `{}`，不需要手机号；它要求订单已有下单记录（否则 404 `GRANT_NOT_FOUND`）。

### 6.3 运营可见性

「发放记录 → 订单详情」对 A 模式订单展示下单记录状态、上游请求号、上游订单号与最近结果时间；不展示手机号、付款引用、密钥或供应商原始报文。运营需要领取链接时，在「供应商管理 → 上力 → 只读联调 → A 订单查询」使用既有管理员只读接口 `POST /api/v1/suppliers/yangmao/prepaid/orders/query`，传入详情中展示的同一 `requestId`。该接口要求管理员会话与 CSRF，返回 `claimUrl`；它不是自动重发，也不改变平台状态。

### 6.4 新增稳定错误码

除既有订单错误外，A 下单/恢复可能返回：`PURCHASE_NOT_ELIGIBLE`、`ORDER_MODE_UNSUPPORTED`、`ORDER_NOT_GRANTABLE`、`ORDER_STATE_CONFLICT`、`GRANT_INPUT_CONFLICT`、`GRANT_IN_PROGRESS`、`GRANT_NOT_RETRYABLE`、`GRANT_NOT_FOUND`、`GRANT_STATE_CONFLICT`、`SUPPLIER_NOT_CONFIGURED`、`SUPPLIER_KEY_UNAVAILABLE`、`SUPPLIER_TIMEOUT`、`SUPPLIER_AUTH_FAILED`、`SUPPLIER_BUSINESS_FAILED`、`SUPPLIER_RESPONSE_UNVERIFIED`、`SUPPLIER_UNAVAILABLE`。错误体只额外携带数字 `vendorCode` / `httpStatus`（如可用），不回显供应商 message、手机号、签名或原始响应。

### 6.5 证据边界

- 单元/集成测试覆盖：A 签名字段与独立 OpenSSL 向量、D `X-Signature` 不复用、响应 schema、HTTP 状态与 body `code` 双层判断、超时/取消/传输失败、手机号本地校验、并发唯一预约、映射冻结、租户隔离、未知结果与同 `requestId` 恢复、明确拒绝不重试、master key/供应商未配置、CSRF 窄豁免与 Bearer 边界。
- API 集成测试通过**真实 Hono app → 本机 loopback 假供应商 HTTP 服务**执行，不 Mock 订单数据库或幂等约束；假供应商只存在于测试进程，夹具明确标注为虚构。
- `pnpm check`、Docker 镜像构建与真实容器健康检查需要在提交/CI 环境另行执行。**真实上力 A 扣额、真实 claimUrl 与平台状态证据尚未取得**；没有维护者单独批准、测试额度与收件手机号时，不得用本文或 CI 绿灯宣称 live 验收。

## 7. C 免费礼包券签发与恢复（BHB-012-E）

> **状态（2026-10-29）：代码与隔离测试已实现；未执行任何真实上力 C 签发或券码查询。** C 面向领取人免费，但供应商在签发时即预扣 `packCount` 个礼包额度，因此真实测试仍需维护者单独批准、可用测试额度和明确领取意图。

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| `POST` | `/api/v1/business/orders/:orderId/gift-voucher` | 对已创建的业务订单签发 C 模式礼包券；成功后返回 `voucherCode`、`claimUrl` 与供应商报告的礼包额度，订单进入 `awaiting_claim`。 |
| `POST` | `/api/v1/business/orders/:orderId/gift-voucher/recover` | 用已加密保存的券码只读查询上力，刷新 `packRemaining`/`packTotal`/`expiresAt`；不重新签发。 |

### 7.1 发起签发

请求体为 strict JSON，只允许三个字段：

```json
{ "packCount": 3, "refCode": "ref_abc123", "phone": "13800138000" }
```

- `packCount`：必填整数 1–12；供应商**签发即预扣**该数量礼包，不是领取时才扣。
- `refCode`：必填，1–64 位可见 ASCII 子分销推广码。
- `phone`：可选，`^1\d{10}$`；不传则由领取人在 H5 首次填写并绑定该券。平台不持久化明文手机号，只保存主密钥 HMAC 摘要用于拒绝冲突输入。
- 不接受 `paymentReference`、供应商、履约模式、上游 `productCode`、`requestId`、券码或状态；C 不上付款门槛，供应商与上游商品编码只来自订单创建时冻结的 **C** 映射。

执行顺序：

1. 校验订单属于当前凭证绑定的 `businessSource`；否则 404，不区分“不存在”和“他人订单”。
2. 已登记应用必须 `enabled` 且内部商品仍在白名单；未登记来源沿用既有兼容路径。
3. 订单冻结映射必须是 `yangmao` + `C`；上游商品编码取冻结快照，不取当前映射。
4. 必须配置服务器主密钥；否则 503 `SUPPLIER_KEY_UNAVAILABLE`，不发起供应商请求。
5. 在同一短事务内持久化幂等身份、`packCount`/推广码/手机号摘要并追加 `grant/unknown` 尝试，把订单从 `pending` 改为 `processing`；事务提交后才发起签名 `POST /open/v1/gift-vouchers`，**网络调用期间不持有 SQLite 事务**。
6. 供应商 `code=0` 且同时返回合法 `voucherCode` 与 `claimUrl` 才记为签发：订单进入 `awaiting_claim`。**签发不是核销，也不是 `completed`；用户仍需打开链接领取。**
7. `voucherCode`、`claimUrl` 和原始 `expiresAt` 只加密保存（既有主密钥派生的 AES-256-GCM），只在认证响应中返回给调用方；不写日志、列表或前端 bundle。

`requestId` 由平台订单 ID 确定性派生（前缀 `bhC` + SHA-256 摘要，共 63 字符），数据库唯一。重复签发若 `packCount`、`refCode` 或手机号（含“未提供”）与首次不同，409 `GIFT_VOUCHER_INPUT_CONFLICT`，不会覆盖或重发。

成功响应（摘录）：

```json
{
  "order": { "status": "awaiting_claim", "fulfillmentMode": "C", "...": "同业务订单 DTO" },
  "voucher": {
    "state": "issued",
    "requestId": "bhC0123456789abcdef...",
    "packCount": 3,
    "packTotal": 3,
    "packRemaining": 2,
    "attemptedAt": 1760000000000,
    "updatedAt": 1760000000100,
    "lastObservedAt": 1760000000100
  },
  "voucherCode": "GV...",
  "claimUrl": "https://h5.example.test/voucher?code=GV...",
  "expiresAt": "2026-11-28 00:00:00",
  "balanceAfter": 97,
  "idempotentReplay": false,
  "observedAt": 1760000000100
}
```

### 7.2 重复、未知与恢复

- **完全相同输入重复签发**：返回已签发事实，不再请求供应商；原请求仍在处理中时 409 `GIFT_VOUCHER_IN_PROGRESS`。
- **超时、网络失败、HTTP 5xx、`code=0` 但字段缺失/非法**：记录保持 `unknown`，订单 `unknown`；**没有已存券码时不允许自动重签**，重复签发或恢复均返回 409 `GIFT_VOUCHER_OUTCOME_UNKNOWN`，只能凭已记录 `requestId` 人工核实。
- **上力明确业务拒绝（400/401/403）**：记录 `rejected`、订单 `failed`；后续 409 `GIFT_VOUCHER_NOT_RETRYABLE`，不盲重试。
- **恢复**：只读 `GET /open/v1/gift-vouchers/{code}`，使用签发返回的**大写券码**。成功只更新供应商报告的额度/有效期并保持 `awaiting_claim`；业务 400、字段缺失、鉴权失败或超时都按查询失败处理，**不推断已核销、到期或额度退回**。恢复请求体为 `{}`；没有发券记录时 404 `GIFT_VOUCHER_NOT_FOUND`。

### 7.3 运营可见性

「发放记录 → 订单详情」对 C 模式订单展示发券状态、上游请求号、`packCount`、供应商报告的 `packTotal`/`packRemaining`、最近观察时间与发起/更新时间；不展示券码、领取链接、手机号、摘要、密文或供应商原始报文。剩余礼包数只是供应商最近一次观察，不是平台退款推断。

### 7.4 新增稳定错误码

`GIFT_VOUCHER_INPUT_CONFLICT`、`GIFT_VOUCHER_IN_PROGRESS`、`GIFT_VOUCHER_NOT_RETRYABLE`、`GIFT_VOUCHER_NOT_FOUND`、`GIFT_VOUCHER_OUTCOME_UNKNOWN`；其余复用 `ORDER_MODE_UNSUPPORTED`、`ORDER_NOT_GRANTABLE`、`SUPPLIER_*` 与既有订单错误。错误体只额外携带数字 `vendorCode` / `httpStatus`，不回显券码、链接、手机号、签名或供应商 message。

### 7.5 证据边界

- provider 单测覆盖 C 签名字段、`packCount` 字符串化、可选 `phone`/`productCode`、成功/未知字段剥离/非法成功/400/401/403/malformed envelope/超时/取消；loopback HTTP 覆盖默认 fetch 的签发 POST、按券码 GET 与超时。
- API 集成测试通过真实 Hono → loopback 假供应商覆盖真实签名、冻结 C 映射、并发唯一预约、幂等、冲突、未知不重发、查询 400 不回退额度、密文落库与运营详情脱敏、跨业务隔离。
- **未执行真实 C 签发、真实券码或真实额度查询**；CI 绿灯不等于 live 验收。真实测试需维护者批准并另行提供脱敏证据。
