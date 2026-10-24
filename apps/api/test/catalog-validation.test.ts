import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CatalogProductDto } from '../src/modules/catalog/products.js';
import { seedAccount, TEST_PASSWORD, TestClient, TestServer } from './helpers/test-server.js';

interface ProductResponse {
  product: CatalogProductDto;
}

interface ErrorResponse {
  error: string;
  message: string;
  fields?: string[];
}

let server: TestServer;
let admin: TestClient;
let viewer: TestClient;
let adminId: string;

beforeEach(async () => {
  server = new TestServer();
  const adminAccount = await seedAccount(server, { username: 'ops.admin' });
  adminId = adminAccount.id;
  admin = new TestClient(server);
  expect((await admin.login('ops.admin', TEST_PASSWORD)).status).toBe(200);

  await seedAccount(server, { username: 'read.only', role: 'viewer' });
  viewer = new TestClient(server);
  expect((await viewer.login('read.only', TEST_PASSWORD)).status).toBe(200);
});

afterEach(() => {
  server.close();
});

async function createProduct(input: Record<string, unknown> = { code: 'ITEM-1', name: '测试商品' }) {
  const response = await admin.post('/api/v1/catalog/products', input);
  expect(response.status).toBe(201);
  return ((await response.json()) as ProductResponse).product;
}

function productCount(): number {
  const row = server.database.sqlite
    .prepare('SELECT COUNT(*) AS value FROM catalog_products')
    .get() as { value: number };
  return row.value;
}

describe('catalogue authorization', () => {
  it('rejects catalogue reads and writes without a valid session', async () => {
    const anonymous = new TestClient(server);

    const read = await anonymous.request('/api/v1/catalog/products');
    expect(read.status).toBe(401);
    expect(await read.json()).toEqual({ error: 'UNAUTHENTICATED', message: '请先登录' });

    const write = await anonymous.post('/api/v1/catalog/products', { code: 'X-1', name: '匿名写入' });
    expect(write.status).toBe(401);
    expect(((await write.json()) as ErrorResponse).error).toBe('UNAUTHENTICATED');
    expect(productCount()).toBe(0);
  });

  it('lets a viewer read products but forbids every write', async () => {
    const product = await createProduct();

    const list = await viewer.request('/api/v1/catalog/products');
    expect(list.status).toBe(200);

    const detail = await viewer.request(`/api/v1/catalog/products/${product.id}`);
    expect(detail.status).toBe(200);

    const attempts = [
      await viewer.post('/api/v1/catalog/products', { code: 'X-2', name: '只读身份写入' }),
      await viewer.patch(`/api/v1/catalog/products/${product.id}`, { version: 1, name: '只读身份编辑' }),
      await viewer.post(`/api/v1/catalog/products/${product.id}/disable`, { version: 1 }),
      await viewer.post(`/api/v1/catalog/products/${product.id}/enable`, { version: 1 }),
    ];
    for (const attempt of attempts) {
      expect(attempt.status).toBe(403);
      expect(await attempt.json()).toEqual({
        error: 'FORBIDDEN',
        message: '当前身份无权执行该操作',
      });
    }

    expect(productCount()).toBe(1);
    const reread = await admin.request(`/api/v1/catalog/products/${product.id}`);
    expect(((await reread.json()) as ProductResponse).product).toMatchObject({
      name: '测试商品',
      status: 'active',
      version: 1,
    });

    const events = server.database.sqlite
      .prepare('SELECT actor_account_id FROM catalog_product_events')
      .all() as { actor_account_id: string }[];
    expect(events).toEqual([{ actor_account_id: adminId }]);
  });

  it('requires the CSRF token for catalogue writes', async () => {
    const response = await admin.request('/api/v1/catalog/products', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'X-1', name: '缺少 CSRF' }),
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as ErrorResponse).error).toBe('CSRF_TOKEN_INVALID');
    expect(productCount()).toBe(0);
  });
});

