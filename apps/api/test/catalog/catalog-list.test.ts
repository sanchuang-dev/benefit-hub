import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  CatalogProductDto,
  ProductMappingSummary,
} from '../../src/modules/catalog/products.js';
import { seedAccount, TEST_PASSWORD, TestClient, TestServer } from '../helpers/test-server.js';
import { mappingPath } from '../helpers/api-fixtures.js';

interface CatalogListItem extends CatalogProductDto {
  mapping: ProductMappingSummary;
}

interface SupplierFacet {
  key: string;
  name: string;
  configured: boolean;
}

interface ProductListResponse {
  products: CatalogListItem[];
  suppliers: SupplierFacet[];
  page: number;
  pageSize: number;
  total: number;
}

const NO_MAPPING: ProductMappingSummary = {
  state: 'none',
  provider: null,
  productCode: null,
  fulfillmentMode: null,
  versionNumber: null,
};

let server: TestServer;
let admin: TestClient;

beforeEach(async () => {
  server = new TestServer();
  await seedAccount(server, { username: 'list.admin', displayName: '列表管理员' });
  admin = new TestClient(server);
  expect((await admin.login('list.admin', TEST_PASSWORD)).status).toBe(200);
});

afterEach(() => {
  server.close();
});

async function createProduct(input: Record<string, unknown>): Promise<CatalogProductDto> {
  const response = await admin.post('/api/v1/catalog/products', input);
  expect(response.status).toBe(201);
  return ((await response.json()) as { product: CatalogProductDto }).product;
}

async function listProducts(query = ''): Promise<ProductListResponse> {
  const response = await admin.request(`/api/v1/catalog/products${query}`);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = (await response.json()) as ProductListResponse;
  expect(body.suppliers).toEqual([{ key: 'yangmao', name: '上力', configured: false }]);
  return body;
}

function draftBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    expectedVersion: null,
    provider: 'yangmao',
    productCode: 'YM-DRAFT-1',
    fulfillmentMode: 'B',
    deductionUnit: 'pack',
    ...overrides,
  };
}

async function saveDraft(productId: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const response = await admin.put(mappingPath(productId, '/draft'), draftBody(overrides));
  expect(response.status).toBe(200);
}

async function validateAndActivate(productId: string, version: number): Promise<void> {
  const validated = await admin.post(mappingPath(productId, '/validate'), { version });
  expect(validated.status).toBe(200);
  const activated = await admin.post(mappingPath(productId, '/activate'), { version });
  expect(activated.status).toBe(200);
}

function rowFor(body: ProductListResponse, code: string): CatalogListItem {
  const row = body.products.find((product) => product.code === code);
  if (!row) throw new Error(`Expected catalogue list to contain ${code}`);
  return row;
}

describe('catalogue list mapping summary', () => {
  it('returns state none for a product without a mapping and keeps the detail DTO mapping-free', async () => {
    const product = await createProduct({ code: 'NO-MAP', name: '无映射商品' });

    const body = await listProducts();
    expect(body.products).toEqual([{ ...product, mapping: NO_MAPPING }]);

    const detail = await admin.request(`/api/v1/catalog/products/${product.id}`);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { product: CatalogProductDto };
    expect(detailBody.product).toEqual(product);
    // `mapping` is a list read-model projection only; detail keeps its old shape.
    expect(detailBody.product).not.toHaveProperty('mapping');
  });

  it('shows draft values while the mapping has no active version', async () => {
    const product = await createProduct({ code: 'DRAFT-ONLY', name: '仅草稿商品' });
    await saveDraft(product.id, {
      productCode: 'YM-DRAFT-77',
      fulfillmentMode: 'D',
      deductionUnit: 'amount',
    });

    const body = await listProducts();
    expect(rowFor(body, 'DRAFT-ONLY').mapping).toEqual({
      state: 'draft',
      provider: 'yangmao',
      productCode: 'YM-DRAFT-77',
      fulfillmentMode: 'D',
      versionNumber: null,
    });
  });

  it('shows the active version snapshot once the draft is activated', async () => {
    const product = await createProduct({ code: 'ACTIVE-ROW', name: '已激活商品' });
    await saveDraft(product.id, { productCode: 'YM-ACTIVE-1' });
    await validateAndActivate(product.id, 1);

    const body = await listProducts();
    expect(rowFor(body, 'ACTIVE-ROW').mapping).toEqual({
      state: 'active',
      provider: 'yangmao',
      productCode: 'YM-ACTIVE-1',
      fulfillmentMode: 'B',
      versionNumber: 1,
    });
  });

  it('keeps showing the active snapshot after the draft is edited again', async () => {
    const product = await createProduct({ code: 'ACTIVE-THEN-EDIT', name: '激活后再改草稿' });
    await saveDraft(product.id, { productCode: 'YM-ACTIVE-1' });
    await validateAndActivate(product.id, 1);

    // Activation moved the draft to version 2; edit it without validating or
    // activating so the draft and the accepted snapshot intentionally differ.
    await saveDraft(product.id, {
      expectedVersion: 2,
      productCode: 'YM-DRAFT-999',
      fulfillmentMode: 'D',
      deductionUnit: 'amount',
    });

    const body = await listProducts();
    const row = rowFor(body, 'ACTIVE-THEN-EDIT');
    expect(row.mapping).toEqual({
      state: 'active',
      provider: 'yangmao',
      productCode: 'YM-ACTIVE-1',
      fulfillmentMode: 'B',
      versionNumber: 1,
    });

    // Evidence that the draft really did change: the list simply does not use it.
    const overview = await admin.request(mappingPath(product.id));
    expect(overview.status).toBe(200);
    const overviewBody = (await overview.json()) as {
      draft: { productCode: string; version: number };
      activeVersion: { productCode: string; versionNumber: number };
    };
    expect(overviewBody.draft).toMatchObject({ productCode: 'YM-DRAFT-999', version: 3 });
    expect(overviewBody.activeVersion).toMatchObject({ productCode: 'YM-ACTIVE-1', versionNumber: 1 });
  });
});

