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
- **已有的真实响应形状证据（纠正首次代码审查误判）**：2026-10-27 经授权的 Mac 开发环境只读请求，脱敏输出明确为 HTTP 200、`code=0`、`dataType="array"`、`count=21`；前四项观察到 `productCode`、`name`、`sellPrice`（售价示例 2.22 / 2.20 元）。因此成功列表的 **`data` 直接是数组并非臆测**。`inrice-catalog-client.test.ts` 保存了匿名化的 4 项结构回归夹具，**并非原始供应商响应或第二次实测**。尚缺全部 21 项的完整字段、价格边界与真实运行该包的对照证据；未来授权只读复测仍应核对全部项目是否满足严格解析，不能因此宽松兼容任意容器或宣称已真实接线。
- **测试证据**：`packages/provider-yangmao/test/inrice-signature.test.ts` 的固定向量由 OpenSSL 独立计算（命令记录在测试注释中）；成功、鉴权失败、业务失败、HTTP 200 + body `code=500`、非法 JSON、超时、取消、重定向与形状不符分别由注入 transport 和本地 loopback HTTP server 覆盖。**这些是隔离网络的契约测试，不是供应商环境实测**。
- **与 2026-10-27 实测的区别**：当时授权 Mac 的只读请求是一次真实环境先验观察（HTTP 200、`code=0`、21 个商品），仓库此前记录了脱敏的数组结构、前四项字段及测试商品总数，但没有存储完整响应、签名或凭证。本卡不重放真实请求、不在 CI 使用真实凭证，也不证明商品详情、查单、派发、A/B/C 或生产地址可用。
- **未接线**：当前没有 Hono 路由、环境变量读取、缓存/落库或后台页面；现有文档描述的是历史只读实现；现在连接配置已支持管理员加密存库，供应商实际派发链路仍需实现。

## 10. D 商品详情只读客户端（BHB-011-B）

- **已核定的详情契约（2026-10-27 维护者授权开发环境签名只读实测）**：`GET /api/open/inrice/v1/products/query`，唯一 query 参数 `productCode`；签名载荷为紧凑 JSON `{"productCode":"<同一编码>"}`，请求头仍只有 `X-App-Key`、`X-Timestamp`、`X-Signature`。成功时 HTTP 200、body `code=0`、`data` 为**对象**；查询不存在的商品编码时 HTTP 200、body `code=400`（实测消息“趣米商品不存在”）、`data=null`。实测确认出现的字段键含 `productCode`、`id`、`inriceGoodsId`、`name`（string）、`goodsType`、`distributionType`、`settlementType`、`denomination`、`salesPrice`、`sellPrice`（number）、`goodsStatus`（number）、`defaultBatchId`、`picture`、`sketch`、`details`、`extraJson`、`lastSyncTime`（string）；这只确认出现与类型，**不**确认 `goodsStatus` 枚举/可售语义或富文本安全规则。
- **代码归属**：仍只在 `packages/provider-yangmao`。同一 reader 新增 `getProductDetail(productCode, { signal? })`，与列表共用配置校验、超时/取消、不跟随重定向、HTTP 状态与 body `code` 双层判断的签名 GET 管线；签名用 `JSON.stringify({productCode})`，URL query 用 `URLSearchParams` 对**同一原始值**做百分号编码，保证供应商解码值与被签名值一致（含空格/引号等字符的编码回归由测试固定）。入参 `productCode` 先按列表同款规则校验，非法时抛新增稳定错误码 `YANGMAO_INRICE_PRODUCT_CODE_INVALID`，不发送任何请求。
- **字段边界**：只解析有实证的 `productCode`、`name`、`sellPrice`（按整数分精确转换，规则与列表共用）；返回快照含 `provider: "yangmao"`、`currency: "CNY"`、`observedAt`。响应 `productCode` 必须与请求一致，否则整次读取失败。`name` 按不可信供应商文本原样透传（禁止空值、控制字符、超过 256 字符的防御性上限），消费方必须按文本渲染。`goodsStatus` **不**解析、不输出、不映射为 onSale/available 等平台规则；`details`、`extraJson`、`picture`、`sketch` 等未确认字段被 schema 剥离，供应商富文本/HTML 不会进入平台或前端。
- **错误边界**：`code=400` 的“不存在”按合同作为通用业务失败 `YANGMAO_INRICE_BUSINESS_FAILED` 处置，仅保留 `vendorCode=400` 数字供调用方区分，**不**把实测 message“趣米商品不存在”固化为永久内部语义；`code=0` 但 `data` 缺失/null/数组或任一字段不符均为 `YANGMAO_INRICE_RESPONSE_INVALID`；超时、取消、非法 JSON、HTTP 状态映射沿用 011-A 稳定错误码。详情读取从不表达派发/履约成功。
- **测试证据**：`test/inrice-signature.test.ts` 增加详情签名体与 OpenSSL 独立向量；`test/inrice-product-detail.test.ts` 用脱敏虚构 fixture 覆盖成功 object、不存在（200/400/null）、`code!=0`、非法 JSON/空响应体、字段缺失/类型错误/编码回显不符/价格精度、超时、取消与调用方入参边界；`test/inrice-catalog-http.test.ts` 增加 loopback 真实 fetch 的详情签名 GET、重定向不跟随与超时。全部使用固定 fixture 与本地回环地址，**不含真实凭证，也不是供应商环境实测**；维护者的人工探测是本实现的先前证据，不等于本代码已 live 联调。
- **未接线/不变**：无订单查单、`POST /dispatch`、A/B/C、SQLite、Hono 路由、UI 或真实运维配置改动；供应商实际派发链路尚未实现。

