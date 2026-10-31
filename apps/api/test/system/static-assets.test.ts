import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrandAssetApp } from '../../src/static-assets.js';

/**
 * The brand assets are plain files copied by the admin build, so these tests use
 * a fixture directory shaped like the container's `public/` instead of the real
 * Vite output (which is git-ignored and only exists after `pnpm build`).
 */
let publicRoot: string;

const ICO_BYTES = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01]);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeAll(async () => {
  publicRoot = await mkdtemp(join(tmpdir(), 'benefit-brand-'));
  await mkdir(join(publicRoot, 'brand'), { recursive: true });
  await writeFile(join(publicRoot, 'brand', 'favicon.ico'), ICO_BYTES);
  await writeFile(join(publicRoot, 'brand', 'icon-192.png'), PNG_BYTES);
  await writeFile(
    join(publicRoot, 'brand', 'site.webmanifest'),
    JSON.stringify({ name: '三创 SANCHUANG', short_name: '三创' }),
  );
});

afterAll(async () => {
  await rm(publicRoot, { recursive: true, force: true });
});

/** The production assembly: brand routes, then the SPA catch-all. */
function createAppWithFallback() {
  const app = new Hono();
  app.route('/', createBrandAssetApp(publicRoot));
  app.get('*', (c) => c.html('<!doctype html><title>Benefit Hub</title>'));
  return app;
}

describe('brand static assets', () => {
  it('serves a brand icon with the binary MIME type and its exact bytes', async () => {
    const response = await createAppWithFallback().request('/brand/icon-192.png');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(PNG_BYTES));
  });

  it('serves the web manifest as application/manifest+json', async () => {
    const response = await createAppWithFallback().request('/brand/site.webmanifest');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/manifest+json');
    expect(await response.json()).toMatchObject({ short_name: '三创' });
  });

  it('answers HEAD for a brand icon without a body', async () => {
    const response = await createAppWithFallback().request('/brand/favicon.ico', {
      method: 'HEAD',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/x-icon');
    expect(await response.text()).toBe('');
  });

  it('returns a JSON 404 instead of the SPA shell for a missing brand file', async () => {
    const response = await createAppWithFallback().request('/brand/missing.png');

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ error: 'NOT_FOUND', message: '品牌资源不存在' });
  });

  it('does not expose a directory listing for /brand/', async () => {
    const response = await createAppWithFallback().request('/brand/');

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('keeps the SPA catch-all for non-brand paths', async () => {
    const response = await createAppWithFallback().request('/catalog');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('<title>Benefit Hub</title>');
  });

  it('serves the legacy root /favicon.ico from the brand directory', async () => {
    const response = await createAppWithFallback().request('/favicon.ico');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/x-icon');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(ICO_BYTES));
  });

  it('returns a bare 404 for the legacy path when the brand icon is absent', async () => {
    const app = new Hono();
    app.route('/', createBrandAssetApp(join(publicRoot, 'does-not-exist')));
    app.get('*', (c) => c.html('<!doctype html>'));

    const response = await app.request('/favicon.ico');

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
  });
});
