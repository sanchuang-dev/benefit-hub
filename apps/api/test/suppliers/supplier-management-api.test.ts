import { afterEach, describe, expect, it } from 'vitest';
import { seedAccount, TEST_PASSWORD, TestClient, TestServer } from '../helpers/test-server.js';

const servers: TestServer[] = [];
function fresh(configured: boolean): TestServer {
  const server = new TestServer({
    yangmaoInrice: configured
      ? {
          baseUrl: 'https://dev-api.isunpow.com',
          appKey: 'fixture-no-real-key',
          appSecret: 'fixture-no-real-secret',
        }
      : null,
  });
  servers.push(server);
  return server;
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe('read-only supplier management API', () => {
  it('rejects anonymous supplier list/detail requests', async () => {
    const client = new TestClient(fresh(true));
    for (const path of ['/api/v1/suppliers', '/api/v1/suppliers/yangmao']) {
      const response = await client.request(path);
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('shows unconfigured supplier as registered, not as connected or missing', async () => {
    const server = fresh(false);
    await seedAccount(server, { username: 'supplier.viewer', role: 'viewer' });
    const client = new TestClient(server);
    expect((await client.login('supplier.viewer', TEST_PASSWORD)).status).toBe(200);

    const response = await client.request('/api/v1/suppliers');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      suppliers: [{
        key: 'yangmao',
        name: '上力',
        catalogRead: { supported: true, configured: false, source: 'none', locked: false, canEdit: false },
      }],
    });
  });

  it('reports credential presence only, without leaking server secret or claiming a successful probe', async () => {
    const server = fresh(true);
    await seedAccount(server, { username: 'supplier.admin' });
    const client = new TestClient(server);
    expect((await client.login('supplier.admin', TEST_PASSWORD)).status).toBe(200);

    for (const path of ['/api/v1/suppliers', '/api/v1/suppliers/yangmao']) {
      const response = await client.request(path);
      const raw = await response.text();
      expect(response.status).toBe(200);
      expect(raw).toContain('"configured":true');
      expect(raw).not.toContain('"fulfillmentEnabled"');
      expect(raw).not.toContain('fixture-no-real-key');
      expect(raw).not.toContain('fixture-no-real-secret');
      expect(raw).not.toContain('dev-api.isunpow.com');
      expect(raw).not.toContain('online');
    }

    const missing = await client.request('/api/v1/suppliers/not-a-supplier');
    expect(missing.status).toBe(404);
  });
});
