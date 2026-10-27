# 羊毛系统 · Open API 接入契约摘要

> 对接依据：用户提供的 [《开放接口（Open API）接入对接文档》原始副本](./open-api-2026-10-22.md)，版本 **2026-10-22**。本文件是工程**摘要、联调证据与待核实清单**，不是厂商原文；两者矛盾时必须保留差异并核验，不能凭摘要擅自补齐协议。
>
> 厂商总览引用了《权益包预充值模式接口对接文档》《上力权益OpenAPI接口对接文档》《apifox-open-api-debug》三份更细资料；**目前仓库未获得这些文件的完整内容**。缺失的状态码/错误字段不能猜测。
>
> 公开仓库可以保存经审查不含凭证的接口说明副本；不得提交合作方 AppKey/AppSecret、真实手机号、卡密、调试响应中的个人数据或任何敏感凭证。

## 1. 能力与额度账户

| 模式 | 扣减 | 场景 | 关键结果 |
| --- | --- | --- | --- |
| A 预充值下单 → H5 领取 | 子分销礼包余额 -1 | 彩票/腾讯出行/趣米礼包；业务方已收款后建单 | `claimUrl`；用户需在供应商 H5 完成可领取步骤 |
| B 服务商直充 | 子分销礼包余额 -1 | **仅纯腾讯出行礼包**，无领取页面 | `allClaimed`、`items`；可能部分成功 |
| C 公众号免费礼包券 | 签发时预扣 `packCount` 个 | 发兑换码/链接，用户手机号领取 | `voucherCode`、`claimUrl`、有效期等 |
| D 权益商品派发 | 权益余额按**金额（元）**扣费 | 会员、卡密等 | 先建单并提交；通过 `dispatchStatus` 查履约 |

A/B/C 礼包额度和 D 权益金额是**两本账**，不能互用。对接总览中的 `balanceAfter` 是扣减后返回值，不等价于可随时查询的实时余额 API。

## 2. A/B/C 的签名

路径前缀：`/open/v1`。请求头：
- `X-App-Key`
- `X-Timestamp`：毫秒时间戳，允许偏差不超过 5 分钟
- `X-Nonce`：每次调用建议唯一
- `X-Sign`：将约定参与字段的**非空值**按字段名升序拼接为 `key=value&...`，结尾追加 `&appSecret={AppSecret}`，计算 **SHA-256 大写十六进制**

注意：各接口参与签名字段不同；字段顺序、数字转字符串和空值规则必须用厂商契约测试。AppSecret 只能在服务端。

## 3. A 预充值下单

1. `POST /open/v1/prepaid/purchase-check`：收款前检查手机号，不扣额度。涉及 `purchaseRestricted`（7 天限领）、`giftUnclaimed`、`lotteryUnbet`；受限不收款，有未领取内容则把返回链接给用户。
2. 业务方支付成功后 `POST /open/v1/prepaid/orders`：`phone`、`refCode` 必填，`productCode` 可选，`requestId` 建议采用业务支付单号作为幂等键（最多 64 字符）。返回供应商 `orderNo`、`claimUrl`、`balanceAfter`、`idempotentReplay`。
3. `POST /open/v1/prepaid/orders/query`：使用 `requestId` 找回领取链接；不扣新额度。 `claimable=true` 指还有未完成权益。

**关键**：A 创建订单并不自动发腾讯出行券；领取页面内需要用户点击领取。含趣米礼包可能在支付成功后自动派发趣米，不能把不同子权益一概视为待手动领取。

## 4. B 出行券直充

- 收款前仍建议 `purchase-check`。
- `POST /open/v1/prepaid/direct-topup`：`phone`、`refCode`、**必填 `productCode`**、建议稳定 `requestId`。
- 不能包含彩票或趣米；一次调用扣礼包额度并尝试直接向腾讯发券，不返回 `claimUrl`。
- `code=0` 只能说明扣额/建单成功；`allClaimed=true` 才能判断全部成功。
- `allClaimed=false` 表示可能部分失败，**已扣额度**；按文档可以使用**同一 `requestId`** 再调此接口补发，不能随意生成新请求号。单条发券失败厂商内部最多重试 3 次。

