# 品牌资产 · 三创 SANCHUANG

> 运营后台（`apps/admin`）只使用一套品牌资源：**三创 SANCHUANG**。本文件说明它们放在哪里、为什么放在那里、每个文件用在哪里，以及替换资产时必须遵守的规则。视觉规范的总入口仍是根目录 [design.md](../../design.md)，本文件只负责“资产文件”这一层。

## 1. 唯一位置

```text
apps/admin/public/brand/     ← 品牌资产的唯一来源（17 个文件，约 835 KB）
  favicon.ico
  favicon-16x16.png … favicon-96x96.png
  apple-touch-icon.png
  icon-192.png / icon-512.png / icon-maskable-512.png
  site.webmanifest
  logo-icon-512.png
  logo-horizontal-360.png / logo-horizontal-720.png
  logo-horizontal-white-360.png / logo-horizontal-white-720.png
  logo-monochrome-vertical-240.png
  og-image.png
```

放在 `apps/admin/public/brand/` 而不是 `src/assets/`，原因是这三类引用方的要求不同：

1. **`index.html` 与浏览器约定**：favicon、apple-touch-icon、manifest 必须在**构建前**就以稳定、非哈希的 URL 存在，Vite 的 `src/assets` 会改成带 hash 的文件名，不适合。
2. **React 组件**：侧栏图形标、登录封面横标用固定路径 `/brand/...` 引用，打包后与 HTML 引用同一份文件，不会出现两份副本。
3. **部署方式**：Vite `publicDir`（默认 `public/`）把内容原样复制到 `dist/` 根目录，Dockerfile 再把 `apps/admin/dist/.` 复制到镜像的 `public/`，因此容器内路径就是 `public/brand/...`。

服务端（`apps/api/src/index.ts`、`apps/api/src/static-app.ts` 与 `apps/api/src/static-assets.ts`）为此挂载了品牌静态子应用，位置在后台 SPA 路由**之前**。后台 shell 只对 `/admin`、`/admin/*` 回落；品牌文件与 `/assets` 仍由源站根路径提供：

| 路由 | 作用 |
| --- | --- |
| `app.use('/brand/*', serveStatic(...))` | 以 `image/x-icon`、`application/manifest+json` 等正确 MIME 返回品牌文件 |
| `app.get('/brand/*', …404)` | 文件缺失时返回 `{"error":"NOT_FOUND"}` 的 **JSON 404**，**不会回落到 `index.html`**（否则浏览器会把 HTML 当图标缓存下来，很难排查）；`/brand/` 也不提供目录列表 |
| `app.get('/favicon.ico', …)` | 书签页或外部工具仍会探测根路径，直接给同一个图标；文件缺失时同样只回 404 |

开发期不走 API：`pnpm dev:admin` 的 Vite dev server 直接以 `/brand/...` 提供这些文件。

## 2. 来源与追溯

| 项 | 值 |
| --- | --- |
| 品牌 | 三创 SANCHUANG（创新 · 成长 · 未来） |
| 交付包 | `sanchuang-web.zip`，2026-10-27 收到 |
| 交付包 SHA-256 | `905a2de0b9a5cc1f47909946cba33d8de2f713f2660dd52c9e7f45fec69afeff` |
| 内容类型 | 品牌方交付的 **web 成品图**（PNG / ICO / 清单 JSON） |
| 不包含 | AI / PSD / SVG 设计源文件 |

仓库里只放“可直接上网使用”的成品图，不放源文件或导出中间件。若需要改图形、改字距、改配色，**回到品牌方设计源修改后重新导出同名文件**，不要在仓库里重绘或手改 PNG。

**2026-10-29 favicon 透明底修正**：品牌交付的 favicon 是一张白底方图，在深色浏览器标签栏里显示为白方块。维护者要求去掉白底，因此 `favicon.ico` 与 `favicon-16/32/48/96x*.png` 已重新导出为透明底：图形仍是交付包里的同一个图形标（与 `logo-icon-512.png` 同源，蓝色 `#0071FD`），只把白色背景改为透明，未改色、未重绘、未拉伸。`apple-touch-icon`、`icon-192/512`、`icon-maskable-512` 保持交付原样的不透明底（iOS/Android 安装图标需要实底）。若品牌方后续提供带设计源的透明底 favicon，直接用同名文件替换即可。

`site.webmanifest` 里的名称、主题色（`#17212B`）与图标路径保持交付原样：它是品牌套件的一部分。后台是 `noindex` 的运营工具，不需要另做一套安装身份；将来若要为控制台单独定制 PWA 名称，应新建一份 manifest 而不是改这一份。

## 3. 资产清单与用途

