import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mappingErrorResponseSchema,
  mappingOverviewSchema,
  type MappingOverviewDto,
} from '@sanchuang-dev/benefit-contracts';
import { seedAccount, TEST_PASSWORD, TestClient, TestServer } from '../helpers/test-server.js';
import { mappingPath } from '../helpers/api-fixtures.js';

let server: TestServer;
let admin: TestClient;
let viewer: TestClient;
let adminId: string;

beforeEach(async () => {
  server = new TestServer();
  adminId = (await seedAccount(server, { username: 'mapping.admin' })).id;
  await seedAccount(server, { username: 'mapping.viewer', role: 'viewer' });
  admin = new TestClient(server);
  viewer = new TestClient(server);
  expect((await admin.login('mapping.admin', TEST_PASSWORD)).status).toBe(200);
  expect((await viewer.login('mapping.viewer', TEST_PASSWORD)).status).toBe(200);
});

afterEach(() => {
  server.close();
});

async function createProduct(code: string): Promise<string> {
  const response = await admin.post('/api/v1/catalog/products', {
    code,
    name: `映射测试商品 ${code}`,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { product: { id: string } }).product.id;
}

function draftBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    expectedVersion: null,
    provider: 'yangmao',
    productCode: 'YM-1001',
    fulfillmentMode: 'B',
    deductionUnit: 'pack',
    ...overrides,
  };
}

async function fetchOverview(productId: string): Promise<MappingOverviewDto> {
  const response = await admin.request(mappingPath(productId));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return parseOverview(await response.json());
}

/** Response parsing is part of the evidence: the API must match the contract. */
function parseOverview(body: unknown): MappingOverviewDto {
  const parsed = mappingOverviewSchema.safeParse(body);
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error('Overview does not match the shared contract');
  return parsed.data;
}

function parseError(body: unknown) {
  const parsed = mappingErrorResponseSchema.safeParse(body);
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error('Error body does not match the shared contract');
  return parsed.data;
}

function mappingRowCount(productId: string): number {
  const row = server.database.sqlite
    .prepare('SELECT COUNT(*) AS value FROM supplier_product_mappings WHERE product_id = ?')
    .get(productId) as { value: number };
  return row.value;
}

describe('mapping management API access boundaries', () => {
  it('requires a session to read a mapping overview', async () => {
    const productId = await createProduct('MAP-API-1');
    const anonymous = new TestClient(server);

    const response = await anonymous.request(mappingPath(productId));
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: 'UNAUTHENTICATED',
      message: '请先登录',
    });
  });

  it('lets a viewer read but forbids every mapping write server-side', async () => {
    const productId = await createProduct('MAP-API-1');

    const read = await viewer.request(mappingPath(productId));
    expect(read.status).toBe(200);
    expect(parseOverview(await read.json())).toMatchObject({
      productId,
      validationScope: 'local',
      upstreamVerified: false,
      draft: null,
      activeVersion: null,
      versions: [],
    });

    const writes: Array<[string, string, Record<string, unknown>]> = [
      ['PUT', mappingPath(productId, '/draft'), draftBody()],
      ['POST', mappingPath(productId, '/validate'), { version: 1 }],
      ['POST', mappingPath(productId, '/activate'), { version: 1 }],
    ];
    for (const [method, path, body] of writes) {
      const response =
        method === 'PUT'
          ? await viewer.put(path, body)
          : await viewer.post(path, body);
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        error: 'FORBIDDEN',
        message: '当前身份无权执行该操作',
      });
    }
    expect(mappingRowCount(productId)).toBe(0);
  });

  it('returns 404 PRODUCT_NOT_FOUND for an unknown product on every mapping route', async () => {
    const routes: Array<[string, string, unknown]> = [
      ['GET', mappingPath('missing-product'), undefined],
      ['PUT', mappingPath('missing-product', '/draft'), draftBody()],
      ['POST', mappingPath('missing-product', '/validate'), { version: 1 }],
      ['POST', mappingPath('missing-product', '/activate'), { version: 1 }],
    ];

    for (const [method, path, body] of routes) {
      const response =
        method === 'GET'
          ? await admin.request(path)
          : method === 'PUT'
            ? await admin.put(path, body)
            : await admin.post(path, body);
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(await response.json()).toEqual({
        error: 'PRODUCT_NOT_FOUND',
        message: '商品不存在',
      });
    }
  });

  it('returns a stable empty overview when the product exists without a mapping', async () => {
    const productId = await createProduct('MAP-API-1');

    const overview = await fetchOverview(productId);
    expect(overview).toEqual({
      productId,
      validationScope: 'local',
      upstreamVerified: false,
      draft: null,
      activeVersion: null,
      versions: [],
    });
    expect(mappingRowCount(productId)).toBe(0);
  });
});

