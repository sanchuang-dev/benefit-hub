# 羊毛系统 · Open API 接入契约摘要

> 对接依据：用户提供的《开放接口（Open API）接入对接文档》，版本 **2026-10-22**。本文件是我们工程使用的**摘要和待核实清单**，不是厂商文档原文副本。
>
> 厂商总览引用了《权益包预充值模式接口对接文档》《上力权益OpenAPI接口对接文档》《apifox-open-api-debug》三份更细资料；**目前仓库未获得这些文件的完整内容**。缺失的状态码/错误字段不能猜测。
>
> 不向三创公开仓库提交合作方密钥、真实手机号、卡密或敏感完整原始文档。

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
- [ ] 实际测试 Base URL（总览中的 dev-api 地址仅为示例）、生产 Base URL。
- [ ] AppKey/AppSecret、子分销 refCode、商品 productCode、对应测试额度；均通过秘密配置，不提交公开仓库。
- [ ] A/B/C 7 天限领的粒度：手机号、商品、活动、多个子分销是否共享。
- [ ] C 的到期/剩余包额度回收策略及 D 的终态/异常恢复策略。
- [ ] 供应商是否提供可靠的余额查询、退款或撤销接口；当前总览**没有**对此作出承诺。
- [ ] 隐私与手机号处理责任边界、发券重试频率/限流和上游事故联络机制。

**文档状态**：已根据 2026-10-22 总览整理；尚未调用任何真实厂商 API，不能视为联调验收。 
