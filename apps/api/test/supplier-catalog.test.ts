import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { seedAccount, TEST_PASSWORD, TestClient, TestServer } from './helpers/test-server.js';

const FIXTURE_APP_KEY = 'fixture-d-app-key';
const FIXTURE_APP_SECRET = 'fixture-d-app-secret-not-real';

interface VendorServer {
  origin: string;
  requests: { method: string; url: string; headers: IncomingMessage['headers'] }[];
  close(): Promise<void>;
}

const openServers: VendorServer[] = [];

/** Controlled loopback origin; the API still uses the real signed GET adapter. */
async function startVendorServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<VendorServer> {
  const requests: VendorServer['requests'] = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers });
    request.resume();
    request.on('end', () => handler(request, response));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

async function startApi(credentialed: boolean): Promise<{ server: TestServer; client: TestClient; vendor: VendorServer }> {
  const vendor = await startVendorServer((_request, response) => {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: 500, message: 'unexpected fixture call' }));
  });
  openServers.push(vendor);
  const server = new TestServer({
    yangmaoInrice: credentialed
      ? { baseUrl: vendor.origin, appKey: FIXTURE_APP_KEY, appSecret: FIXTURE_APP_SECRET }
      : null,
  });
  const client = new TestClient(server);
  await seedAccount(server, { username: 'supplier.admin' });
  expect((await client.login('supplier.admin', TEST_PASSWORD)).status).toBe(200);
  return { server, client, vendor };
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