describe('mapping draft HTTP lifecycle', () => {
  it('creates the first draft with expectedVersion null and updates by version', async () => {
    const productId = await createProduct('MAP-API-1');

    const created = await admin.put(mappingPath(productId, '/draft'), draftBody());
    expect(created.status).toBe(200);
    expect(created.headers.get('cache-control')).toBe('no-store');
    const createdOverview = parseOverview(await created.json());
    expect(createdOverview).toMatchObject({
      productId,
      validationScope: 'local',
      upstreamVerified: false,
      activeVersion: null,
      versions: [],
      draft: {
        productId,
        provider: 'yangmao',
        productCode: 'YM-1001',
        fulfillmentMode: 'B',
        deductionUnit: 'pack',
        version: 1,
        validatedVersion: null,
        validatedAt: null,
        activeVersionId: null,
      },
    });

    const updated = await admin.put(
      mappingPath(productId, '/draft'),
      draftBody({
        expectedVersion: 1,
        productCode: 'YM-2002',
        fulfillmentMode: 'D',
        deductionUnit: 'amount',
      }),
    );
    expect(updated.status).toBe(200);
    const updatedOverview = parseOverview(await updated.json());
    expect(updatedOverview.draft).toMatchObject({
      productCode: 'YM-2002',
      fulfillmentMode: 'D',
      deductionUnit: 'amount',
      version: 2,
      validatedVersion: null,
    });

    const stale = await admin.put(
      mappingPath(productId, '/draft'),
      draftBody({ expectedVersion: 1, productCode: 'YM-3003' }),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: 'MAPPING_VERSION_CONFLICT',
      message: '映射草稿版本已变化，请刷新后重试',
    });
    expect((await fetchOverview(productId)).draft).toMatchObject({
      productCode: 'YM-2002',
      version: 2,
    });
  });

  it('rejects a second create with expectedVersion null', async () => {
    const productId = await createProduct('MAP-API-1');
    expect((await admin.put(mappingPath(productId, '/draft'), draftBody())).status).toBe(200);

    const duplicate = await admin.put(mappingPath(productId, '/draft'), draftBody());
    expect(duplicate.status).toBe(409);
    expect(duplicate.headers.get('cache-control')).toBe('no-store');
    expect(await duplicate.json()).toEqual({
      error: 'MAPPING_ALREADY_EXISTS',
      message: '供应商映射已存在，请按当前草稿版本更新',
    });
    expect(mappingRowCount(productId)).toBe(1);
  });

  it('returns 404 MAPPING_NOT_FOUND when updating, validating or activating without a mapping', async () => {
    const productId = await createProduct('MAP-API-1');

    const update = await admin.put(
      mappingPath(productId, '/draft'),
      draftBody({ expectedVersion: 1 }),
    );
    expect(update.status).toBe(404);
    expect(await update.json()).toEqual({
      error: 'MAPPING_NOT_FOUND',
      message: '供应商映射不存在',
    });

    for (const action of ['/validate', '/activate']) {
      const response = await admin.post(mappingPath(productId, action), { version: 1 });
      expect(response.status, action).toBe(404);
      expect(await response.json()).toEqual({
        error: 'MAPPING_NOT_FOUND',
        message: '供应商映射不存在',
      });
    }
  });

  it('rejects unknown fields and client-supplied actor fields with 400', async () => {
    const productId = await createProduct('MAP-API-1');

    const unknownSave = await admin.put(
      mappingPath(productId, '/draft'),
      draftBody({ actorAccountId: adminId }),
    );
    expect(unknownSave.status).toBe(400);
    const unknownSaveBody = (await unknownSave.json()) as Record<string, unknown>;
    expect(unknownSaveBody.error).toBe('INVALID_REQUEST');
    expect(unknownSaveBody.fields).toContain('actorAccountId');
    expect(JSON.stringify(unknownSaveBody)).not.toContain(adminId);
    expect(mappingRowCount(productId)).toBe(0);

    expect((await admin.put(mappingPath(productId, '/draft'), draftBody())).status).toBe(200);

    const validateActor = await admin.post(mappingPath(productId, '/validate'), {
      version: 1,
      actor: adminId,
    });
    expect(validateActor.status).toBe(400);
    expect(((await validateActor.json()) as { fields: string[] }).fields).toContain('actor');

    const activateActor = await admin.post(mappingPath(productId, '/activate'), {
      version: 1,
      activatedBy: adminId,
    });
    expect(activateActor.status).toBe(400);
    expect(((await activateActor.json()) as { fields: string[] }).fields).toContain('activatedBy');

    const unknownOption = await admin.put(
      mappingPath(productId, '/draft'),
      draftBody({ expectedVersion: 1, provider: 'other' }),
    );
    expect(unknownOption.status).toBe(400);
    expect((await unknownOption.json()) as { error: string }).toMatchObject({
      error: 'INVALID_REQUEST',
    });
  });

  it('rejects malformed or contract-invalid JSON bodies with 400 INVALID_REQUEST', async () => {
    const productId = await createProduct('MAP-API-1');
    const csrfToken = admin.cookie('bh_csrf');
    expect(csrfToken).toBeDefined();

    const malformed = await admin.request(mappingPath(productId, '/draft'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken ?? '' },
      body: '{"provider":',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: 'INVALID_REQUEST',
      message: '请求格式不正确',
    });

    const missingVersion = await admin.post(mappingPath(productId, '/validate'), {});
    expect(missingVersion.status).toBe(400);
    const missingVersionBody = (await missingVersion.json()) as Record<string, unknown>;
    expect(missingVersionBody.error).toBe('INVALID_REQUEST');
    expect(missingVersionBody.fields).toContain('version');
  });
});

