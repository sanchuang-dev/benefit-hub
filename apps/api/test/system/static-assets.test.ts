import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrandAssetApp } from '../../src/static-assets.js';
import { createStaticApp } from '../../src/static-app.js';

/**
 * The brand assets are plain files copied by the admin build, so these tests use
 * a fixture directory shaped like the container's `public/` instead of the real
 * Vite output (which is git-ignored and only exists after `pnpm build`).
 */
let publicRoot: string;

const ICO_BYTES = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01]);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JS_BYTES = Buffer.from('console.log("admin bundle");', 'utf8');
const INDEX_HTML =
  '<!doctype html><html><head><title>Benefit Hub</title></head>' +
  '<body><div id="root"></div></body></html>';

beforeAll(async () => {
  publicRoot = await mkdtemp(join(tmpdir(), 'benefit-brand-'));
  await mkdir(join(publicRoot, 'brand'), { recursive: true });
  await writeFile(join(publicRoot, 'brand', 'favicon.ico'), ICO_BYTES);
  await writeFile(join(publicRoot, 'brand', 'icon-192.png'), PNG_BYTES);
  await writeFile(
    join(publicRoot, 'brand', 'site.webmanifest'),
    JSON.stringify({ name: '三创 SANCHUANG', short_name: '三创' }),
  );
  await mkdir(join(publicRoot, 'assets'), { recursive: true });
  await writeFile(join(publicRoot, 'index.html'), INDEX_HTML);
  await writeFile(join(publicRoot, 'assets', 'app.js'), JS_BYTES);
});

afterAll(async () => {
  await rm(publicRoot, { recursive: true, force: true });
});

/** The brand sub-app on its own; the console mount is tested separately below. */
function createBrandOnlyApp() {
  const app = new Hono();
  app.route('/', createBrandAssetApp(publicRoot));
  return app;
}

describe('brand static assets', () => {
  it('serves a brand icon with the binary MIME type and its exact bytes', async () => {
    const response = await createBrandOnlyApp().request('/brand/icon-192.png');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(PNG_BYTES));
  });

  it('serves the web manifest as application/manifest+json', async () => {
    const response = await createBrandOnlyApp().request('/brand/site.webmanifest');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/manifest+json');
    expect(await response.json()).toMatchObject({ short_name: '三创' });
  });

  it('answers HEAD for a brand icon without a body', async () => {
    const response = await createBrandOnlyApp().request('/brand/favicon.ico', {
      method: 'HEAD',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/x-icon');
    expect(await response.text()).toBe('');
  });

  it('returns a JSON 404 instead of the SPA shell for a missing brand file', async () => {
    const response = await createBrandOnlyApp().request('/brand/missing.png');

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ error: 'NOT_FOUND', message: '品牌资源不存在' });
  });

  it('does not expose a directory listing for /brand/', async () => {
    const response = await createBrandOnlyApp().request('/brand/');

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('serves the legacy root /favicon.ico from the brand directory', async () => {
    const response = await createBrandOnlyApp().request('/favicon.ico');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/x-icon');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(ICO_BYTES));
  });

  it('returns a bare 404 for the legacy path when the brand icon is absent', async () => {
    const app = new Hono();
    app.route('/', createBrandAssetApp(join(publicRoot, 'does-not-exist')));

    const response = await app.request('/favicon.ico');

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
  });
});

describe('static app and console mount', () => {
  const app = () => createStaticApp(publicRoot);

  it('serves the console shell at /admin and nested client routes', async () => {
    for (const path of ['/admin', '/admin/', '/admin/catalog', '/admin/settings/runtime']) {
      const response = await app().request(path);

      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toContain('text/html');
      expect(response.headers.get('cache-control'), path).toBe('no-cache');
      expect(await response.text(), path).toContain('<title>Benefit Hub</title>');
    }
  });

  it('redirects the origin root to the console without caching the redirect', async () => {
    const response = await app().request('/');

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/admin/');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('does not fall back to the admin shell outside /admin', async () => {
    for (const path of ['/catalog', '/suppliers/yangmao', '/settings/runtime', '/login']) {
      const response = await app().request(path);

      expect(response.status, path).toBe(404);
      expect(response.headers.get('content-type'), path).toContain('application/json');
      expect(await response.json(), path).toEqual({
        error: 'NOT_FOUND',
        message: '页面不存在',
      });
    }
  });

  it('keeps the API 404 shape for unmatched API paths', async () => {
    const response = await app().request('/api/v1/unknown');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'NOT_FOUND', message: '接口不存在' });
  });

  it('serves hashed assets and brand files through the static app', async () => {
    const asset = await app().request('/assets/app.js');
    const brand = await app().request('/brand/icon-192.png');

    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('javascript');
    expect(new Uint8Array(await asset.arrayBuffer())).toEqual(new Uint8Array(JS_BYTES));
    expect(brand.status).toBe(200);
    expect(brand.headers.get('content-type')).toBe('image/png');
  });

  it('returns a JSON 404 for a missing asset instead of the shell', async () => {
    const response = await app().request('/assets/missing.js');

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
  });
});