describe('supplier catalogue read API', () => {
  it('rejects an unauthenticated read before touching the supplier', async () => {
    const { server, vendor } = await startApi(true);
    try {
      const response = await new TestClient(server).request('/api/v1/catalog/supplier-products');
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'UNAUTHENTICATED', message: '请先登录' });
      expect(vendor.requests).toHaveLength(0);
    } finally {
      server.close();
    }
  });

  it('reports an explicit unavailability when server credentials are absent', async () => {
    const { server, client } = await startApi(false);
    try {
      const response = await client.request('/api/v1/catalog/supplier-products');
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toEqual({
        error: 'SUPPLIER_NOT_CONFIGURED',
        message: '上力商品查询尚未配置；请在供应商管理中保存接入凭证后重试',
      });
      expect(body).not.toHaveProperty('products');
    } finally {
      server.close();
    }
  });

  it('reads the signed D catalogue and exposes only validated sanitized fields', async () => {
    const vendor = await startVendorServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          code: 0,
          message: 'success',
          data: [
            {
              productCode: 'FIXTURE-A',
              sellPrice: 12.34,
              productName: 'vendor-only name',
              goodsStatus: 'ON_SALE',
              details: '<p>vendor html</p>',
              extraJson: '{"mobile":"13800000000"}',
            },
            { productCode: 'FIXTURE-B', sellPrice: '0.05' },
          ],
        }),
      );
    });
    openServers.push(vendor);

    const server = new TestServer({
      yangmaoInrice: {
        baseUrl: vendor.origin,
        appKey: FIXTURE_APP_KEY,
        appSecret: FIXTURE_APP_SECRET,
      },
    });
    const client = new TestClient(server);
    await seedAccount(server, { username: 'supplier.reader', role: 'viewer' });
    expect((await client.login('supplier.reader', TEST_PASSWORD)).status).toBe(200);

    try {
      const response = await client.request('/api/v1/catalog/supplier-products');
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const raw = await response.text();

      const body = JSON.parse(raw) as {
        provider: string;
        currency: string;
        observedAt: string;
        products: { productCode: string; sellPriceCents: number }[];
      };
      expect(body.provider).toBe('yangmao');
      expect(body.currency).toBe('CNY');
      expect(Number.isNaN(Date.parse(body.observedAt))).toBe(false);
      expect(body.products).toEqual([
        { productCode: 'FIXTURE-A', sellPriceCents: 1234 },
        { productCode: 'FIXTURE-B', sellPriceCents: 5 },
      ]);

      // Supplier-only fields, credentials and signatures never reach the browser.
      expect(raw).not.toContain('vendor-only name');
      expect(raw).not.toContain('vendor html');
      expect(raw).not.toContain('13800000000');
      expect(raw).not.toContain('ON_SALE');
      expect(raw).not.toContain(FIXTURE_APP_KEY);
      expect(raw).not.toContain(FIXTURE_APP_SECRET);
      expect(raw.toLowerCase()).not.toContain('signature');

      expect(vendor.requests).toHaveLength(1);
      const [request] = vendor.requests;
      if (!request) throw new Error('supplier did not receive the request');
      expect(request.method).toBe('GET');
      expect(request.url).toBe('/api/open/inrice/v1/products');
      expect(request.headers['x-app-key']).toBe(FIXTURE_APP_KEY);
      expect(typeof request.headers['x-signature']).toBe('string');
      expect(request.headers['x-sign']).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('returns a real empty list only when the supplier actually returned one', async () => {
    const vendor = await startVendorServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 0, data: [] }));
    });
    openServers.push(vendor);

    const server = new TestServer({
      yangmaoInrice: {
        baseUrl: vendor.origin,
        appKey: FIXTURE_APP_KEY,
        appSecret: FIXTURE_APP_SECRET,
      },
    });
    const client = new TestClient(server);
    await seedAccount(server, { username: 'supplier.empty' });
    expect((await client.login('supplier.empty', TEST_PASSWORD)).status).toBe(200);

    try {
      const response = await client.request('/api/v1/catalog/supplier-products');
      expect(response.status).toBe(200);
      const body = (await response.json()) as { products: unknown[] };
      expect(body.products).toEqual([]);
      expect(vendor.requests).toHaveLength(1);
    } finally {
      server.close();
    }
  });

  it('maps supplier failures to a non-success response instead of an empty list', async () => {
    const vendor = await startVendorServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 5001, message: 'vendor business failure' }));
    });
    openServers.push(vendor);

    const server = new TestServer({
      yangmaoInrice: {
        baseUrl: vendor.origin,
        appKey: FIXTURE_APP_KEY,
        appSecret: FIXTURE_APP_SECRET,
      },
    });
    const client = new TestClient(server);
    await seedAccount(server, { username: 'supplier.failure' });
    expect((await client.login('supplier.failure', TEST_PASSWORD)).status).toBe(200);

    try {
      const response = await client.request('/api/v1/catalog/supplier-products');
      expect(response.status).toBe(502);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toEqual({
        error: 'SUPPLIER_READ_FAILED',
        message: '上力供应商商品读取失败，请稍后重试',
      });
      expect(body).not.toHaveProperty('products');
    } finally {
      server.close();
    }
  });

  it('maps supplier auth failure to a non-success response without echoing vendor text', async () => {
    const vendor = await startVendorServer((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 401, message: 'vendor auth text' }));
    });
    openServers.push(vendor);

    const server = new TestServer({
      yangmaoInrice: {
        baseUrl: vendor.origin,
        appKey: FIXTURE_APP_KEY,
        appSecret: FIXTURE_APP_SECRET,
      },
    });
    const client = new TestClient(server);
    await seedAccount(server, { username: 'supplier.auth' });
    expect((await client.login('supplier.auth', TEST_PASSWORD)).status).toBe(200);

    try {
      const response = await client.request('/api/v1/catalog/supplier-products');
      expect(response.status).toBe(502);
      const raw = await response.text();
      const body = JSON.parse(raw) as Record<string, unknown>;
      expect(body).toEqual({
        error: 'SUPPLIER_AUTH_FAILED',
        message: '上力供应商鉴权失败，请联系管理员检查只读凭证',
      });
      expect(raw).not.toContain('vendor auth text');
      expect(raw).not.toContain(FIXTURE_APP_SECRET);
    } finally {
      server.close();
    }
  });

  it('reads one supplier detail for a selected product without inventing fields', async () => {
    const vendor = await startVendorServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          code: 0,
          data: {
            productCode: 'FIXTURE-A',
            name: '测试商品一',
            sellPrice: 2.22,
            goodsStatus: 'ON_SALE',
            details: '<p>must not leak</p>',
          },
        }),
      );
    });
    openServers.push(vendor);

    const server = new TestServer({
      yangmaoInrice: {
        baseUrl: vendor.origin,
        appKey: FIXTURE_APP_KEY,
        appSecret: FIXTURE_APP_SECRET,
      },
    });
    const client = new TestClient(server);
    await seedAccount(server, { username: 'supplier.detail' });
    expect((await client.login('supplier.detail', TEST_PASSWORD)).status).toBe(200);

    try {
      const response = await client.request('/api/v1/catalog/supplier-products/FIXTURE-A');
      expect(response.status).toBe(200);
      const raw = await response.text();
      const body = JSON.parse(raw) as {
        product: {
          provider: string;
          currency: string;
          observedAt: string;
          productCode: string;
          name: string;
          sellPriceCents: number;
        };
      };
      expect(body.product).toMatchObject({
        provider: 'yangmao',
        currency: 'CNY',
        productCode: 'FIXTURE-A',
        name: '测试商品一',
        sellPriceCents: 222,
      });
      expect(Number.isNaN(Date.parse(body.product.observedAt))).toBe(false);
      expect(raw).not.toContain('must not leak');
      expect(raw).not.toContain('ON_SALE');
      expect(raw).not.toContain(FIXTURE_APP_SECRET);

      expect(vendor.requests).toHaveLength(1);
      expect(vendor.requests[0]?.url).toBe(
        '/api/open/inrice/v1/products/query?productCode=FIXTURE-A',
      );
    } finally {
      server.close();
    }
  });

  it('rejects a malformed product code locally without calling the supplier', async () => {
    const { server, client, vendor } = await startApi(true);
    try {
      const response = await client.request('/api/v1/catalog/supplier-products/%20FIXTURE-A%20');
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: 'INVALID_REQUEST',
        message: '商品编码不正确',
      });
      expect(vendor.requests).toHaveLength(0);
    } finally {
      server.close();
    }
  });
});