实现必须在 DB 记录上游调用摘要和每个 item 的状态；重复调用前检查本地状态与厂商契约，防止误发/误扣。

## 5. C 公众号礼包券

- `POST /open/v1/gift-vouchers`：`refCode`、`packCount`（1–12）、`requestId` 必填；`phone`、`productCode` 可选。
- **签发就预扣** `packCount` 个额度，不等用户领取才扣。
- 可不传手机号，让用户在 H5 首次填写后绑定该券；供应商文档称首次手机号会锁定。
- 返回 `voucherCode`、`claimUrl`、`packTotal`、`packRemaining`、`expiresAt`（约签发 30 天）、`balanceAfter`、`idempotentReplay`。
- `GET /open/v1/gift-vouchers/{code}` 查询/补发链接；签名字段 `code` 使用签发返回的大写兑换码。

**未明确**：过期、未领完、取消签发后的额度是否回退，及多礼包与同手机号 7 天限领规则如何交互。未确认前不能对业务承诺自动退回。

## 6. D 权益商品派发

路径前缀：`/api/open/inrice/v1`，签名**完全不同**：
- Headers：`X-App-Key`、`X-Timestamp`、`X-Signature`，没有 X-Nonce/X-Sign；
- 签名：HMAC-SHA256( `timestamp + "\n" + compactJSON` , AppSecret )，然后 Base64；时间戳按文档秒或毫秒均可；参与 JSON 字段按具体接口定义。

调用流程：
1. `GET /api/open/inrice/v1/products`：可派发商品与 `sellPrice`。
2. `GET /api/open/inrice/v1/products/query`：按需取商品详情。
3. 业务方收款成功或业务授权发放后，`POST /api/open/inrice/v1/dispatch`，主要字段 `partnerOrderNo`（幂等键，最多 64）、`productCode`、`mobile`。
4. `GET /api/open/inrice/v1/orders/query`：查询到 `dispatchStatus` **终态**，卡密/领取说明以 `fulfillmentSummary` 为准。

`code=0` 仅说明建单并提交或幂等回放，**不代表已到账**。`partnerOrderNo` 重复调用不重复扣额。精确终态集（总览仅举例 `RECEIVE`）、错误码和完整派发明细结构仍需厂商细文档。

## 7. 对接层的内部实现约束

- 不暴露 `X-Sign`/`X-Signature`、AppSecret、上游原始手机号、卡密到前端日志。
- A/B 收款前资格查询是独立 API 能力；不要把“能买”缓存当永久资格。
- 每次真实发放都要持久化**业务意图、幂等键、上游订单号、履约状态、最近核实时间**。
- 本地 HTTP 超时不等于上游失败；若无对应可靠查单能力，标记“结果未知待核实”，禁止自动换单重发。
- 统一给下游提供自己的订单状态；必要时附带 `claimUrl` 等明确允许的领取入口，不能传原始敏感凭证。
- 每种模式的签名应有固定测试向量，异常路径覆盖金额余额不足、礼包额度不足、限领、重复单号、部分失败、鉴权失败与响应体 `code != 0`。

## 8. 联调前需取得/确认

- [ ] 厂商完整 A/B/C 细文档、D 细文档和错误码/状态机。
- [x] 测试地址 `https://dev-api.isunpow.com` 已于 2026-10-27 从授权 Mac 终端完成 HTTPS 连通和 D 商品列表只读联调；**生产 Base URL 未核实**。
- [x] 开发凭证在受控的临时签名请求中通过了 D 商品列表鉴权；开发推广编码已由维护者提供。**未**核验 A/B/C 同套签名、额度账户、生产凭证或完整商品目录；凭证本身不存 GitHub。
- [ ] A/B/C 7 天限领的粒度：手机号、商品、活动、多个子分销是否共享。
- [ ] C 的到期/剩余包额度回收策略及 D 的终态/异常恢复策略。
- [ ] 供应商是否提供可靠的余额查询、退款或撤销接口；当前总览**没有**对此作出承诺。
- [ ] 隐私与手机号处理责任边界、发券重试频率/限流和上游事故联络机制。

