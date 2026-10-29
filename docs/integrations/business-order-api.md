# Benefit Hub · 下游业务订单 HTTP 入站（BHB-012-A / BHB-014-B）

> **状态（2026-10-28）：仅本地业务意图 + 应用级运行时授权。** 本接口把已合入的订单 Repository 暴露给三创下游业务（如本地生活、卡博士）做**接单与查询**；新订单固定为 `pending`，不调用上力/羊毛供应商，不扣额度、不派发、不产生任何上游 HTTP 副作用。平台不再提供始终为 false 的虚构履约开关字段。BHB-014-B 起，凭证可在管理后台按应用签发，应用启停与内部商品白名单会真实约束本接口；Draft PR 合入或本文件存在都不代表真实履约上线。

范围为机器对机器接口，与管理后台的人类 Cookie 登录是两套独立身份边界。实现归属 `apps/api/src/modules/orders/business-order-routes.ts`、`service-auth.ts` 与 `apps/api/src/modules/applications/credentials.ts`。

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

- 机器 `POST /api/v1/business/orders` 是全局 CSRF 的唯一窄豁免：该路径 (method+path) 自身必须通过 Bearer 鉴权；所有人类 Cookie 写接口（登录、商品、映射、应用与凭证管理）继续要求 `bh_csrf` 双重提交和同源 `Origin`。
- 不要把令牌放入 URL、查询参数、前端 bundle、GitHub 普通变量或日志。应用凭证只在签发响应中出现一次，浏览器不持久保存。
- 停用应用、撤销凭证、移出商品白名单都在下一次请求立即生效；已创建订单的冻结快照不被改写。
- 该接口只承接本地业务意图。真实供应商派发/查单、扣额、重试、对账与运营 UI 属于后续独立卡片，需要逐模式实现供应商合同、幂等、失败恢复与结果核实。
