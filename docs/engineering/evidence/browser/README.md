# Browser evidence

## BHB-013-B1

Captured 2026-10-28 on the Worker runner with headless Chromium 155 (CDP), the
built admin bundle served by the real Hono app, and a temporary SQLite file.

- Fixtures are entirely fictional local test data (fixture products, orders and
  supplier mapping codes). No production record, real account, provider
  credential or supplied token was used.
- Viewports: 1366×900 and 390×844 (deviceScaleFactor 1).
- Flow: login → `/fulfillment` list → open the order created before its product
  mapping was rotated → switch to the narrow viewport → close the drawer.

The detail screenshot shows the order's frozen mapping snapshot
(`YM-TRAVEL-B`, mapping v1) even though the product's current mapping had
already been rotated to a new version, and it shows the local
"平台暂无供应商调用记录" absence notice rather than fabricating a supplier result.

Observed browser results: list `共 3 条` with 3 real API rows; detail drawer
680px wide at 1366 and full 390px at narrow width; no JavaScript exceptions; the
only console/network error was the expected 401 on `/api/v1/auth/session` before
login. A same-origin API probe returned `200`, `cache-control: no-store`,
`total: 3`. These screenshots prove the rendered UI states only; they are not
supplier fulfillment, staging or production acceptance.

## BHB-014-B (downstream application machine credential + runtime authorization)

Captured 2026-10-28 (UTC) on the Worker runner with headless Chromium 156 (CDP)
against the built `benefit-hub:bhb014b` image: real Hono app, compiled admin
assets and a temporary SQLite volume. Files are `bhb-014-b-*.png`.

- Fixtures are fictional: application `container-app` / `容器验证应用`, internal
  product `CT-P-1` and a local D-mode mapping. No production record, real
  account or provider credential is present; no supplier request was made.
- Viewports: 1366×900 and 390×844 (deviceScaleFactor 1).
- Flow: unauthenticated login screen → log in as admin → real application list
  and edit drawer → issue a credential → one-time secret modal → active state in
  drawer and list (`已生效 · 1 个有效凭证`) → revoke (`已撤销`, list back to
  `未签发有效凭证`) → filtered empty state → forced list-load failure with retry
  → 390px list and full-width drawer → logout and log in again → viewer
  read-only drawer.
- The one-time secret modal screenshot is deliberately masked
  (`••••••` + a note); no raw bearer token was read, logged or written into
  evidence. The same container run verified by HTTP that the issued secret
  creates a `pending` order (201), replays (200), a non-allowlisted product is
  `403 PRODUCT_NOT_AUTHORIZED`, a disabled application is `403
  APPLICATION_DISABLED`, and a revoked credential is `401 UNAUTHORIZED`; SQLite
  contained only a 64-hex SHA-256 digest and no plaintext secret.
- Observed browser results: no JavaScript exceptions and zero `console.error`
  entries across the full flow; narrow `document.documentElement.scrollWidth` is
  390 at a 390px viewport (no horizontal overflow); the viewer drawer renders
  only `关闭` and disabled fields, with no issue/revoke/save controls.
- These screenshots prove the rendered UI states only. They are not Issue
  acceptance, staging/production deployment, or real supplier fulfillment.

## 运营控制台挂载到 /admin（2026-10-31）

路由前缀变更是纯路由行为，界面没有视觉变化，因此这里不新增截图，证据是
HTTP 响应与浏览器导航结果。被测对象：`pnpm build` 之后的 `apps/admin/dist/`
交给 `createStaticApp()`（与容器内 `public/` 同构）在 127.0.0.1:4099 运行，
以及本地 Vite dev server（:4081）+ API（:4080）。