describe('mapping local validation over HTTP', () => {
  it('records local validation only and always reports upstreamVerified false', async () => {
    const productId = await createProduct('MAP-API-1');
    expect((await admin.put(mappingPath(productId, '/draft'), draftBody())).status).toBe(200);

    const validated = await admin.post(mappingPath(productId, '/validate'), { version: 1 });
    expect(validated.status).toBe(200);
    expect(validated.headers.get('cache-control')).toBe('no-store');
    const overview = parseOverview(await validated.json());
    expect(overview).toMatchObject({
      validationScope: 'local',
      upstreamVerified: false,
      activeVersion: null,
      versions: [],
    });
    expect(overview.draft).toMatchObject({ version: 1, validatedVersion: 1 });
    expect(overview.draft?.validatedAt).toEqual(expect.any(Number));

    expect(
      server.database.sqlite
        .prepare(
          'SELECT validated_version, validated_at FROM supplier_product_mappings WHERE product_id = ?',
        )
        .get(productId),
    ).toMatchObject({ validated_version: 1 });
  });

  it('returns 422 with stable local issue codes and no submitted values', async () => {
    const productId = await createProduct('MAP-API-1');
    // Saving an inconsistent pairing is allowed; only activation requires
    // validation, so this is the real draft-correction flow.
    const saved = await admin.put(
      mappingPath(productId, '/draft'),
      draftBody({ fulfillmentMode: 'D', deductionUnit: 'pack' }),
    );
    expect(saved.status).toBe(200);

    const failed = await admin.post(mappingPath(productId, '/validate'), { version: 1 });
    expect(failed.status).toBe(422);
    expect(failed.headers.get('cache-control')).toBe('no-store');
    const body = parseError(await failed.json());
    expect(body).toEqual({
      error: 'MAPPING_VALIDATION_FAILED',
      message: '映射草稿未通过本地校验',
      issues: ['deduction_unit_mismatch'],
    });
    expect(JSON.stringify(body)).not.toContain('pack');
    expect(JSON.stringify(body)).not.toContain('YM-1001');

    const overview = await fetchOverview(productId);
    expect(overview.draft).toMatchObject({ version: 1, validatedVersion: null });
    expect(overview.activeVersion).toBeNull();
  });

  it('invalidates the local validation fact when the draft is edited', async () => {
    const productId = await createProduct('MAP-API-1');
    await admin.put(mappingPath(productId, '/draft'), draftBody());
    expect((await admin.post(mappingPath(productId, '/validate'), { version: 1 })).status).toBe(200);

    const edited = await admin.put(
      mappingPath(productId, '/draft'),
      draftBody({ expectedVersion: 1, productCode: 'YM-2002' }),
    );
    expect(edited.status).toBe(200);
    const editedOverview = parseOverview(await edited.json());
    expect(editedOverview.draft).toMatchObject({
      productCode: 'YM-2002',
      version: 2,
      validatedVersion: null,
      validatedAt: null,
    });

    const activation = await admin.post(mappingPath(productId, '/activate'), { version: 2 });
    expect(activation.status).toBe(409);
    expect(await activation.json()).toEqual({
      error: 'MAPPING_NOT_VALIDATED',
      message: '当前草稿版本尚未通过本地校验，不能激活',
    });

    const staleValidation = await admin.post(mappingPath(productId, '/validate'), { version: 1 });
    expect(staleValidation.status).toBe(409);
    expect((await staleValidation.json()) as { error: string }).toMatchObject({
      error: 'MAPPING_VERSION_CONFLICT',
    });
  });
});

