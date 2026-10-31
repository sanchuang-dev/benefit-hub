import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';

/**
 * Serves the brand assets that `apps/admin` publishes through its Vite
 * `publicDir` (`apps/admin/public/brand/`).
 *
 * They are mounted as a sub-app because they must answer *before* the SPA
 * catch-all in `index.ts`: a missing icon has to be a 404, not `index.html`,
 * otherwise the browser caches the HTML shell under the icon URL and the tab
 * stays broken for the rest of the session.
 *
 * `publicRoot` is the container path that holds `index.html`, `assets/` and
 * `brand/` (the admin build output, copied to `/app/public` by the Dockerfile).
 * The inventory and usage rules live in docs/brand/README.md.
 */
export function createBrandAssetApp(publicRoot: string): Hono {
  const app = new Hono();

  app.use('/brand/*', serveStatic({ root: publicRoot }));
  app.get('/brand/*', (c) => c.json({ error: 'NOT_FOUND', message: '品牌资源不存在' }, 404));

  // Browsers, bookmark bars and link checkers still probe the legacy root path
  // even when `index.html` declares an icon, so answer it with the same file. A
  // missing file stays a 404 instead of borrowing the SPA shell.
  app.get(
    '/favicon.ico',
    serveStatic({ root: publicRoot, path: './brand/favicon.ico' }),
    (c) => c.body(null, 404),
  );

  return app;
}
