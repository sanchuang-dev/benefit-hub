import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { openDatabase, runMigrations } from '../src/db/client.js';

const config: AppConfig = {
  databaseFile: ':memory:',
  host: '127.0.0.1',
  port: 0,
  cookieSecure: false,
  trustProxy: false,
  sessionTtlMs: 60_000,
  yangmaoInrice: null,
};

function createBootstrapApp() {
  const database = openDatabase(':memory:');
  runMigrations(database.sqlite);
  return createApp({ db: database.db, config });
}

describe('Benefit Hub bootstrap API', () => {
  it('returns a non-sensitive health status', async () => {
    const response = await createBootstrapApp().request('/healthz');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      service: 'benefit-hub',
    });
  });

  it('reports authentication enabled but supplier fulfillment disabled', async () => {
    const response = await createBootstrapApp().request('/api/v1/system/status');
    expect(response.status).toBe(200);
    const state = (await response.json()) as Record<string, unknown>;
    expect(state.vendorFulfillmentEnabled).toBe(false);
    expect(state.adminEnabled).toBe(true);
    expect(state.authenticationRequired).toBe(true);
  });

  it('sets basic security headers on API responses', async () => {
    const response = await createBootstrapApp().request('/api/v1/system/status');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('protects the login SPA shell against framing, not only API responses', async () => {
    const app = createBootstrapApp();
    // The production server adds its SPA fallback routes after createApp().
    app.get('/login', (c) => c.html('<!doctype html><html><body>login</body></html>'));
    const response = await app.request('/login');
    expect(response.status).toBe(200);
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('returns a JSON 404 for unknown API routes', async () => {
    const response = await createBootstrapApp().request('/api/v1/nope');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'NOT_FOUND', message: '接口不存在' });
  });
});
