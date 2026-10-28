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
