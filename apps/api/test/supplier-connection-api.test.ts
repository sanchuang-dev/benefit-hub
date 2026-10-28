import { afterEach, describe, expect, it, vi } from 'vitest';
import { activeYangmaoReadConfig } from '../src/modules/suppliers/connection.js';
import { seedAccount, TEST_PASSWORD, TestClient, TestServer } from './helpers/test-server.js';

const key = Buffer.alloc(32, 0x42);
const connectionPath = '/api/v1/suppliers/yangmao/connection';
const APP_KEY = 'fixture-app-key-do-not-use';
const APP_SECRET = 'fixture-app-secret-not-real';
const servers: TestServer[] = [];
function serverWithKey(enabled = true) {
  const s = new TestServer({ supplierMasterKey: enabled ? key : null });
  servers.push(s);
  return s;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const s of servers.splice(0)) s.close();
});

async function adminClient(s: TestServer) {
  await seedAccount(s, { username: 'operator.admin' });
  const client = new TestClient(s);
  expect((await client.login('operator.admin', TEST_PASSWORD)).status).toBe(200);
  return client;
}

describe('encrypted supplier connection management', () => {
  it('requires session and admin role before editing supplier credentials', async () => {
    const s = serverWithKey();
    const anonymous = new TestClient(s);
    expect((await anonymous.request(connectionPath)).status).toBe(401);
    expect((await anonymous.put(connectionPath, {
      baseUrl: 'https://dev-api.isunpow.com', appKey: APP_KEY, appSecret: APP_SECRET, version: 0,
    })).status).toBe(401);

    await seedAccount(s, { username: 'operator.viewer', role: 'viewer' });
    const viewer = new TestClient(s);
    expect((await viewer.login('operator.viewer', TEST_PASSWORD)).status).toBe(200);
    expect((await viewer.request('/api/v1/suppliers')).status).toBe(200);
    expect((await viewer.request(connectionPath)).status).toBe(403);
    expect((await viewer.put(connectionPath, {
      baseUrl: 'https://dev-api.isunpow.com', appKey: APP_KEY, appSecret: APP_SECRET, version: 0,
    })).status).toBe(403);
  });

  it('encrypts in persisted SQLite, survives restart, and serves only masked metadata', async () => {
    const s = serverWithKey();
    const client = await adminClient(s);

    const input = { baseUrl: 'https://dev-api.isunpow.com', appKey: APP_KEY, appSecret: APP_SECRET, version: 0 };
    const saved = await client.put(connectionPath, input);
    expect(saved.status).toBe(200);
    const saveBody = await saved.text();
    expect(saveBody).toContain('"version":1');
    expect(saveBody).not.toContain(APP_KEY);
    expect(saveBody).not.toContain(APP_SECRET);
    const stored = s.database.sqlite.prepare('SELECT * FROM supplier_connections').all();
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(APP_KEY);
    expect(JSON.stringify(stored)).not.toContain(APP_SECRET);
    expect(String((stored[0] as { encrypted_credentials: string }).encrypted_credentials)).toMatch(/^v1:/);

    const events = s.database.sqlite.prepare('SELECT action, version FROM supplier_connection_events').all();
    expect(events).toEqual([{ action: 'saved', version: 1 }]);

    s.restart();
    expect(activeYangmaoReadConfig(s.database.db, s.config)).toEqual({
      baseUrl: 'https://dev-api.isunpow.com', appKey: APP_KEY, appSecret: APP_SECRET,
    });
    const registry = await client.request('/api/v1/suppliers');
    expect((await registry.json()).suppliers[0].catalogRead).toMatchObject({
      source: 'database', configured: true,
    });

    const metadata = await client.request(connectionPath);
    const payload = await metadata.text();
    expect(payload).toContain('"baseUrl":"https://dev-api.isunpow.com"');
    expect(payload).not.toContain(APP_KEY);
    expect(payload).not.toContain(APP_SECRET);
  });

  it('rejects invalid destinations, detects stale versions and preserves existing secrets on endpoint-only updates', async () => {
    const s = serverWithKey();
    const client = await adminClient(s);
    const first = { baseUrl: 'https://dev-api.isunpow.com', appKey: APP_KEY, appSecret: APP_SECRET, version: 0 };
    expect((await client.put(connectionPath, first)).status).toBe(200);

    const invalid = await client.put(connectionPath, { baseUrl: 'http://localhost:3000', version: 1 });
    expect(invalid.status).toBe(400);
    expect((await client.put(connectionPath, { baseUrl: 'https://evil.invalid', version: 1 })).status).toBe(400);

    const stale = await client.put(connectionPath, { baseUrl: 'https://dev-api.isunpow.com', version: 0 });
    expect(stale.status).toBe(409);

    const update = await client.put(connectionPath, { baseUrl: 'https://dev-api.isunpow.com', version: 1 });
    expect(update.status).toBe(200);
    expect(activeYangmaoReadConfig(s.database.db, s.config)).toMatchObject({
      appKey: APP_KEY, appSecret: APP_SECRET,
    });
    expect(s.database.sqlite.prepare('SELECT COUNT(*) as count FROM supplier_connection_events').get()).toEqual({ count: 2 });
  });

  it('fails closed without master key and never falls back to another credential source', async () => {
    const s = serverWithKey(false);
    const client = await adminClient(s);
    const response = await client.put(connectionPath, {
      baseUrl: 'https://dev-api.isunpow.com', appKey: APP_KEY, appSecret: APP_SECRET, version: 0,
    });
    expect(response.status).toBe(503);
    expect((await response.text()).not.toContain(APP_SECRET)).toBe(true);

    s.config.supplierMasterKey = key;
    expect((await client.put(connectionPath, {
      baseUrl: 'https://dev-api.isunpow.com', appKey: APP_KEY, appSecret: APP_SECRET, version: 0,
    })).status).toBe(200);

    s.config.supplierMasterKey = null;
    s.config.yangmaoInrice = { baseUrl: 'https://dev-api.isunpow.com', appKey: 'fallback', appSecret: 'fallback' };
    expect((await client.request('/api/v1/catalog/supplier-products')).status).toBe(503);
  });

  it('uses just-saved database credentials for the existing signed catalogue read', async () => {
    const s = serverWithKey();
    const client = await adminClient(s);
    expect((await client.put(connectionPath, {
      baseUrl: 'https://dev-api.isunpow.com', appKey: APP_KEY, appSecret: APP_SECRET, version: 0,
    })).status).toBe(200);
    const fetchMock = vi.fn(async (_request: Request | string | URL) =>
      new Response(JSON.stringify({ code: 0, data: [{ productCode: 'TEST-01', sellPrice: 1.25 }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await client.request('/api/v1/catalog/supplier-products');
    expect(response.status).toBe(200);
    const catalog = await response.json();
    expect(catalog.products).toEqual([{ productCode: 'TEST-01', sellPriceCents: 125 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