describe('catalogue supplier filter', () => {
  it('filters by effective supplier in SQL so total and paging stay consistent', async () => {
    await createProduct({ code: 'F-NONE', name: '无映射' });
    const draft = await createProduct({ code: 'F-DRAFT', name: '草稿映射' });
    const active = await createProduct({ code: 'F-ACTIVE', name: '生效映射' });
    await saveDraft(draft.id);
    await saveDraft(active.id);
    await validateAndActivate(active.id, 1);

    const unfiltered = await listProducts();
    expect(unfiltered.total).toBe(3);

    const filtered = await listProducts('?supplier=yangmao');
    expect(filtered.total).toBe(2);
    expect(filtered.products.map((product) => product.code).sort()).toEqual(['F-ACTIVE', 'F-DRAFT']);
    expect(filtered.products.every((product) => product.mapping.state !== 'none')).toBe(true);

    // Unknown but otherwise legal query keys are still ignored, as before.
    const withUnknown = await listProducts('?supplier=yangmao&cacheBust=123');
    expect(withUnknown.total).toBe(2);

    const invalid = await admin.request('/api/v1/catalog/products?supplier=not-a-provider');
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get('cache-control')).toBe('no-store');
    expect(await invalid.json()).toMatchObject({
      error: 'INVALID_REQUEST',
      fields: ['supplier'],
    });
  });

  it('combines pageSize, keyword, status and supplier without breaking total', async () => {
    const first = await createProduct({ code: 'PG-YM-1', name: '分页映射一' });
    const second = await createProduct({ code: 'PG-YM-2', name: '分页映射二' });
    await createProduct({ code: 'PG-NONE-3', name: '分页无映射' });
    await saveDraft(first.id);
    await saveDraft(second.id);
    await validateAndActivate(second.id, 1);

    const firstPage = await listProducts('?supplier=yangmao&pageSize=1&page=1');
    const secondPage = await listProducts('?supplier=yangmao&pageSize=1&page=2');
    const thirdPage = await listProducts('?supplier=yangmao&pageSize=1&page=3');

    expect(firstPage.total).toBe(2);
    expect(firstPage.page).toBe(1);
    expect(firstPage.pageSize).toBe(1);
    expect(firstPage.products).toHaveLength(1);
    expect(secondPage.products).toHaveLength(1);
    expect(thirdPage.products).toHaveLength(0);
    expect(new Set([firstPage.products[0]?.code, secondPage.products[0]?.code])).toEqual(
      new Set(['PG-YM-1', 'PG-YM-2']),
    );

    const keywordFiltered = await listProducts('?supplier=yangmao&keyword=PG-YM-1&pageSize=1');
    expect(keywordFiltered.total).toBe(1);
    expect(keywordFiltered.products.map((product) => product.code)).toEqual(['PG-YM-1']);

    // Status filtering still applies together with the supplier predicate.
    const disabled = await admin.post(`/api/v1/catalog/products/${first.id}/disable`, { version: first.version });
    expect(disabled.status).toBe(200);
    const activeOnly = await listProducts('?supplier=yangmao&status=active');
    expect(activeOnly.total).toBe(1);
    expect(activeOnly.products.map((product) => product.code)).toEqual(['PG-YM-2']);
  });
});

describe('catalogue supplier options', () => {
  it('marks the supplier unconfigured by default and configured when the server has credentials', async () => {
    const configuredServer = new TestServer({
      yangmaoInrice: {
        baseUrl: 'https://dev-api.isunpow.com',
        appKey: 'test-app-key',
        appSecret: 'test-app-secret',
      },
    });
    try {
      await seedAccount(configuredServer, { username: 'list.admin' });
      const configuredClient = new TestClient(configuredServer);
      expect((await configuredClient.login('list.admin', TEST_PASSWORD)).status).toBe(200);

      const response = await configuredClient.request('/api/v1/catalog/products');
      expect(response.status).toBe(200);
      const body = (await response.json()) as ProductListResponse;
      expect(body.suppliers).toEqual([{ key: 'yangmao', name: '上力', configured: true }]);
    } finally {
      configuredServer.close();
    }
  });
});
