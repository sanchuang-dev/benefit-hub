import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CatalogProductDto } from '../src/modules/catalog/products.js';
import { seedAccount, TEST_PASSWORD, TestClient, TestServer } from './helpers/test-server.js';

interface ProductResponse {
  product: CatalogProductDto;
}

interface ProductListResponse {
  products: CatalogProductDto[];
  page: number;
  pageSize: number;
  total: number;
}

let server: TestServer;
let admin: TestClient;
let adminId: string;

beforeEach(async () => {
  server = new TestServer();
  const account = await seedAccount(server, { username: 'ops.admin', displayName: '运营管理员' });
  adminId = account.id;
  admin = new TestClient(server);
  expect((await admin.login('ops.admin', TEST_PASSWORD)).status).toBe(200);
});

afterEach(() => {
  server.close();
});

async function createProduct(client: TestClient, input: Record<string, unknown>): Promise<CatalogProductDto> {
  const response = await client.post('/api/v1/catalog/products', input);
  expect(response.status).toBe(201);
  return ((await response.json()) as ProductResponse).product;
}

describe('internal product catalogue API', () => {
  it('creates a product, reads it back, and keeps it across a service restart', async () => {
    const product = await createProduct(admin, {
      code: 'tx-travel-10',
      name: '腾讯出行券 10 元',
      shortDescription: '腾讯出行 10 元券',
      displayPriceCents: 1000,
      estimatedCostCents: 900,
    });

    expect(product).toMatchObject({
      code: 'TX-TRAVEL-10',
      name: '腾讯出行券 10 元',
      shortDescription: '腾讯出行 10 元券',
      status: 'active',
      displayPriceCents: 1000,
      estimatedCostCents: 900,
      version: 1,
      vendorFulfillmentEnabled: false,
    });
    // The internal identifier is our own and is not derived from any supplier code.
    expect(product.id).not.toBe(product.code);
    expect(product.createdAt).toBe(product.updatedAt);

    const fetched = await admin.request(`/api/v1/catalog/products/${product.id}`);
    expect(fetched.status).toBe(200);
    expect(((await fetched.json()) as ProductResponse).product).toEqual(product);

    // Persisted in the SQLite file, not just in memory.
    const row = server.database.sqlite
      .prepare('SELECT id, code, status, version FROM catalog_products WHERE id = ?')
      .get(product.id) as { id: string; code: string; status: string; version: number };
    expect(row).toEqual({ id: product.id, code: 'TX-TRAVEL-10', status: 'active', version: 1 });

    server.restart();

    const afterRestart = await admin.request(`/api/v1/catalog/products/${product.id}`);
    expect(afterRestart.status).toBe(200);
    expect(((await afterRestart.json()) as ProductResponse).product).toEqual(product);
  });

  it('updates with a version precondition and audits the operator', async () => {
    const created = await createProduct(admin, { code: 'coffee-1', name: '咖啡券' });

    const updated = await admin.patch(`/api/v1/catalog/products/${created.id}`, {
      version: created.version,
      name: '咖啡券（新版）',
      displayPriceCents: 1500,
    });
    expect(updated.status).toBe(200);
    const edited = ((await updated.json()) as ProductResponse).product;
    expect(edited).toMatchObject({ name: '咖啡券（新版）', displayPriceCents: 1500, version: 2 });
    expect(edited.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);

    // A stale version must not silently overwrite the accepted edit.
    const stale = await admin.patch(`/api/v1/catalog/products/${created.id}`, {
      version: created.version,
      name: '陈旧覆盖',
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: 'PRODUCT_VERSION_CONFLICT',
      message: '商品已被他人更新，请刷新后按最新版本重试',
    });

    const reread = await admin.request(`/api/v1/catalog/products/${created.id}`);
    expect(((await reread.json()) as ProductResponse).product.name).toBe('咖啡券（新版）');

    const events = server.database.sqlite
      .prepare('SELECT action, actor_account_id FROM catalog_product_events WHERE product_id = ? ORDER BY rowid')
      .all(created.id) as { action: string; actor_account_id: string }[];
    expect(events).toEqual([
      { action: 'created', actor_account_id: adminId },
      { action: 'updated', actor_account_id: adminId },
    ]);
  });

  it('disables and re-enables a product and filters by status', async () => {
    await createProduct(admin, { code: 'travel-1', name: '出行券' });
    const coffee = await createProduct(admin, { code: 'coffee-1', name: '咖啡券' });

    const disabled = await admin.post(`/api/v1/catalog/products/${coffee.id}/disable`, {
      version: coffee.version,
    });
    expect(disabled.status).toBe(200);
    const disabledProduct = ((await disabled.json()) as ProductResponse).product;
    expect(disabledProduct.status).toBe('disabled');
    expect(disabledProduct.version).toBe(2);

    const disabledList = await admin.request('/api/v1/catalog/products?status=disabled');
    expect(disabledList.status).toBe(200);
    const disabledBody = (await disabledList.json()) as ProductListResponse;
    expect(disabledBody.total).toBe(1);
    expect(disabledBody.products.map((product) => product.code)).toEqual(['COFFEE-1']);

    const enabled = await admin.post(`/api/v1/catalog/products/${coffee.id}/enable`, { version: 2 });
    expect(enabled.status).toBe(200);
    expect(((await enabled.json()) as ProductResponse).product.status).toBe('active');

    const activeList = await admin.request('/api/v1/catalog/products?status=active');
    const activeBody = (await activeList.json()) as ProductListResponse;
    expect(activeBody.total).toBe(2);
    expect(activeBody.products.map((product) => product.code).sort()).toEqual(['COFFEE-1', 'TRAVEL-1']);

    // Disabling keeps the row and the audit trail instead of deleting history.
    const events = server.database.sqlite
      .prepare('SELECT action FROM catalog_product_events WHERE product_id = ? ORDER BY rowid')
      .all(coffee.id) as { action: string }[];
    expect(events.map((event) => event.action)).toEqual(['created', 'disabled', 'enabled']);
  });

  it('paginates and searches code, name, and description without wildcard surprises', async () => {
    const one = await createProduct(admin, { code: 'P-001', name: '普通商品' });
    const two = await createProduct(admin, { code: 'P-002', name: '咖啡券', shortDescription: '线下门店使用' });
    const three = await createProduct(admin, { code: 'P-003', name: '折扣 50% 券' });

    // Make the newest-first ordering deterministic regardless of millisecond timing.
    const stamp = server.database.sqlite.prepare('UPDATE catalog_products SET created_at = ? WHERE id = ?');
    stamp.run(1_000, one.id);
    stamp.run(2_000, two.id);
    stamp.run(3_000, three.id);

    const firstPage = await admin.request('/api/v1/catalog/products?page=1&pageSize=2');
    expect(firstPage.status).toBe(200);
    const firstBody = (await firstPage.json()) as ProductListResponse;
    expect(firstBody).toMatchObject({ page: 1, pageSize: 2, total: 3 });
    expect(firstBody.products.map((product) => product.code)).toEqual(['P-003', 'P-002']);

    const secondPage = await admin.request('/api/v1/catalog/products?page=2&pageSize=2');
    const secondBody = (await secondPage.json()) as ProductListResponse;
    expect(secondBody.products.map((product) => product.code)).toEqual(['P-001']);

    const byName = await admin.request('/api/v1/catalog/products?keyword=咖啡');
    expect(((await byName.json()) as ProductListResponse).products.map((p) => p.code)).toEqual(['P-002']);

    const byDescription = await admin.request('/api/v1/catalog/products?keyword=门店');
    expect(((await byDescription.json()) as ProductListResponse).products.map((p) => p.code)).toEqual(['P-002']);

    const byCode = await admin.request('/api/v1/catalog/products?keyword=p-00');
    expect(((await byCode.json()) as ProductListResponse).total).toBe(3);

    // `%` is escaped, so it matches the literal percent sign in one name only.
    const byPercent = await admin.request('/api/v1/catalog/products?keyword=%25');
    expect(((await byPercent.json()) as ProductListResponse).products.map((p) => p.code)).toEqual(['P-003']);

    const empty = await admin.request('/api/v1/catalog/products?keyword=不存在');
    expect(((await empty.json()) as ProductListResponse).total).toBe(0);
  });

  it('enforces unique business codes in the database and normalizes their case', async () => {
    await createProduct(admin, { code: 'TX-1', name: '腾讯券' });

    const duplicate = await admin.post('/api/v1/catalog/products', { code: 'tx-1', name: '重复券' });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({
      error: 'PRODUCT_CODE_CONFLICT',
      message: '商品编码已存在',
    });

    const count = server.database.sqlite
      .prepare('SELECT COUNT(*) AS value FROM catalog_products')
      .get() as { value: number };
    expect(count.value).toBe(1);

    // The uniqueness guarantee lives in SQLite, not only in the HTTP layer.
    expect(() =>
      server.database.sqlite
        .prepare(
          `INSERT INTO catalog_products
             (id, code, name, short_description, status, version, created_at, updated_at)
           VALUES ('direct-insert', 'TX-1', '绕过接口', '', 'active', 1, 0, 0)`,
        )
        .run(),
    ).toThrowError(/UNIQUE constraint failed: catalog_products.code/);
  });

  it('rejects a code change that collides with another product and keeps the old code', async () => {
    const first = await createProduct(admin, { code: 'A-1', name: '商品 A' });
    const second = await createProduct(admin, { code: 'B-1', name: '商品 B' });

    const conflict = await admin.patch(`/api/v1/catalog/products/${second.id}`, {
      version: second.version,
      code: first.code,
    });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: string }).error).toBe('PRODUCT_CODE_CONFLICT');

    const reread = await admin.request(`/api/v1/catalog/products/${second.id}`);
    expect(((await reread.json()) as ProductResponse).product.code).toBe('B-1');
  });

  it('never reports an internal product as vendor-fulfilable', async () => {
    const created = await createProduct(admin, { code: 'NO-MAPPING', name: '无映射商品' });
    expect(created.vendorFulfillmentEnabled).toBe(false);

    const list = await admin.request('/api/v1/catalog/products');
    const body = (await list.json()) as ProductListResponse;
    expect(body.products.every((product) => product.vendorFulfillmentEnabled === false)).toBe(true);

    // Unmapped products cannot be made fulfilable by sending a vendor flag.
    const rejected = await admin.post('/api/v1/catalog/products', {
      code: 'FORGED-MAPPING',
      name: '伪造映射',
      vendorFulfillmentEnabled: true,
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: 'INVALID_REQUEST', fields: ['vendorFulfillmentEnabled'] });
  });
});
