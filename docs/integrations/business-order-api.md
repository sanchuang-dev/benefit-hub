# Benefit Hub · 下游业务订单 HTTP 入站（BHB-012-A）

> **状态（2026-10-28）：仅本地业务意图。** 本接口把已合入的订单 Repository 暴露给三创下游业务（如本地生活、卡博士）做**接单与查询**；新订单固定为 `pending`，不调用上力/羊毛供应商，不扣额度、不派发、不产生任何上游 HTTP 副作用。平台不再提供始终为 false 的虚构履约开关字段。Draft PR 合入或本文件存在都不代表真实履约上线。

范围为机器对机器接口，与管理后台的人类 Cookie 登录是两套独立身份边界。实现归属 `apps/api/src/modules/orders/business-order-routes.ts`。

## 1. 身份与服务凭证

- 只有 `Authorization: Bearer <token>` 参与鉴权；管理员 Cookie、管理员会话、CSRF Cookie 均不能替代服务凭证。
- 凭证只从**服务器侧**环境变量 `BENEFIT_ORDER_CLIENTS_JSON` 读取，格式是一个 JSON 对象，键为业务来源（`businessSource`），值为该来源专属的高熵 Bearer 令牌：

```json
{ "local-life": "<fictional-token-32-plus-visible-ascii>", "card-doctor": "<another-fictional-token>" }
```

- 键统一转为小写并须匹配 `[a-z0-9][a-z0-9._-]{0,63}`；令牌须为 32–512 位可见 ASCII 字符且不含空格。
- 以下配置**整体失败**，服务在启动时拒绝继续运行（fail closed），不会退化成“任何来源均可写”：
  - 非法 JSON、非对象、空对象；
  - 非法的业务来源键、仅大小写不同的重复键；
  - 过短/含空白/非字符串令牌，或同一个令牌绑定两个来源。
- 变量缺失或为空白字符串时，订单接口明确返回 `503 SERVICE_UNAVAILABLE`，且在进入 Repository 前终止（零写入）。
- 令牌不会出现在响应、日志、URL 或 DTO 中；服务端配置对象只保留 SHA-256 摘要，比较使用固定长度 timing-safe 比较。
- 一个令牌只代表一个来源：无法通过请求体、查询参数或路径切换到另一个业务来源。不新增 CORS 放行。

部署配置示例（**只在服务器侧注入，变量值不得写入仓库、Issue、PR、CI 或截图**）：

```bash
# 运维在服务器环境/受控 compose override 中注入；此处仅为变量名示例。
BENEFIT_ORDER_CLIENTS_JSON='{"local-life":"<token>","card-doctor":"<token>"}'
```

`compose.yaml`、CI 和 `.env.example` 均**不**保存真实令牌。修改配置需要重启应用；轮换令牌时应同时更换配置并重新部署，不在运行时热加载。

> **应用登记不等于服务凭证（BHB-014-A）。** 管理后台「下游应用」登记的同名 `businessSource` 只是运营配置，不会生成、导入、替换或废止 `BENEFIT_ORDER_CLIENTS_JSON` 中的令牌，也不会把已配置的内部商品清单变成运行时授权。即使应用已登记并启用，缺少/错误 Bearer 仍返回 401；停用应用也不会使既有服务凭证失效。运行时绑定与强制校验属于后续独立切片。

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

`businessOrderNo` 为 1–128 位可见 ASCII（区分大小写）；`productId` 必须是已存在、`active` 且拥有当前生效映射版本（active mapping snapshot）的内部商品。履约模式与映射版本由服务端从快照冻结，调用方不能选择。

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
- 重放优先于当前资格检查：商品后来被停用或映射被轮换，精确重放仍返回原订单、原履约模式与原 `mappingVersionId`。
- 同一业务身份提交不同 `productId`：**409 `ORDER_INTENT_CONFLICT`**，不覆盖既有订单。
- 不同来源可以使用相同的业务单号，各自拥有独立订单；来源之间互不可见。
- 新订单状态固定 `pending`，初始状态事件与订单在同一事务写入；本切片没有状态机、没有供应商调用、没有重试/补发。

## 4. 稳定错误码

| HTTP | `error` | 触发条件 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | 非 JSON / strict schema 不通过 / 非法业务单号或查询参数；可带 `fields`（仅字段路径，不回显值） |
| 401 | `UNAUTHORIZED` | 缺少、格式错误或未匹配任何来源的 Bearer 凭证 |
| 403 | `CSRF_TOKEN_INVALID` / `CSRF_ORIGIN_REJECTED` | 仅适用于仍走 Cookie 的其它写接口；机器订单 POST 不要求 CSRF |
| 404 | `ORDER_NOT_FOUND` | 订单不存在或不属于当前来源 |
| 404 | `PRODUCT_NOT_FOUND` | 内部商品不存在 |
| 409 | `PRODUCT_NOT_ACTIVE` | 内部商品已停用，不能新建订单 |
| 409 | `ORDER_MAPPING_UNAVAILABLE` | 内部商品没有当前生效映射版本 |
| 409 | `ORDER_INTENT_CONFLICT` | 同一来源+业务单号已存在但商品不同 |
| 503 | `SERVICE_UNAVAILABLE` | 服务器未配置任何业务来源凭证 |
| 500 | `INTERNAL_ERROR` | 未预期错误；不返回 SQL、堆栈或请求内容 |

错误响应形如 `{ "error": "ORDER_NOT_FOUND", "message": "订单不存在" }`。

## 5. 安全与运维要点

- 机器 `POST /api/v1/business/orders` 是全局 CSRF 的唯一窄豁免：该路径 (method+path) 自身必须通过 Bearer 鉴权；所有人类 Cookie 写接口（登录、商品、映射等）继续要求 `bh_csrf` 双重提交和同源 `Origin`。
- 不要把令牌放入 URL、查询参数、前端 bundle、GitHub 普通变量或日志。
- 该接口只承接本地业务意图。真实供应商派发/查单、扣额、重试、对账与运营 UI 属于后续独立卡片，需要逐模式实现供应商合同、幂等、失败恢复与结果核实。