describe('catalogue validation and conflict errors', () => {
  it('rejects invalid create payloads with stable field paths', async () => {
    const cases: { body: Record<string, unknown>; field: string }[] = [
      { body: { name: '缺少编码' }, field: 'code' },
      { body: { code: 'X-1' }, field: 'name' },
      { body: { code: 'X-1', name: '负价格', displayPriceCents: -1 }, field: 'displayPriceCents' },
      { body: { code: 'X-1', name: '小数价格', displayPriceCents: 10.5 }, field: 'displayPriceCents' },
      { body: { code: 'X-1', name: '负成本', estimatedCostCents: -100 }, field: 'estimatedCostCents' },
      { body: { code: '!bad', name: '非法编码' }, field: 'code' },
      { body: { code: 'X-1', name: 'x'.repeat(81) }, field: 'name' },
      { body: { code: 'X-1', name: '超长描述', shortDescription: 'd'.repeat(201) }, field: 'shortDescription' },
      { body: { code: 'X-1', name: '越权状态', status: 'disabled' }, field: 'status' },
    ];

    for (const { body, field } of cases) {
      const response = await admin.post('/api/v1/catalog/products', body);
      expect(response.status).toBe(400);
      const payload = (await response.json()) as ErrorResponse;
      expect(payload.error).toBe('INVALID_REQUEST');
      expect(payload.fields).toContain(field);
    }

    expect(productCount()).toBe(0);
  });

  it('rejects malformed JSON without creating a product', async () => {
    const response = await admin.request('/api/v1/catalog/products', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': admin.cookie('bh_csrf') ?? '',
      },
      body: '{"code":',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'INVALID_REQUEST', message: '请求格式不正确' });
    expect(productCount()).toBe(0);
  });

  it('validates edit payloads and requires the version precondition', async () => {
    const product = await createProduct();

    const cases: { body: Record<string, unknown>; field: string }[] = [
      { body: { version: 1 }, field: '' },
      { body: { name: '缺少版本' }, field: 'version' },
      { body: { version: 0, name: '非法版本' }, field: 'version' },
      { body: { version: 1, status: 'disabled' }, field: 'status' },
      { body: { version: 1, code: 'bad code' }, field: 'code' },
      { body: { version: 1, displayPriceCents: 1.5 }, field: 'displayPriceCents' },
    ];

    for (const { body, field } of cases) {
      const response = await admin.patch(`/api/v1/catalog/products/${product.id}`, body);
      expect(response.status).toBe(400);
      const payload = (await response.json()) as ErrorResponse;
      expect(payload.error).toBe('INVALID_REQUEST');
      if (field) expect(payload.fields).toContain(field);
    }

    // The rejected edits did not advance the version.
    const reread = await admin.request(`/api/v1/catalog/products/${product.id}`);
    expect(((await reread.json()) as ProductResponse).product.version).toBe(1);
  });

  it('returns a stable not-found error for unknown products', async () => {
    const get = await admin.request('/api/v1/catalog/products/missing-product');
    expect(get.status).toBe(404);
    expect(await get.json()).toEqual({ error: 'PRODUCT_NOT_FOUND', message: '商品不存在' });

    const patch = await admin.patch('/api/v1/catalog/products/missing-product', {
      version: 1,
      name: '不存在',
    });
    expect(patch.status).toBe(404);
    expect(((await patch.json()) as ErrorResponse).error).toBe('PRODUCT_NOT_FOUND');

    const enable = await admin.post('/api/v1/catalog/products/missing-product/enable', { version: 1 });
    expect(enable.status).toBe(404);
    expect(((await enable.json()) as ErrorResponse).error).toBe('PRODUCT_NOT_FOUND');

    const disable = await admin.post('/api/v1/catalog/products/missing-product/disable', { version: 1 });
    expect(disable.status).toBe(404);
    expect(((await disable.json()) as ErrorResponse).error).toBe('PRODUCT_NOT_FOUND');
  });

  it('rejects stale enable/disable attempts instead of silently overriding', async () => {
    const product = await createProduct();

    const disabled = await admin.post(`/api/v1/catalog/products/${product.id}/disable`, { version: 1 });
    expect(disabled.status).toBe(200);

    const staleDisable = await admin.post(`/api/v1/catalog/products/${product.id}/disable`, { version: 1 });
    expect(staleDisable.status).toBe(409);
    expect(((await staleDisable.json()) as ErrorResponse).error).toBe('PRODUCT_VERSION_CONFLICT');

    const staleEnable = await admin.post(`/api/v1/catalog/products/${product.id}/enable`, { version: 1 });
    expect(staleEnable.status).toBe(409);

    const enabled = await admin.post(`/api/v1/catalog/products/${product.id}/enable`, { version: 2 });
    expect(enabled.status).toBe(200);
    expect(((await enabled.json()) as ProductResponse).product).toMatchObject({
      status: 'active',
      version: 3,
    });
  });

  it('rejects invalid list query parameters but ignores unrelated ones', async () => {
    await createProduct();

    const invalidQueries = [
      '?page=0',
      '?page=abc',
      '?pageSize=0',
      '?pageSize=101',
      '?status=archived',
      `?keyword=${'k'.repeat(65)}`,
    ];
    for (const query of invalidQueries) {
      const response = await admin.request(`/api/v1/catalog/products${query}`);
      expect(response.status).toBe(400);
      expect(((await response.json()) as ErrorResponse).error).toBe('INVALID_REQUEST');
    }

    const withNoise = await admin.request('/api/v1/catalog/products?page=1&pageSize=10&_=12345');
    expect(withNoise.status).toBe(200);
  });
});
