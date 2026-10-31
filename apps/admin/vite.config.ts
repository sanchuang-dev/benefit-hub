import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The production app serves the console under `/admin` (React Router basename).
 * Vite's dev server still answers the origin root with `index.html`, which would
 * boot the router outside its basename and render nothing. Mirror the deployment
 * redirect in dev so `/` → `/admin/`; SPA fallback for `/admin/*` already works.
 */
function redirectRootToAdmin(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.url !== '/' && req.url !== '' && req.url !== '/index.html') return false;
  res.statusCode = 302;
  res.setHeader('Location', '/admin/');
  res.end('Found');
  return true;
}

/**
 * Production 404s every non-API path outside `/admin` instead of serving the
 * shell. Vite's dev SPA fallback would still answer e.g. `/catalog` with
 * `index.html`, which leaves a blank page and a Router warning; mirror the
 * production boundary for HTML navigations. Module/style/asset requests are not
 * `text/html` and pass through untouched.
 */
function rejectHtmlOutsideAdmin(req: IncomingMessage, res: ServerResponse): boolean {
  if (!(req.headers.accept ?? '').includes('text/html')) return false;
  const pathname = (req.url ?? '').split('?')[0] ?? '';
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return false;
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<!doctype html><title>404</title><p>页面不存在</p>');
  return true;
}

function adminBaseRedirect(): Plugin {
  return {
    name: 'benefit-admin-base-redirect',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!redirectRootToAdmin(req, res) && !rejectHtmlOutsideAdmin(req, res)) next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!redirectRootToAdmin(req, res) && !rejectHtmlOutsideAdmin(req, res)) next();
      });
    },
  };
}

// The dev server only replaces the browser-facing origin; the API stays the same
// Hono app it is in production. `changeOrigin` must stay off: the CSRF
// middleware compares the browser `Origin` header with `Host`, so rewriting the
// host would reject every write request.
const apiTarget = process.env.BENEFIT_API_ORIGIN ?? 'http://127.0.0.1:4080';

export default defineConfig({
  plugins: [react(), adminBaseRedirect()],
  server: {
    port: 4081,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget },
      '/healthz': { target: apiTarget },
    },
  },
  test: {
    // These tests render the real antd/React tree in jsdom: one page journey
    // takes seconds alone and several times longer while Vitest runs the 19
    // files in parallel. The 5 s default therefore failed only with load, not
    // with a wrong assertion. Keep a per-test ceiling with real headroom for a
    // slow CI runner, and cap concurrency so one file cannot starve the rest.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    maxWorkers: 4,
  },
});
