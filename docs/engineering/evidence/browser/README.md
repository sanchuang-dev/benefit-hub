# BHB-013-B1 browser evidence

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