describe('mapping activation over HTTP', () => {
  it('refuses to activate before local validation', async () => {
    const productId = await createProduct('MAP-API-1');
    await admin.put(mappingPath(productId, '/draft'), draftBody());

    const response = await admin.post(mappingPath(productId, '/activate'), { version: 1 });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'MAPPING_NOT_VALIDATED',
      message: '当前草稿版本尚未通过本地校验，不能激活',
    });
    expect((await fetchOverview(productId)).versions).toEqual([]);
  });

  it('activates with the authenticated admin actor and returns the new overview', async () => {
    const productId = await createProduct('MAP-API-1');
    await admin.put(mappingPath(productId, '/draft'), draftBody());
    await admin.post(mappingPath(productId, '/validate'), { version: 1 });

    const activated = await admin.post(mappingPath(productId, '/activate'), { version: 1 });
    expect(activated.status).toBe(200);
    const overview = parseOverview(await activated.json());
    const activeVersion = overview.activeVersion;
    expect(activeVersion).toMatchObject({
      productId,
      versionNumber: 1,
      provider: 'yangmao',
      productCode: 'YM-1001',
      fulfillmentMode: 'B',
      deductionUnit: 'pack',
      sourceDraftVersion: 1,
      activatedBy: adminId,
    });
    expect(overview.versions).toEqual([activeVersion]);
    expect(overview.draft).toMatchObject({
      version: 2,
      validatedVersion: null,
      validatedAt: null,
      activeVersionId: activeVersion?.id,
    });
    expect(overview.validationScope).toBe('local');
    expect(overview.upstreamVerified).toBe(false);

    // The server, not the client, wrote the actor reference.
    expect(
      server.database.sqlite
        .prepare('SELECT activated_by FROM supplier_product_mapping_versions WHERE id = ?')
        .get(activeVersion?.id),
    ).toEqual({ activated_by: adminId });

    const reread = await fetchOverview(productId);
    expect(reread.activeVersion).toEqual(activeVersion);
    expect(reread.versions).toHaveLength(1);
  });

  it('returns MAPPING_VERSION_CONFLICT for stale validation and activation', async () => {
    const productId = await createProduct('MAP-API-1');
    await admin.put(mappingPath(productId, '/draft'), draftBody());
    await admin.post(mappingPath(productId, '/validate'), { version: 1 });
    expect((await admin.post(mappingPath(productId, '/activate'), { version: 1 })).status).toBe(200);

    await admin.put(
      mappingPath(productId, '/draft'),
      draftBody({ expectedVersion: 2, productCode: 'YM-2002' }),
    );
    expect((await admin.post(mappingPath(productId, '/validate'), { version: 3 })).status).toBe(200);

    const second = await admin.post(mappingPath(productId, '/activate'), { version: 3 });
    expect(second.status).toBe(200);
    const secondOverview = parseOverview(await second.json());
    expect(secondOverview.versions.map((version) => version.versionNumber)).toEqual([1, 2]);
    expect(secondOverview.activeVersion).toMatchObject({
      versionNumber: 2,
      productCode: 'YM-2002',
      sourceDraftVersion: 3,
    });

    const replay = await admin.post(mappingPath(productId, '/activate'), { version: 3 });
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({
      error: 'MAPPING_VERSION_CONFLICT',
      message: '映射草稿版本已变化，请刷新后重试',
    });

    const staleValidate = await admin.post(mappingPath(productId, '/validate'), { version: 3 });
    expect(staleValidate.status).toBe(409);
    expect((await staleValidate.json()) as { error: string }).toMatchObject({
      error: 'MAPPING_VERSION_CONFLICT',
    });

    const overview = await fetchOverview(productId);
    expect(overview.versions).toHaveLength(2);
    expect(mappingRowCount(productId)).toBe(1);
  });
});

describe('mapping write CSRF boundary', () => {
  it('continues to require the double-submit token and a same-origin request', async () => {
    const productId = await createProduct('MAP-API-1');

    const withoutToken = await admin.request(mappingPath(productId, '/draft'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(draftBody()),
    });
    expect(withoutToken.status).toBe(403);
    expect(await withoutToken.json()).toEqual({
      error: 'CSRF_TOKEN_INVALID',
      message: '请求校验失败，请刷新页面后重试',
    });

    const csrfToken = admin.cookie('bh_csrf');
    expect(csrfToken).toBeDefined();
    const crossOrigin = await admin.request(mappingPath(productId, '/draft'), {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrfToken ?? '',
        origin: 'https://evil.example',
      },
      body: JSON.stringify(draftBody()),
    });
    expect(crossOrigin.status).toBe(403);
    expect(await crossOrigin.json()).toEqual({
      error: 'CSRF_ORIGIN_REJECTED',
      message: '请求来源校验失败',
    });
    expect(mappingRowCount(productId)).toBe(0);
  });
});