**文档状态（2026-10-27）**：已根据 2026-10-22 总览整理并入库原始副本。维护者授权的 Mac 终端曾对 D 模式 `GET /api/open/inrice/v1/products` 做真实、带签名的只读开发环境请求：HTTP 200、业务 `code=0`、`message=success`、返回 21 个测试商品。这**只证明 D 列表只读鉴权与读接口在该时刻可用**，不证明 D 详情/派发/查单、A/B/C、余额、测试额度或实际到账成功。详情查询参数、D 完整终态、各模式错误码仍需细文档或受控实测。联调证据不得包含签名、手机号或 Secret。

## 9. D 商品列表只读客户端（BHB-011-A）

- **代码归属**：`packages/provider-yangmao`，server-only；导出 `createYangmaoInriceCatalogClient`、D 签名函数与稳定错误码。没有新增 API 路由、后台页面、数据库表或派发能力。
- **签名**：唯一 D 实现为 `X-Signature = Base64(HMAC-SHA256(appSecret, timestamp + "\n" + 紧凑 JSON))`，列表签名体为 `{}`；请求头只有 `X-App-Key`、`X-Timestamp`、`X-Signature`，不含 `X-Sign`/`X-Nonce`，也不复用 A/B/C 实现。
- **传输边界**：`baseUrl`、`appKey`、`appSecret`、超时、clock 与 transport 均由服务端调用方注入；默认 Node `fetch` 保留系统 TLS 验证，不跟随重定向；远程地址必须 HTTPS（仅 loopback 测试允许 HTTP）；超时默认 10s，限制 100ms–60s。
- **响应判断**：先判 HTTP 2xx，再要求 JSON envelope 的整数 `code`；HTTP 401/403、其它非 2xx、`code != 0`、非法 JSON、形状不符、超时、调用方取消各有稳定错误码，HTTP 200 或 `code=0` 都不会被解释成派发/履约成功。错误信息固定，不复制供应商 `message`、AppSecret 或签名。
- **字段边界**：只解析契约有依据的 `productCode` 与 `sellPrice`。`sellPrice` 是供应商“元”报价，按十进制定点精确转换为整数分；负数、超两位小数、科学计数法、超出安全整数或任何一项字段不符都会使整次读取失败，不做四舍五入或部分成功。展示名称等未确认字段不解析、不补假数据，未知字段丢弃。返回快照带 `provider: "yangmao"`、`currency: "CNY"` 与 `observedAt`。
- **待复测的契约假设**：商品列表位于 `data` 数组这一容器形状来自总览的 `{code,message,data}` envelope 与列表语义；仓库没有 2026-10-27 的完整响应样本，因此这是本卡显式冻结的假设而非已采样事实。首次授权只读复测若发现容器不同，应按合同变更修正并补测试，不能静默兼容多种形状。
- **测试证据**：`packages/provider-yangmao/test/inrice-signature.test.ts` 的固定向量由 OpenSSL 独立计算（命令记录在测试注释中）；成功、鉴权失败、业务失败、HTTP 200 + body `code=500`、非法 JSON、超时、取消、重定向与形状不符分别由注入 transport 和本地 loopback HTTP server 覆盖。**这些是隔离网络的契约测试，不是供应商环境实测**。
- **与 2026-10-27 实测的区别**：当时授权 Mac 的只读请求是一次真实环境先验观察（HTTP 200、`code=0`、21 个商品），仓库没有保存其字段结构、签名或凭证。本卡不重放真实请求、不在 CI 使用真实凭证，也不证明商品详情、查单、派发、A/B/C 或生产地址可用。
- **未接线**：当前没有 Hono 路由、环境变量读取、缓存/落库或后台页面；真实接入需后续卡片单独授权并在服务器侧注入凭证。`vendorFulfillmentEnabled` 仍为 `false`。
