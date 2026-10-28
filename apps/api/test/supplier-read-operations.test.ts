import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { seedAccount, TEST_PASSWORD, TestClient, TestServer } from './helpers/test-server.js';

async function fixtureVendor() {
  const calls: { method: string; path: string; signature: string | undefined; body: string }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      calls.push({ method: req.method ?? '', path: req.url ?? '', signature: req.headers['x-sign'] as string | undefined, body });
      const path = req.url ?? '';
      let data: unknown;
      if (path === '/open/v1/prepaid/purchase-check') {
        data = { purchaseRestricted: false, giftUnclaimed: true, lotteryUnbet: false,
          claimUrl: 'https://h5.example.test/continue', customerPhone: '13800000000' };
      } else if (path === '/open/v1/prepaid/orders/query') {
        data = { claimable: true, claimUrl: 'https://h5.example.test/recover' };
      } else if (path === '/open/v1/gift-vouchers/VOUCHER1') {
        data = { packTotal: 2, packRemaining: 1, expiresAt: '2026-11-25T00:00:00Z', phone: '13800000000' };
      } else {
        res.writeHead(404); res.end(); return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 0, data }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    origin: 'http://127.0.0.1:' + address.port,
    calls,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

describe('Yangmao operator read operations', () => {
  it('enforces admin cookie, CSRF and real signing for three read-only paths', async () => {
    const vendor = await fixtureVendor();
    const app = new TestServer({ yangmaoInrice: {
      baseUrl: vendor.origin, appKey: 'fixture-app-key', appSecret: 'fixture-app-secret',
    } });
    try {
      const anon = new TestClient(app);
      const path = '/api/v1/suppliers/yangmao/purchase-check';
      expect((await anon.post(path, { phone: '13800138000' })).status).toBe(401);
      await seedAccount(app, { username: 'fixture.viewer', role: 'viewer' });
      const viewer = new TestClient(app);
      expect((await viewer.login('fixture.viewer', TEST_PASSWORD)).status).toBe(200);
      expect((await viewer.post(path, { phone: '13800138000' })).status).toBe(403);
      await seedAccount(app, { username: 'fixture.admin' });
      const admin = new TestClient(app);
      expect((await admin.login('fixture.admin', TEST_PASSWORD)).status).toBe(200);
      const noCsrf = await admin.request(path, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone: '13800138000' }),
      });
      expect(noCsrf.status).not.toBe(200);
      expect(vendor.calls).toHaveLength(0);
      const bad = await admin.post(path, { phone: 'not-a-phone' });
      expect(bad.status).toBe(400);
      expect(vendor.calls).toHaveLength(0);

      const first = await admin.post(path, { phone: '13800138000' });
      expect(first.status).toBe(200);
      expect(first.headers.get('cache-control')).toBe('no-store');
      const f = await first.text();
      expect(f).toContain('"purchaseRestricted":false');
      expect(f).not.toContain('customerPhone');
      expect(f).not.toContain('13800000000');
      expect(f).not.toContain('fixture-app-secret');

      const second = await admin.post('/api/v1/suppliers/yangmao/prepaid/orders/query', { requestId: 'EXISTING-1' });
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({ order: { claimable: true } });

      const third = await admin.post('/api/v1/suppliers/yangmao/gift-vouchers/query', { code: 'VOUCHER1' });
      expect(third.status).toBe(200);
      const output = await third.text();
      expect(output).toContain('"packRemaining":1');
      expect(output).not.toContain('13800000000');
      expect(output).not.toContain('VOUCHER1');

      expect(vendor.calls.map((x) => [x.method, x.path])).toEqual([
        ['POST', '/open/v1/prepaid/purchase-check'],
        ['POST', '/open/v1/prepaid/orders/query'],
        ['GET', '/open/v1/gift-vouchers/VOUCHER1'],
      ]);
      for (const call of vendor.calls) {
        expect(call.signature).toMatch(/^[A-F0-9]{64}$/);
      }
    } finally {
      app.close();
      await vendor.close();
    }
  }, 20_000);

  it('returns explicit 503 instead of pretending absent credentials succeeded', async () => {
    const app = new TestServer();
    try {
      await seedAccount(app, { username: 'fixture.admin' });
      const admin = new TestClient(app);
      expect((await admin.login('fixture.admin', TEST_PASSWORD)).status).toBe(200);
      const response = await admin.post('/api/v1/suppliers/yangmao/purchase-check', { phone: '13800138000' });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: 'SUPPLIER_NOT_CONFIGURED' });
    } finally { app.close(); }
  });
});
