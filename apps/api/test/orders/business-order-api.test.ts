import { afterEach, describe, expect, it } from 'vitest';
import { businessOrderErrorResponseSchema, businessOrderResponseSchema, createBusinessOrderResponseSchema, type BusinessOrderDto, type BusinessOrderErrorResponse, type CreateBusinessOrderResponse } from '@sanchuang-dev/benefit-contracts';
import { createProduct, getProduct, setProductStatus } from '../../src/modules/catalog/products.js';
import { createSupplierMappingRepository } from '../../src/modules/catalog/supplier-mapping-repository.js';
import type { FulfillmentMode } from '../../src/modules/orders/benefit-orders.js';
import { seedAccount, TEST_PASSWORD, TestClient, TestServer } from '../helpers/test-server.js';
import { clientsConfig, countRows, expectNoStoreCors } from '../helpers/api-fixtures.js';

const COLLECTION = '/api/v1/business/orders';

/** Explicitly fictional credentials. They exist only inside this test file. */
const TOKEN_LOCAL = 'fictional-local-life-order-token-00000001';
const TOKEN_DOCTOR = 'fictional-card-doctor-order-token-000002';

let server: TestServer | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});
function startServer(entries: Record<string, string> = {
  'local-life': TOKEN_LOCAL,
  'card-doctor': TOKEN_DOCTOR,
}): TestServer {
  const testServer = new TestServer({ businessOrderClients: clientsConfig(entries) });
  server = testServer;
  return testServer;
}

function seedProduct(testServer: TestServer, code: string) {
  return createProduct(testServer.database.db, {
    code,
    name: `业务订单测试商品 ${code}`,
    actorAccountId: 'test-actor',
  });
}

/** Saves, validates and activates a mapping; calling again rotates it. */
function activateMapping(
  testServer: TestServer,
  productId: string,
  options: { mode: FulfillmentMode; productCode?: string },
) {
  const repository = createSupplierMappingRepository(testServer.database.db);
  const current = repository.getDraft(productId);
  const draft = repository.saveDraft({
    productId,
    expectedVersion: current?.version ?? null,
    provider: 'yangmao',
    productCode: options.productCode ?? 'YM-ORDER-1',
    fulfillmentMode: options.mode,
    deductionUnit: options.mode === 'D' ? 'amount' : 'pack',
  });
  repository.validateDraft({ productId, expectedVersion: draft.version });
  return repository.activateDraft({
    productId,
    expectedVersion: draft.version,
    actorAccountId: 'test-actor',
  });
}

function disableProduct(testServer: TestServer, productId: string) {
  const product = getProduct(testServer.database.db, productId);
  if (!product) throw new Error(`Missing product ${productId}`);
  return setProductStatus(
    testServer.database.db,
    productId,
    'disabled',
    product.version,
    'test-actor',
  );
}

function orderRow(testServer: TestServer, orderId: string) {
  return testServer.database.sqlite
    .prepare(
      `SELECT business_source, business_order_no, product_id, fulfillment_mode, status, version,
              mapping_version_id
         FROM benefit_orders WHERE id = ?`,
    )
    .get(orderId) as Record<string, unknown> | undefined;
}