## 11. A/B/C 签名与 purchase-check 只读资格查询（BHB-011-C）

- **代码归属**：仅在 `packages/provider-yangmao`，server-only。新增 `open-v1-signature.ts`、`open-v1-errors.ts`、`open-v1-purchase-check.ts`、`open-v1-client.ts`，导出 `createYangmaoOpenV1Client`、A/B/C 签名函数、`purchase-check` 字段构造与稳定错误码。没有新增 API 路由、环境变量读取、缓存/落库、UI 或下单/发券能力。
- **签名（`X-Sign`）**：唯一 A/B/C 实现为“显式参加字段的非空值按字段名升序拼成 `k=v&...`，追加 `&appSecret=<AppSecret>`，SHA-256 **大写 hex**”。字段集按端点常量为准：`purchase-check` 只有 `appKey`、`timestamp`、`nonce`、`phone`；**不**从 HTTP JSON body 遍历推导签名字段。整数按十进制定点字符串化，字符串按 UTF-8 原字节参与（不 trim、不 URL 编码）；保留字段名（`appSecret`/`sign`/`signature`）与非法数值直接拒绝。`X-Timestamp` 为毫秒且与被签名值完全一致，`X-Nonce` 每次调用重新生成（默认 16 字节随机 hex），非法 nonce 在发送前失败。D 的 `X-Signature`（HMAC-SHA256 → Base64）保持独立，两者不互相复用。
- **请求边界**：默认 `fetch`，`POST /open/v1/prepaid/purchase-check`，body 仅 `{"phone":"..."}`；手机号只出现在签名与 JSON body，不进 URL、请求头、错误或日志；不跟随重定向；远程地址必须 HTTPS（仅 loopback 测试允许 HTTP），超时默认 10s、限制 100ms–60s；注入的 transport/clock/nonceFactory 仅供服务端调用方与测试使用。
- **资格语义**：`purchaseRestricted`、`giftUnclaimed`、`lotteryUnbet` 三个布尔事实独立表达，不压成单一状态枚举。`purchaseRestricted=true` 表示供应商 7 天限领生效，平台**不得收款或下单**；`giftUnclaimed`/`lotteryUnbet` 表示仍有未领权益，调用方把 `claimUrl` 交回用户继续领取。三者均 false 只代表**本次查询时刻**可继续，客户端不做任何缓存，也不把通过写成永久可购买；同手机号 7 天限领的作用范围仍未确认，不由本适配层猜测。查询本身不产生任何礼包或金额扣减，也不返回 `orderNo`/`balanceAfter` 等副作用字段。
- **响应边界**：依次判断 HTTP 状态、JSON 解析、envelope 整数 `code`，**先检查 body `code` 再读取任何资格字段**。`code=0` 后 `data` 必须是对象且三个布尔字段齐全；缺失/类型错误、`data` 缺失/null/数组、伪 200 HTML、超时、取消均为稳定错误。可选 `message`（≤256 字符、禁止控制字符）与 `claimUrl`（≤2048、仅 http(s)、禁止内嵌凭证）按不可信供应商文本原样透传，缺失或 `null` 视为未提供，消费方必须按文本渲染并自行校验；未确认字段被 schema 剥离，envelope 的 `message` 不会被冒充为资格说明。
- **错误边界**：`YANGMAO_OPEN_V1_*` 与 D 的 `YANGMAO_INRICE_*` 分离；HTTP 401/403、其它非 2xx、body `code != 0`、非法响应、超时、取消、网络失败各有固定错误码，错误消息不复制供应商 message、手机号、AppSecret 或签名，`vendorCode`/`httpStatus` 仅保留数字。
- **测试证据**：`test/open-v1-signature.test.ts` 用 OpenSSL 独立计算的固定向量覆盖 canonical 串、64 位大写 hex、排序、空值跳过、整数与 UTF-8 字节、保留字段拒绝；`test/open-v1-purchase-client.test.ts` 用注入 transport 覆盖请求头/body、三类资格事实、`code` 优先、业务失败、伪 200/缺字段/非法 `claimUrl`、超时、取消、手机号本地校验、nonce 唯一性与配置边界；`test/open-v1-http.test.ts` 用本地 loopback server 覆盖默认 `fetch` 的签名 POST、超时与不跟随重定向。全部为隔离夹具，**不是供应商环境实测**，也未在 CI 使用真实凭证或手机号。
- **未接线/不变**：不做 A 下单、B 直充、C 签发/查询、D 改动、支付、订单 schema、SQLite、Hono 路由、UI 或部署变更；供应商真实派发由后续履约实现承接；`purchase-check` 联调需要有效测试资格与可核实的响应证据。

