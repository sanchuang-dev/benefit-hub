import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createBrandAssetApp } from './static-assets.js';

/**
 * Prefix the operations console is mounted under. Keep in sync with
 * `apps/admin/src/app/base-path.ts` and the CI runtime smoke checks.
 */
export const ADMIN_BASE_PATH = '/admin';

/**
 * Serves the origin's static surface:
 *
 * - `/brand/*` and `/favicon.ico` — brand files (a missing file is a JSON 404,
 *   never the SPA shell, so the browser cannot cache HTML as an icon).
 * - `/assets/*` — the hashed admin bundle referenced by `index.html`.
 * - `/admin` and `/admin/*` — the admin SPA shell; React Router's basename owns
 *   the client-side routes inside it.
 * - `/` — a temporary 302 to `/admin/`. The origin root is deliberately not the
 *   console homepage; a future public landing page can replace this route
 *   without touching the admin mount.
 * - everything else — a 404. Returning the admin shell for arbitrary paths
 *   would both hide broken URLs and make the root look like part of the console.
 *
 * `publicRoot` holds the admin build output (`index.html`, `assets/`, `brand/`);
 * the Dockerfile copies it to `/app/public`.
 */
export function createStaticApp(publicRoot: string): Hono {
  const app = new Hono();
  const readIndexHtml = () => readFile(resolve(publicRoot, 'index.html'), 'utf8');

  app.route('/', createBrandAssetApp(publicRoot));
  app.use('/assets/*', serveStatic({ root: publicRoot }));

  app.get('/', (c) => {
    // Temporary, and explicitly uncached: the root is reserved for a future
    // page, not an alternative console entry point.
    c.header('Cache-Control', 'no-store');
    return c.redirect(`${ADMIN_BASE_PATH}/`, 302);
  });

  app.get('*', async (c) => {
    const path = c.req.path;
    if (path.startsWith('/api/')) {
      return c.json({ error: 'NOT_FOUND', message: '接口不存在' }, 404);
    }
    if (path === ADMIN_BASE_PATH || path.startsWith(`${ADMIN_BASE_PATH}/`)) {
      // Always revalidate the shell so a deploy cannot leave browsers on an old
      // asset manifest; the hashed chunks themselves stay cacheable.
      c.header('Cache-Control', 'no-cache');
      return c.html(await readIndexHtml());
    }
    return c.json({ error: 'NOT_FOUND', message: '页面不存在' }, 404);
  });

  return app;
}
