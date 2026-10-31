import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalogProductEvents, catalogProducts } from '../../src/db/schema.js';
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

/**
 * Products created through the API share wall-clock milliseconds, which is not
 * enough to prove a deterministic ORDER BY. The test pins timestamps on the
 * real SQLite rows so ties are intentional rather than incidental.
 */
function pinTimes(id: string, createdAt: number, updatedAt = createdAt): void {
  server.database.db
    .update(catalogProducts)
    .set({ createdAt, updatedAt })
    .where(eq(catalogProducts.id, id))
    .run();
}

function codes(body: ProductListResponse): string[] {
  return body.products.map((product) => product.code);
}

async function expectInvalidListQuery(path: string, fields: string[]): Promise<void> {
  const response = await admin.request(`/api/v1/catalog/products${path}`);
  expect(response.status).toBe(400);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toMatchObject({ error: 'INVALID_REQUEST', fields });
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

describe('catalogue list sorting', () => {
  it('keeps the legacy createdAt DESC, code ASC order across page boundaries', async () => {
    for (const code of ['SORT-C', 'SORT-A', 'SORT-E', 'SORT-B', 'SORT-D']) {
      const product = await createProduct({ code, name: `商品 ${code}` });
      pinTimes(product.id, 1_000);
    }
    const newest = await createProduct({ code: 'SORT-NEW', name: '最新商品' });
    pinTimes(newest.id, 2_000);

    const seen: string[] = [];
    for (let page = 1; page <= 4; page += 1) {
      const body = await listProducts(`?page=${page}&pageSize=2`);
      expect(body.total).toBe(6);
      seen.push(...codes(body));
    }

    expect(seen).toEqual(['SORT-NEW', 'SORT-A', 'SORT-B', 'SORT-C', 'SORT-D', 'SORT-E']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('sorts createdAt and updatedAt in both directions with code as the tie-breaker', async () => {
    const a = await createProduct({ code: 'TS-A', name: '时间 A' });
    const b = await createProduct({ code: 'TS-B', name: '时间 B' });
    const c = await createProduct({ code: 'TS-C', name: '时间 C' });
    pinTimes(a.id, 1_000, 3_000);
    pinTimes(b.id, 2_000, 2_000);
    pinTimes(c.id, 2_000, 1_000);

    expect(codes(await listProducts('?sortBy=createdAt&sortOrder=asc'))).toEqual(['TS-A', 'TS-B', 'TS-C']);
    expect(codes(await listProducts('?sortBy=createdAt&sortOrder=desc'))).toEqual(['TS-B', 'TS-C', 'TS-A']);
    // A lone sortBy is fixed to ascending, matching the documented rule.
    expect(codes(await listProducts('?sortBy=createdAt'))).toEqual(['TS-A', 'TS-B', 'TS-C']);

    expect(codes(await listProducts('?sortBy=updatedAt&sortOrder=asc'))).toEqual(['TS-C', 'TS-B', 'TS-A']);
    expect(codes(await listProducts('?sortBy=updatedAt&sortOrder=desc'))).toEqual(['TS-A', 'TS-B', 'TS-C']);
  });

  it('sorts code and name in both directions and pages the sorted result', async () => {
    await createProduct({ code: 'SORT-Z', name: 'Bravo' });
    await createProduct({ code: 'SORT-A', name: 'Charlie' });
    await createProduct({ code: 'SORT-M', name: 'Alpha' });

    expect(codes(await listProducts('?sortBy=code&sortOrder=asc'))).toEqual(['SORT-A', 'SORT-M', 'SORT-Z']);
    expect(codes(await listProducts('?sortBy=code&sortOrder=desc'))).toEqual(['SORT-Z', 'SORT-M', 'SORT-A']);
    expect(codes(await listProducts('?sortBy=name&sortOrder=asc'))).toEqual(['SORT-M', 'SORT-Z', 'SORT-A']);
    expect(codes(await listProducts('?sortBy=name&sortOrder=desc'))).toEqual(['SORT-A', 'SORT-Z', 'SORT-M']);

    const firstPage = await listProducts('?sortBy=code&sortOrder=desc&pageSize=1&page=1');
    const secondPage = await listProducts('?sortBy=code&sortOrder=desc&pageSize=1&page=2');
    expect(firstPage.total).toBe(3);
    expect(codes(firstPage)).toEqual(['SORT-Z']);
    expect(codes(secondPage)).toEqual(['SORT-M']);
  });

  it('sorts displayPriceCents with NULL prices last in both directions', async () => {
    await createProduct({ code: 'PRICE-300B', name: '价格 300 B', displayPriceCents: 300 });
    await createProduct({ code: 'PRICE-NULL', name: '无价格' });
    await createProduct({ code: 'PRICE-100', name: '价格 100', displayPriceCents: 100 });
    await createProduct({ code: 'PRICE-300A', name: '价格 300 A', displayPriceCents: 300 });

    expect(codes(await listProducts('?sortBy=displayPriceCents&sortOrder=asc'))).toEqual([
      'PRICE-100',
      'PRICE-300A',
      'PRICE-300B',
      'PRICE-NULL',
    ]);
    expect(codes(await listProducts('?sortBy=displayPriceCents&sortOrder=desc'))).toEqual([
      'PRICE-300A',
      'PRICE-300B',
      'PRICE-100',
      'PRICE-NULL',
    ]);

    // The same order must survive a LIMIT/OFFSET split, not just one full page.
    const first = await listProducts('?sortBy=displayPriceCents&sortOrder=desc&pageSize=2&page=1');
    const second = await listProducts('?sortBy=displayPriceCents&sortOrder=desc&pageSize=2&page=2');
    expect([...codes(first), ...codes(second)]).toEqual([
      'PRICE-300A',
      'PRICE-300B',
      'PRICE-100',
      'PRICE-NULL',
    ]);
  });

  it('pages every sort field in both directions without duplicates or gaps', async () => {
    const rows: Array<{ code: string; name: string; price: number | null; createdAt: number; updatedAt: number }> = [
      { code: 'PAGE-A', name: 'Delta', price: 300, createdAt: 2_000, updatedAt: 1_000 },
      { code: 'PAGE-B', name: 'Alpha', price: null, createdAt: 1_000, updatedAt: 2_000 },
      { code: 'PAGE-C', name: 'Echo', price: 100, createdAt: 2_000, updatedAt: 2_000 },
      { code: 'PAGE-D', name: 'Bravo', price: 300, createdAt: 3_000, updatedAt: 3_000 },
      { code: 'PAGE-E', name: 'Charlie', price: 100, createdAt: 3_000, updatedAt: 3_000 },
    ];
    for (const row of rows) {
      const product = await createProduct({
        code: row.code,
        name: row.name,
        displayPriceCents: row.price,
      });
      pinTimes(product.id, row.createdAt, row.updatedAt);
    }

    const fields = ['createdAt', 'updatedAt', 'code', 'name', 'displayPriceCents'] as const;
    for (const field of fields) {
      for (const order of ['asc', 'desc'] as const) {
        const full = await listProducts(`?sortBy=${field}&sortOrder=${order}&pageSize=100`);
        expect(full.total).toBe(5);

        const paged: string[] = [];
        for (let page = 1; page <= 4; page += 1) {
          const body = await listProducts(`?sortBy=${field}&sortOrder=${order}&pageSize=2&page=${page}`);
          expect(body.total).toBe(5);
          paged.push(...codes(body));
        }

        expect(paged, `${field} ${order}`).toEqual(codes(full));
        expect(new Set(paged).size, `${field} ${order}`).toBe(5);
      }
    }
  });
});

describe('catalogue mapping state filter', () => {
  it('filters none, draft and active snapshots consistently with total', async () => {
    await createProduct({ code: 'MS-NONE', name: '无映射' });
    const draft = await createProduct({ code: 'MS-DRAFT', name: '草稿映射' });
    await saveDraft(draft.id);
    const active = await createProduct({ code: 'MS-ACTIVE', name: '生效映射' });
    await saveDraft(active.id);
    await validateAndActivate(active.id, 1);
    // An edited draft under an accepted snapshot must still count as active.
    await saveDraft(active.id, { expectedVersion: 2, productCode: 'YM-DRAFT-EDIT' });

    const none = await listProducts('?mappingState=none');
    expect(none.total).toBe(1);
    expect(codes(none)).toEqual(['MS-NONE']);

    const draftOnly = await listProducts('?mappingState=draft');
    expect(draftOnly.total).toBe(1);
    expect(codes(draftOnly)).toEqual(['MS-DRAFT']);

    const activeOnly = await listProducts('?mappingState=active');
    expect(activeOnly.total).toBe(1);
    expect(codes(activeOnly)).toEqual(['MS-ACTIVE']);

    const combined = await listProducts('?mappingState=active&supplier=yangmao');
    expect(combined.total).toBe(1);
    expect(codes(combined)).toEqual(['MS-ACTIVE']);
  });
});

describe('catalogue display price filter', () => {
  it('applies inclusive bounds in SQL and excludes NULL prices', async () => {
    await createProduct({ code: 'PF-NULL', name: '无价格' });
    await createProduct({ code: 'PF-100', name: '一百', displayPriceCents: 100 });
    await createProduct({ code: 'PF-500', name: '五百', displayPriceCents: 500 });
    await createProduct({ code: 'PF-1000', name: '一千', displayPriceCents: 1000 });

    const range = await listProducts(
      '?displayPriceMinCents=100&displayPriceMaxCents=500&sortBy=displayPriceCents&sortOrder=asc',
    );
    expect(range.total).toBe(2);
    expect(codes(range)).toEqual(['PF-100', 'PF-500']);

    const minOnly = await listProducts(
      '?displayPriceMinCents=500&sortBy=displayPriceCents&sortOrder=asc',
    );
    expect(minOnly.total).toBe(2);
    expect(codes(minOnly)).toEqual(['PF-500', 'PF-1000']);

    const maxOnly = await listProducts('?displayPriceMaxCents=100');
    expect(maxOnly.total).toBe(1);
    expect(codes(maxOnly)).toEqual(['PF-100']);

    // A NULL price is not "zero or more": requesting any bound excludes it.
    const zeroMin = await listProducts(
      '?displayPriceMinCents=0&sortBy=displayPriceCents&sortOrder=asc',
    );
    expect(zeroMin.total).toBe(3);
    expect(codes(zeroMin)).not.toContain('PF-NULL');

    const combined = await listProducts(
      '?displayPriceMinCents=100&displayPriceMaxCents=500&keyword=PF-5',
    );
    expect(combined.total).toBe(1);
    expect(codes(combined)).toEqual(['PF-500']);
  });
});

describe('catalogue list query validation', () => {
  it('rejects unknown sort fields, directions and invalid price bounds with field names', async () => {
    await expectInvalidListQuery('?sortBy=estimatedCostCents', ['sortBy']);
    await expectInvalidListQuery('?sortOrder=asc', ['sortOrder']);
    await expectInvalidListQuery('?sortBy=code&sortOrder=sideways', ['sortOrder']);
    await expectInvalidListQuery('?mappingState=live', ['mappingState']);
    await expectInvalidListQuery('?displayPriceMinCents=-1', ['displayPriceMinCents']);
    await expectInvalidListQuery('?displayPriceMinCents=1.5', ['displayPriceMinCents']);
    await expectInvalidListQuery('?displayPriceMaxCents=12.5', ['displayPriceMaxCents']);
    await expectInvalidListQuery('?displayPriceMinCents=500&displayPriceMaxCents=100', [
      'displayPriceMinCents',
    ]);
  });

  it('still ignores unknown extra query keys and still requires a session', async () => {
    const product = await createProduct({ code: 'Q-COMPAT', name: '兼容' });
    pinTimes(product.id, 1_000);

    const withUnknown = await listProducts('?sortBy=code&sortOrder=asc&cacheBust=123');
    expect(withUnknown.total).toBe(1);

    const anonymous = new TestClient(server);
    const response = await anonymous.request('/api/v1/catalog/products?sortBy=code');
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe('UNAUTHENTICATED');
  });

  it('reads without writing rows or calling an upstream supplier', async () => {
    await createProduct({ code: 'RO-1', name: '只读一', displayPriceCents: 10 });
    await createProduct({ code: 'RO-2', name: '只读二' });
    const productsBefore = server.database.db.select().from(catalogProducts).all();
    const eventsBefore = server.database.db.select().from(catalogProductEvents).all();

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const body = await listProducts(
        '?mappingState=none&displayPriceMinCents=0&sortBy=displayPriceCents&sortOrder=desc',
      );
      expect(body.total).toBe(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }

    expect(server.database.db.select().from(catalogProducts).all()).toEqual(productsBefore);
    expect(server.database.db.select().from(catalogProductEvents).all()).toEqual(eventsBefore);
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