| 文件 | 尺寸 | 体积 | 用途 | 当前引用位置 |
| --- | --- | --- | --- | --- |
| `favicon.ico` | 16/32/48 多尺寸 | 4 KB | 浏览器标签页图标（**透明底**，含根路径 `/favicon.ico` 探测） | `index.html`、API 别名路由 |
| `favicon-16x16.png` | 16×16 | 0.5 KB | 高密度屏标签页图标（透明底） | `index.html` |
| `favicon-32x32.png` | 32×32 | 1.3 KB | 标签页图标（透明底） | `index.html` |
| `favicon-48x48.png` | 48×48 | 2.3 KB | 备用（部分 Windows/书签场景，透明底） | 暂未引用 |
| `favicon-96x96.png` | 96×96 | 6 KB | 备用（旧版快捷方式，透明底） | 暂未引用 |
| `apple-touch-icon.png` | 180×180 | 19 KB | iOS 添加到主屏 | `index.html` |
| `icon-192.png` | 192×192 | 27 KB | PWA 图标 | `site.webmanifest` |
| `icon-512.png` | 512×512 | 138 KB | PWA 图标（安装/启动画面） | `site.webmanifest` |
| `icon-maskable-512.png` | 512×512 | 95 KB | Android 自适应图标 | `site.webmanifest` |
| `site.webmanifest` | — | <1 KB | PWA 名称/主题色/图标清单 | `index.html` |
| `logo-icon-512.png` | 512×512 | 169 KB | 图形标（透明底，蓝色标识） | 侧栏品牌区，26×26 |
| `logo-horizontal-360.png` | 360×159 | 35 KB | 深色文字横版组合标，浅色底 | 暂未引用 |
| `logo-horizontal-720.png` | 720×319 | 103 KB | 同上，2x 源 | 暂未引用 |
| `logo-horizontal-white-360.png` | 360×159 | 28 KB | 白色组合标，深色/品牌蓝底 | 登录封面，显示宽 180px |
| `logo-horizontal-white-720.png` | 720×319 | 81 KB | 同上，2x 源 | 登录封面 `srcSet` 2x |
| `logo-monochrome-vertical-240.png` | 156×240 | 26 KB | 单色竖版，印刷/单色场景 | 暂未引用 |
| `og-image.png` | 1200×630 | 100 KB | 社交分享卡 | 暂未引用（后台 `noindex`） |

“暂未引用”是有意保留的：这些都是品牌方交付的正式变体，删掉会导致下一次需要时又要重新找设计。**任何文件都不要在仓库外另存一份副本**；其他站点（例如 `sanchuang-dev/proto-infra` 的公开站点）需要时整包复制过去并保留文件名，而不是跨仓引用相对路径。

## 4. 使用规则

- **按底色选变体**：白色/浅灰底用深色横标或图形标；品牌蓝（`#2563EB`）或深色底只能用 `white` 版，深色文字版在蓝底上会看不清。
- **最小尺寸**：图形标不小于 24px；横版组合标显示宽度不小于 120px。低于该尺寸改用图形标，不要缩小组合标硬塞。
- **留白**：图形四周留白不小于图形标高度的 1/4；不要贴边或压在分隔线上。
- **禁止改造**：不改色、不拉伸、不加阴影/描边/渐变、不裁切、不自行重排图形与文字。需要新形态就回设计源导新文件。**唯一例外**是 2026-10-29 的 favicon 去白底（只改背景透明度，图形与颜色不变），见第 2 节。
- **不做装饰**：品牌图形不放进表格、状态标签、按钮、空状态里当装饰图；`design.md` §1 的“不过度装饰”优先。
- **品牌层固定**：界面品牌层始终是 3C Benefit Hub / 三创权益服务；品牌图形不能替代工作区标题，也不随供应商身份变化（见 `design.md` §4A）。产品字标由品牌图形标与文字字标组成，字标排版规则见 `design.md` §2A，不为此另造图形文件。

## 5. 替换与新增流程

1. 用同名、同用途、同尺寸的文件替换 `apps/admin/public/brand/` 中的文件（2x 源必须与 1x 同版导出）。
2. 如果图标集合或文件清单变化，同步更新 `site.webmanifest`。
3. 更新本文件第 3 节的清单（尺寸、体积、引用位置）。
4. 构建并自查：`pnpm --filter @sanchuang-dev/benefit-admin build`，确认 `apps/admin/dist/brand/` 下有全部文件。
5. 运行 `pnpm check` 或至少 `pnpm --filter @sanchuang-dev/benefit-admin test`、`pnpm lint`。
6. 同名文件路径会被浏览器长期缓存（`favicon.ico`、`site.webmanifest` 尤其明显）。替换后先强制刷新/清缓存验证；如果确实需要让线上立即失效，在 `index.html` 的引用上加 `?v=<日期>` 并同步本表，不要靠改文件名绕过固定路径约定。
7. 新增资产要同时满足：确实是上网页需要、体积合理（单个 PNG 建议 < 200 KB）、有明确引用位置或明确说明用途。

不要提交未压缩的设计稿、超大原图或品牌方压缩包本身；本仓库只保存最终 web 资产。

## 6. 验证方法

```bash
# 1) 构建后确认资产被复制
pnpm --filter @sanchuang-dev/benefit-admin build
ls apps/admin/dist/brand/            # 应有 17 个文件
#    favicon 必须是透明底：四角 alpha=0；在深色标签栏强刷时不应出现白方块

# 2) 静态路由回归测试（MIME、404、HEAD、SPA 兜底）
pnpm --filter @sanchuang-dev/benefit-api test static-assets

# 3) 容器同构验证（apps/api/dist 的 public/ 即 admin 构建产物）
#    - 启动后检查：/brand/* 返回正确 MIME；缺失文件 404；根路径 favicon 可用
curl -I http://127.0.0.1:3000/brand/favicon.ico        # image/x-icon
curl -I http://127.0.0.1:3000/brand/site.webmanifest   # application/manifest+json
curl -I http://127.0.0.1:3000/brand/icon-192.png       # image/png
curl -I http://127.0.0.1:3000/favicon.ico              # image/x-icon（别名）
curl -I http://127.0.0.1:3000/brand/missing.png        # 404，不是 text/html
```

## 7. 边界

- `apps/api` 对 `/assets/*` 缺失文件仍会回落到 SPA HTML，这是本次改动前的既有行为，本次未改变；品牌资产用 `/brand/*` 的 JSON 404 策略。若将来要统一，复用 `createBrandAssetApp` 的写法即可。
- 本目录只服务 `apps/admin` 运营后台。公开站点属于 `sanchuang-dev/proto-infra` 的独立静态部署策略，**不要**为此改动它的 Caddy 配置或把品牌文件塞进 API 的其它路由。
- 品牌资源是品牌方所有，不是 OSS 许可证资产；对外分发前确认使用场景。