async function postOrder(
  token: string | null,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json', ...extraHeaders });
  if (token !== null) headers.set('authorization', `Bearer ${token}`);
  return (server as TestServer).app.request(COLLECTION, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function getOrder(token: string | null, path: string): Promise<Response> {
  const headers = new Headers();
  if (token !== null) headers.set('authorization', `Bearer ${token}`);
  return (server as TestServer).app.request(path, { headers });
}

function parseCreate(body: unknown): CreateBusinessOrderResponse {
  const parsed = createBusinessOrderResponseSchema.safeParse(body);
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error('Create response does not match the shared contract');
  return parsed.data;
}

function parseRead(body: unknown): BusinessOrderDto {
  const parsed = businessOrderResponseSchema.safeParse(body);
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error('Read response does not match the shared contract');
  return parsed.data.order;
}

function parseError(body: unknown): BusinessOrderErrorResponse {
  const parsed = businessOrderErrorResponseSchema.safeParse(body);
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error('Error body does not match the shared contract');
  return parsed.data;
}
describe('downstream order service configuration boundary', () => {
  it('rejects every route with 503 and writes nothing when no client is configured', async () => {
    const testServer = new TestServer({ businessOrderClients: null });
    server = testServer;
    const product = seedProduct(testServer, 'YM-ORDER-1');
    activateMapping(testServer, product.id, { mode: 'B' });

    const requests: Array<{ path: string; init: RequestInit }> = [
      {
        path: COLLECTION,
        init: {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${TOKEN_LOCAL}`,
          },
          body: JSON.stringify({ businessOrderNo: 'LO-1001', productId: product.id }),
        },
      },
      {
        path: `${COLLECTION}?businessOrderNo=LO-1001`,
        init: { headers: { authorization: `Bearer ${TOKEN_LOCAL}` } },
      },
      {
        path: `${COLLECTION}/any-order`,
        init: { headers: { authorization: `Bearer ${TOKEN_LOCAL}` } },
      },
    ];

    for (const { path, init } of requests) {
      const response = await testServer.app.request(path, init);
      expect(response.status, path).toBe(503);
      expectNoStoreCors(response);
      expect(parseError(await response.json()).error).toBe('SERVICE_UNAVAILABLE');
    }

    expect(countRows(testServer, 'benefit_orders')).toBe(0);
    expect(countRows(testServer, 'benefit_order_status_events')).toBe(0);
  });

  it('never reveals a configured token in an authentication failure', async () => {
    startServer();
    const response = await getOrder('fictional-wrong-token-0000000000000000', COLLECTION);
    expect(response.status).toBe(401);
    expectNoStoreCors(response);
    const body = await response.json();
    expect(parseError(body)).toEqual({
      error: 'UNAUTHORIZED',
      message: '缺少或无效的服务凭证',
    });
    expect(JSON.stringify(body)).not.toContain(TOKEN_LOCAL);
  });
});

describe('downstream order service authentication', () => {
  it('requires a Bearer service credential and accepts no browser identity', async () => {
    const testServer = startServer();
    const product = seedProduct(testServer, 'YM-ORDER-1');
    activateMapping(testServer, product.id, { mode: 'B' });

    // Seed an operator session with a valid CSRF cookie to prove it is useless here.
    await seedAccount(testServer, { username: 'order.admin' });
    const admin = new TestClient(testServer);
    expect((await admin.login('order.admin', TEST_PASSWORD)).status).toBe(200);
    const csrfToken = admin.cookie('bh_csrf');
    expect(csrfToken).toBeDefined();

    const attempts: Array<{ label: string; path: string; init: RequestInit }> = [
      {
        label: 'missing header',
        path: COLLECTION,
        init: { headers: { 'content-type': 'application/json' } },
      },
      {
        label: 'wrong scheme',
        path: COLLECTION,
        init: {
          headers: { authorization: 'Basic abc', 'content-type': 'application/json' },
        },
      },
      {
        label: 'empty token',
        path: COLLECTION,
        init: { headers: { authorization: 'Bearer ', 'content-type': 'application/json' } },
      },
      {
        label: 'csrf cookie only',
        path: COLLECTION,
        init: {
          headers: {
            'content-type': 'application/json',
            cookie: `bh_csrf=${csrfToken};`,
          },
        },
      },
      {
        label: 'token in query',
        path: `${COLLECTION}?token=${TOKEN_LOCAL}`,
        init: { headers: { 'content-type': 'application/json' } },
      },
    ];
    for (const { label, path, init } of attempts) {
      const response = await testServer.app.request(path, {
        ...init,
        method: 'POST',
        body: JSON.stringify({ businessOrderNo: 'LO-1001', productId: product.id }),
      });
      expect(response.status, label).toBe(401);
      expectNoStoreCors(response);
      expect(parseError(await response.json()).error).toBe('UNAUTHORIZED');
    }

    // An authenticated admin cookie + CSRF token still cannot use the machine API.
    const cookieOnly = await admin.request(COLLECTION, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ businessOrderNo: 'LO-1001', productId: product.id }),
    });
    expect(cookieOnly.status).toBe(401);
    expect(parseError(await cookieOnly.json()).error).toBe('UNAUTHORIZED');

    expect(countRows(testServer, 'benefit_orders')).toBe(0);
  });

  it('does not accept a token supplied in the URL', async () => {
    startServer();
    const response = await getOrder(null, `${COLLECTION}?businessOrderNo=LO-1001&token=${TOKEN_LOCAL}`);
    expect(response.status).toBe(401);
  });
});

describe('downstream order creation and recovery', () => {
  it('creates one pending intent without CSRF cookies and replays it idempotently', async () => {
    const testServer = startServer();
    const product = seedProduct(testServer, 'YM-TRAVEL-10');
    const mappingVersion = activateMapping(testServer, product.id, { mode: 'B' });

    const createdResponse = await postOrder(TOKEN_LOCAL, {
      businessOrderNo: 'LO-1001',
      productId: product.id,
    });
    expect(createdResponse.status).toBe(201);
    expectNoStoreCors(createdResponse);
    // No bh_csrf cookie or X-CSRF-Token header was supplied at all.
    const created = parseCreate(await createdResponse.json());
    expect(created.created).toBe(true);
    expect(created.order).toMatchObject({
      businessSource: 'local-life',
      businessOrderNo: 'LO-1001',
      productId: product.id,
      status: 'pending',
      version: 1,
      fulfillmentMode: 'B',
      mappingVersionId: mappingVersion.id,
    });
    expect(created.order.id).not.toBe(created.order.businessOrderNo);
    expect(created.order.createdAt).toEqual(expect.any(Number));
    expect(created.order.updatedAt).toEqual(created.order.createdAt);

    expect(orderRow(testServer, created.order.id)).toEqual({
      business_source: 'local-life',
      business_order_no: 'LO-1001',
      product_id: product.id,
      fulfillment_mode: 'B',
      status: 'pending',
      version: 1,
      mapping_version_id: mappingVersion.id,
    });
    expect(countRows(testServer, 'benefit_orders')).toBe(1);
    expect(countRows(testServer, 'benefit_order_status_events')).toBe(1);
    // No upstream call may ever have happened: no attempt fact exists.
    expect(countRows(testServer, 'fulfillment_attempts')).toBe(0);

    const replayResponse = await postOrder(TOKEN_LOCAL, {
      businessOrderNo: 'LO-1001',
      productId: product.id,
    });
    expect(replayResponse.status).toBe(200);
    expectNoStoreCors(replayResponse);
    const replay = parseCreate(await replayResponse.json());
    expect(replay.created).toBe(false);
    expect(replay.order).toEqual(created.order);

    const byNumberResponse = await getOrder(
      TOKEN_LOCAL,
      `${COLLECTION}?businessOrderNo=LO-1001`,
    );
    expect(byNumberResponse.status).toBe(200);
    expectNoStoreCors(byNumberResponse);
    expect(parseRead(await byNumberResponse.json())).toEqual(created.order);

    const byIdResponse = await getOrder(TOKEN_LOCAL, `${COLLECTION}/${created.order.id}`);
    expect(byIdResponse.status).toBe(200);
    expectNoStoreCors(byIdResponse);
    expect(parseRead(await byIdResponse.json())).toEqual(created.order);

    expect(countRows(testServer, 'benefit_orders')).toBe(1);
    expect(countRows(testServer, 'benefit_order_status_events')).toBe(1);
    expect(countRows(testServer, 'fulfillment_attempts')).toBe(0);
  });

  it('serializes concurrent identical attempts into one row and one 201', async () => {
    const testServer = startServer();
    const product = seedProduct(testServer, 'YM-ORDER-1');
    activateMapping(testServer, product.id, { mode: 'B' });

    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        postOrder(TOKEN_LOCAL, { businessOrderNo: 'LO-RACE-1', productId: product.id }),
      ),
    );
    const results = await Promise.all(
      responses.map(async (response) => ({
        status: response.status,
        body: parseCreate(await response.json()),
      })),
    );

    expect(results.filter((result) => result.status === 201)).toHaveLength(1);
    expect(results.filter((result) => result.status === 200)).toHaveLength(3);
    expect(results.filter((result) => result.body.created)).toHaveLength(1);
    const ids = new Set(results.map((result) => result.body.order.id));
    expect(ids.size).toBe(1);
    expect(countRows(testServer, 'benefit_orders')).toBe(1);
    expect(countRows(testServer, 'benefit_order_status_events')).toBe(1);
  });
});

describe('downstream order tenant isolation', () => {
  it('does not let one source read or impersonate another source', async () => {
    const testServer = startServer();
    const product = seedProduct(testServer, 'YM-TRAVEL-10');
    activateMapping(testServer, product.id, { mode: 'B' });

    const local = parseCreate(
      await (
        await postOrder(TOKEN_LOCAL, { businessOrderNo: 'LO-1001', productId: product.id })
      ).json(),
    ).order;
    expect(local.businessSource).toBe('local-life');

    const foreignById = await getOrder(TOKEN_DOCTOR, `${COLLECTION}/${local.id}`);
    expect(foreignById.status).toBe(404);
    expectNoStoreCors(foreignById);
    const foreignByIdBody = await foreignById.json();
    expect(parseError(foreignByIdBody)).toEqual({
      error: 'ORDER_NOT_FOUND',
      message: '订单不存在',
    });
    // The rejection must not confirm that another business owns this id.
    expect(JSON.stringify(foreignByIdBody)).not.toContain(local.id);
    expect(JSON.stringify(foreignByIdBody)).not.toContain('local-life');

    const foreignByNumber = await getOrder(
      TOKEN_DOCTOR,
      `${COLLECTION}?businessOrderNo=LO-1001`,
    );
    expect(foreignByNumber.status).toBe(404);
    const foreignByNumberBody = await foreignByNumber.json();
    expect(parseError(foreignByNumberBody).error).toBe('ORDER_NOT_FOUND');
    expect(JSON.stringify(foreignByNumberBody)).not.toContain(local.id);

    // Per-source identity: the same number is a new intent for another source.
    const doctorResponse = await postOrder(TOKEN_DOCTOR, {
      businessOrderNo: 'LO-1001',
      productId: product.id,
    });
    expect(doctorResponse.status).toBe(201);
    const doctor = parseCreate(await doctorResponse.json()).order;
    expect(doctor.businessSource).toBe('card-doctor');
    expect(doctor.id).not.toBe(local.id);
    expect(countRows(testServer, 'benefit_orders')).toBe(2);

    // Each source recovers its own order for the same business order number.
    const localRead = parseRead(
      await (await getOrder(TOKEN_LOCAL, `${COLLECTION}?businessOrderNo=LO-1001`)).json(),
    );
    const doctorRead = parseRead(
      await (await getOrder(TOKEN_DOCTOR, `${COLLECTION}?businessOrderNo=LO-1001`)).json(),
    );
    expect(localRead.id).toBe(local.id);
    expect(doctorRead.id).toBe(doctor.id);
  });

  it('rejects caller-supplied identity or fulfillment fields in body and query', async () => {
    const testServer = startServer();
    const product = seedProduct(testServer, 'YM-ORDER-1');
    activateMapping(testServer, product.id, { mode: 'B' });

    const impersonation = await postOrder(TOKEN_DOCTOR, {
      businessOrderNo: 'LO-2002',
      productId: product.id,
      businessSource: 'local-life',
    });
    expect(impersonation.status).toBe(400);
    expect(parseError(await impersonation.json()).fields).toContain('businessSource');

    const modeInjection = await postOrder(TOKEN_DOCTOR, {
      businessOrderNo: 'LO-2003',
      productId: product.id,
      fulfillmentMode: 'D',
    });
    expect(modeInjection.status).toBe(400);
    expect(parseError(await modeInjection.json()).fields).toContain('fulfillmentMode');

    const queryInjection = await getOrder(
      TOKEN_DOCTOR,
      `${COLLECTION}?businessOrderNo=LO-2002&businessSource=local-life`,
    );
    expect(queryInjection.status).toBe(400);
    expect(parseError(await queryInjection.json()).fields).toContain('businessSource');

    expect(countRows(testServer, 'benefit_orders')).toBe(0);
  });
});

describe('downstream order failure semantics', () => {
  it('rejects malformed bodies and identifiers with 400 INVALID_REQUEST', async () => {
    const testServer = startServer();
    const product = seedProduct(testServer, 'YM-ORDER-1');
    activateMapping(testServer, product.id, { mode: 'B' });

    const malformed = await postOrder(TOKEN_LOCAL, '{"businessOrderNo":');
    expect(malformed.status).toBe(400);
    expect(parseError(await malformed.json()).error).toBe('INVALID_REQUEST');

    const missingProduct = await postOrder(TOKEN_LOCAL, { businessOrderNo: 'LO-1001' });
    expect(missingProduct.status).toBe(400);
    expect(parseError(await missingProduct.json()).fields).toContain('productId');

    const badNumber = await postOrder(TOKEN_LOCAL, {
      businessOrderNo: 'has space',
      productId: product.id,
    });
    expect(badNumber.status).toBe(400);
    expect(parseError(await badNumber.json()).fields).toContain('businessOrderNo');

    const missingQuery = await getOrder(TOKEN_LOCAL, COLLECTION);
    expect(missingQuery.status).toBe(400);
    expect(parseError(await missingQuery.json()).fields).toContain('businessOrderNo');

    expect(countRows(testServer, 'benefit_orders')).toBe(0);
  });

  it('maps conflicting product, unknown/disabled product and missing mapping safely', async () => {
    const testServer = startServer();
    const product = seedProduct(testServer, 'YM-TRAVEL-10');
    const otherProduct = seedProduct(testServer, 'YM-FOOD-20');
    const unmappedProduct = seedProduct(testServer, 'YM-NO-MAPPING');
    const disabledProduct = seedProduct(testServer, 'YM-DISABLED');
    activateMapping(testServer, product.id, { mode: 'B' });
    activateMapping(testServer, otherProduct.id, { mode: 'A' });
    activateMapping(testServer, disabledProduct.id, { mode: 'C' });
    disableProduct(testServer, disabledProduct.id);

    const first = await postOrder(TOKEN_LOCAL, {
      businessOrderNo: 'LO-1001',
      productId: product.id,
    });
    expect(first.status).toBe(201);
    const firstOrder = parseCreate(await first.json()).order;

    const conflict = await postOrder(TOKEN_LOCAL, {
      businessOrderNo: 'LO-1001',
      productId: otherProduct.id,
    });
    expect(conflict.status).toBe(409);
    expect(parseError(await conflict.json()).error).toBe('ORDER_INTENT_CONFLICT');
    expect(orderRow(testServer, firstOrder.id)).toMatchObject({
      product_id: product.id,
      mapping_version_id: firstOrder.mappingVersionId,
    });
    expect(countRows(testServer, 'benefit_orders')).toBe(1);

    const unknownProduct = await postOrder(TOKEN_LOCAL, {
      businessOrderNo: 'LO-1002',
      productId: 'missing-product',
    });
    expect(unknownProduct.status).toBe(404);
    expect(parseError(await unknownProduct.json()).error).toBe('PRODUCT_NOT_FOUND');

    const disabled = await postOrder(TOKEN_LOCAL, {
      businessOrderNo: 'LO-1003',
      productId: disabledProduct.id,
    });
    expect(disabled.status).toBe(409);
    expect(parseError(await disabled.json()).error).toBe('PRODUCT_NOT_ACTIVE');

    const unmapped = await postOrder(TOKEN_LOCAL, {
      businessOrderNo: 'LO-1004',
      productId: unmappedProduct.id,
    });
    expect(unmapped.status).toBe(409);
    expect(parseError(await unmapped.json()).error).toBe('ORDER_MAPPING_UNAVAILABLE');

    expect(countRows(testServer, 'benefit_orders')).toBe(1);
    expect(countRows(testServer, 'benefit_order_status_events')).toBe(1);
    expect(countRows(testServer, 'fulfillment_attempts')).toBe(0);
  });

  it('keeps the original frozen snapshot after mapping rotation and product disable', async () => {
    const testServer = startServer();
    const product = seedProduct(testServer, 'YM-TRAVEL-10');
    const firstVersion = activateMapping(testServer, product.id, {
      mode: 'B',
      productCode: 'YM-TRAVEL-B',
    });

    const created = parseCreate(
      await (
        await postOrder(TOKEN_LOCAL, { businessOrderNo: 'LO-1001', productId: product.id })
      ).json(),
    ).order;

    const secondVersion = activateMapping(testServer, product.id, {
      mode: 'D',
      productCode: 'YM-TRAVEL-D',
    });
    expect(secondVersion.id).not.toBe(firstVersion.id);

    const replayResponse = await postOrder(TOKEN_LOCAL, {
      businessOrderNo: 'LO-1001',
      productId: product.id,
    });
    expect(replayResponse.status).toBe(200);
    const replay = parseCreate(await replayResponse.json());
    expect(replay.created).toBe(false);
    expect(replay.order).toEqual(created);
    expect(replay.order.mappingVersionId).toBe(firstVersion.id);
    expect(replay.order.fulfillmentMode).toBe('B');

    const fresh = parseCreate(
      await (
        await postOrder(TOKEN_LOCAL, { businessOrderNo: 'LO-1002', productId: product.id })
      ).json(),
    ).order;
    expect(fresh.mappingVersionId).toBe(secondVersion.id);
    expect(fresh.fulfillmentMode).toBe('D');

    disableProduct(testServer, product.id);
    const replayAfterDisable = await postOrder(TOKEN_LOCAL, {
      businessOrderNo: 'LO-1001',
      productId: product.id,
    });
    expect(replayAfterDisable.status).toBe(200);
    expect(parseCreate(await replayAfterDisable.json()).order).toEqual(created);

    const readAfterDisable = await getOrder(TOKEN_LOCAL, `${COLLECTION}/${created.id}`);
    expect(readAfterDisable.status).toBe(200);
    expect(parseRead(await readAfterDisable.json())).toEqual(created);

    expect(countRows(testServer, 'benefit_orders')).toBe(2);
    expect(countRows(testServer, 'benefit_order_status_events')).toBe(2);
    expect(countRows(testServer, 'fulfillment_attempts')).toBe(0);
  });
});

describe('existing human API security is unchanged', () => {
  it('still rejects a cookie-based admin mutation without CSRF while vendor fulfillment stays off', async () => {
    const testServer = startServer();
    await seedAccount(testServer, { username: 'order.admin' });
    const admin = new TestClient(testServer);
    expect((await admin.login('order.admin', TEST_PASSWORD)).status).toBe(200);

    const withoutCsrf = await admin.request('/api/v1/catalog/products', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'CSRF-1', name: '缺少 CSRF 的商品' }),
    });
    expect(withoutCsrf.status).toBe(403);
    expect(((await withoutCsrf.json()) as { error: string }).error).toBe('CSRF_TOKEN_INVALID');

    const status = await testServer.app.request('/api/v1/system/status');
    expect(await status.json()).not.toHaveProperty('vendorFulfillmentEnabled');
  });
});
