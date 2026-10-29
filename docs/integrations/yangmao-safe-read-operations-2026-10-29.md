# 上力 A/B/C 已知只读接口接线（PR #66，待验收）

> **2026-10-29 补充**：A 模式下单与领取链接恢复已由 **BHB-012-C** 单独实施，新增 `POST /api/v1/business/orders/:orderId/grant|recover` 与独立下单记录表；本文件的只读接口结论、权限和证据边界不受影响。两者不是同一次真实扣额验收。

本文件记录**代码交付位置和未证实边界**，不能冒充测试环境真实联通证据。

## 接入范围

| 上游路径 | 已知签名字段 | 中台管理操作 | 尚待实测 |
| --- | --- | --- | --- |
| `POST /open/v1/prepaid/purchase-check` | appKey/timestamp/nonce/phone | `POST /api/v1/suppliers/yangmao/purchase-check` | 实际可用测试手机号、七天限领的适用范围 |
| `POST /open/v1/prepaid/orders/query` | appKey/timestamp/nonce/requestId | `POST /api/v1/suppliers/yangmao/prepaid/orders/query` | 真实响应里 claimUrl / claimable / orderNo 的存在、类型及是否嵌套 |
| `GET /open/v1/gift-vouchers/{code}` | appKey/timestamp/nonce/code | `POST /api/v1/suppliers/yangmao/gift-vouchers/query` | 真实响应里的券状态及到期时间格式、字段层级 |

服务器从现有上力凭证配置读取 Key/Secret，执行 A/B/C `X-Sign`，不复用 D `X-Signature`。运营入口仅对 admin 开放，接受后台 Cookie、CSRF 后才会调用；使用 POST 防止手机号/券码写进中台浏览器 URL。本次不额外保存查询结果。

**已知字段按类型验证，缺失显示「未提供」；尚未确认的字段直接剥离，不补假数据。** 仅对合同有根据的字段做展示：A/B 资格标记及说明/链接；A 订单号、是否可领取、领取链接；C 份数、剩余、领取链接、原样到期值（时间单位未证实）。如果整条响应没有任何已知字段，返回 `SUPPLIER_RESPONSE_UNVERIFIED`，而不是当作成功。HTTP/业务码保持来源区分。

## 未接入及安全限制

- 本 PR 不包括 A 下单、B 直充、C 签发、D 派发，也不执行真实扣额调用。代码验证不等于真实环境成功联调。
- D 查单 `GET /api/open/inrice/v1/orders/query` 缺供应商确认的 query key 和签名 JSON；已有猜测负例，不能拿假参数伪装已接。
- 开发后台登录与 Open API 服务端签名是不同身份；不能用前者代替 AppKey/Secret。
- 若服务端尚未将供应商凭证加密保存（或缺少加密主密钥），查询应显示配置缺失，不会从聊天、CI、源码回退读取明文密钥。
- `expiresAt` 的数字单位或字符串格式未证实；仅保留有限长原值，不用于到期运算。
- 审查、真实授权环境联调和 dev 部署分别取证，不能由单一 CI 绿灯推断。

原始依据：`docs/integrations/open-api-2026-10-22.md`、`docs/integrations/yangmao.md`。