## 12. 只读供应商商品运营入口（BHB-013-A）

- **同源接口**：`GET /api/v1/catalog/supplier-products`（列表）与 `GET /api/v1/catalog/supplier-products/:productCode`（单品详情）。两者都要求有效登录会话，只转接 D 只读 Adapter，固定使用服务器配置的受控 origin，不接受浏览器传入 URL/Host；不派发、不导入 SQLite、不修改映射或订单。
- **公开字段**：浏览器可见字段仅 `provider`、`currency`、`observedAt`、`productCode`、`sellPriceCents`；详情额外返回经适配器校验的 `name`。供应商原始 `details`/`extraJson`/`goodsStatus`、手机号、签名和 AppKey/AppSecret 不进入响应、日志或浏览器包。
- **服务器配置**：仅使用 `YANGMAO_INRICE_BASE_URL`、`YANGMAO_INRICE_APP_KEY`、`YANGMAO_INRICE_APP_SECRET`，三项必须同时存在且只由服务端读取。缺失或不完整时接口返回 503 `SUPPLIER_NOT_CONFIGURED`，不会改用开发默认值、空列表或假数据。实际环境的凭证管理与供应商地址以当前部署配置和有效 API 合同为准。
- **失败语义**：鉴权/HTTP/业务失败返回 502，超时返回 504，未配置返回 503；任何失败都不会被显示成“供应商目录为空”。只有供应商真实返回空数组时才是 200 空列表。
- **前端边界**：商品管理「供应商商品」Tab 以 Ant Design Table/Card 只读展示供货方（上力）、上游编码、报价和获取时间；名称在选中单品时按需读取，不做整页详情 N+1；可用状态显示“待核实”，不根据 `goodsStatus` 猜测可售。不以静态开关冒充供应商履约能力状态。

## 13. A 预充值下单与领取链接恢复（BHB-012-C）

- **代码归属**：供应商协议仍在 `packages/provider-yangmao`；新增 `createPrepaidOrder()`，`POST /open/v1/prepaid/orders`，签名字段严格为 `appKey`、`timestamp`、`nonce`、`phone`、`refCode`、非空 `productCode`、`requestId`，仍使用 A/B/C `X-Sign`（SHA-256 大写 hex），**不使用** D `X-Signature`。成功响应必须同时具备 `orderNo` 与合法 `claimUrl`；`balanceAfter`、`idempotentReplay` 仅在类型合法时保留，未知字段丢弃。`code=0` 但字段缺失/非法、超时、取消、传输失败都抛稳定错误，绝不表达“已领取/已完成”。
- **平台接线**：`apps/api/src/modules/orders/a-prepaid-grant.ts` 复用既有订单 Repository、冻结映射、应用白名单和服务凭证；新增 `POST /api/v1/business/orders/:orderId/grant` 与 `POST /api/v1/business/orders/:orderId/recover`。下单前先执行只读 `purchase-check`，`purchaseRestricted`/`giftUnclaimed`/`lotteryUnbet` 任一为真即拒绝且不落下单记录。`requestId` 由平台订单 ID 确定性派生并在数据库唯一；下单记录、预发 `unknown` 尝试与订单 `processing` 状态在同一短事务持久化，签名 HTTP 调用在事务之外。
- **结果语义**：上力受理后订单为 `awaiting_claim`，`claimUrl` 只在已认证响应中返回、不落库；用户仍需在供应商 H5 领取，因此绝不记为 `completed`。超时/5xx/畸形成功保持 `unknown`；重复调用只用同一 `requestId` 走 `orders/query`，不重发扣额；上力明确业务拒绝记为 `rejected`/`failed`，不再自动重试。
- **数据边界**：不保存明文手机号，只保存主密钥 HMAC 摘要（拒绝冲突的重复输入）；不保存 claimUrl、供应商原始报文、密钥或签名。运营在既有订单详情看到 requestId/上游订单号/状态，使用既有管理员只读查询取回链接。
- **证据边界**：provider 单测使用 OpenSSL 独立向量与虚构 transport；API 集成测试通过真实 Hono → loopback 假供应商 HTTP 服务覆盖真实签名、冻结映射、并发唯一预约、未知/恢复与拒绝路径。**未执行任何真实 A 扣额**；真实下单、真实 claimUrl 与平台状态仍需维护者单独批准、测试额度与收件手机号后的脱敏证据。