| 请求 | 结果 |
| --- | --- |
| `GET /` | `302`，`location: /admin/`，`cache-control: no-store`（根路径是临时跳转，不是后台首页） |
| `GET /admin`、`GET /admin/` | `200`，`text/html`，`cache-control: no-cache`，标题 `3C Benefit Hub · 三创权益服务` |
| `GET /admin/catalog` | `200`，同一份 SPA shell（React Router basename 负责客户端路由） |
| `GET /admin/settings/runtime` | `200`，同一份 SPA shell |
| `GET /assets/index-*.js` | `200`，`text/javascript`（构建产物仍在源站根路径） |
| `GET /brand/favicon.ico` | `200`，`image/x-icon`（品牌资源仍在源站根路径） |
| `GET /catalog`、`/login`、`/suppliers/yangmao` | `404`，JSON `{"error":"NOT_FOUND","message":"页面不存在"}`，不再回落到后台 shell |
| `GET /api/v1/unknown` | `404`，JSON `{"error":"NOT_FOUND","message":"接口不存在"}`（保持原 API 404 形状） |

浏览器（headless Chrome 156，CDP，1366×900，登录 admin 账号）：

- `GET /` 跟随 302 后 `location.pathname === "/admin/"`，渲染总览；地址栏即
  `/admin/`，根路径本身不再渲染后台首页。
- 直接打开 `/admin/catalog` 渲染权益商品，顶部工作页签选中「权益商品」；
  侧栏点击业务订单后 `location.pathname === "/admin/fulfillment"`；点击工作
  页签「总览」回到 `/admin`。
- 变更前写入 `sessionStorage` 的工作页签（总览、权益商品、供应商管理、平台
  状态、操作审计）在 `/admin/` 下原样恢复：路由键没有加前缀，所以不需要迁移
  持久化数据。
- 旧地址 `/catalog` 在 dev 也返回 `404 页面不存在`（Vite 中间件与生产边界对齐），
  浏览器控制台没有 Router basename 警告或其它 error/warning。
- 该证据只覆盖路由挂载与 HTTP 边界，不代表新的视觉设计，也不替代真实部署验收；
  `site.webmanifest` 的 `start_url: "/"` 按品牌文档保持原样，安装后的 PWA 会跟随
  根路径 302。

## DPN-003 权益商品页迁移 DataPanel（2026-10-31）

Captured on the Worker runner with headless Chromium 156 (CDP), the Vite dev
server for `apps/admin`, the real Hono API and a temporary SQLite file. A Noto
Sans CJK font was installed locally so the screenshots render Chinese labels;
the font is runner-only and not part of the repository.

- Fixtures are fictional local test data: products `TRAVEL-10` / `COFFEE-1` /
  `MOVIE-5`, an active Yangmao D mapping (`YM-TRAVEL-10`, v1), a draft-only B
  mapping (`YM-COFFEE-1`) and one product without a mapping. The supplier facet
  reports `configured: false`, so every screenshot correctly shows `未配置`
  instead of a fabricated ready state.
- Viewports: 1366×900 and 390×844 (deviceScaleFactor 1).
- Flow: open `/admin/catalog` → expand 高级检索 → filter keyword `咖啡` →
  浏览器后退/前进 → 重置 → click 展示价 header (server sort) → switch to
  卡片 → narrow to 390px → switch to 表格 → open 列设置 and hide/restore
  映射状态 → filter keyword `不存在的商品` for the empty state.
- Observed: keyword filter changes the URL to `?q=%E5%92%96%E5%95%A1` and the
  browser back/forward replay the unfiltered and filtered states; sorting writes
  `?sortBy=displayPriceCents&sortOrder=asc`, the header reports `aria-sort`
  `ascending`, and the rows arrive in server price order (500 / 1000 / 1250).
  Card and table both render the same three rows. `documentElement.scrollWidth`
  equals `innerWidth` at both 1366 (1366) and 390 (390) in card, table and empty
  states. Hiding an optional column removes its header while required columns
  remain; restoring it brings the header back. No JavaScript exception or
  `console.error` was recorded.
- Files: `dpn-003-catalog-table-1366.png`,
  `dpn-003-catalog-filtered-1366.png`, `dpn-003-catalog-card-1366.png`,
  `dpn-003-catalog-card-390.png`, `dpn-003-catalog-table-390.png`,
  `dpn-003-catalog-columns-1366.png`, `dpn-003-catalog-empty-1366.png`,
  `dpn-003-catalog-empty-390.png`.
- These screenshots prove the rendered UI states only. Error and first-load
  states are covered by the jsdom route tests, not by these screenshots, and
  this is not Issue acceptance, deployment or real supplier fulfillment.
