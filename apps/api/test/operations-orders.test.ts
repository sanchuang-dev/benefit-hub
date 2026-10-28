import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  operationsOrderDetailResponseSchema,
  operationsOrderErrorResponseSchema,
  operationsOrderListResponseSchema,
  type OperationsOrderDetailResponse,
  type OperationsOrderErrorResponse,
  type OperationsOrderListResponse,
} from '@sanchuang-dev/benefit-contracts';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openDatabase, runMigrations } from '../src/db/client.js';
import { migrations } from '../src/db/migrations.js';
import { createAdminAccount } from '../src/modules/auth/admin-operations.js';
import { createProduct, updateProduct } from '../src/modules/catalog/products.js';
import { createSupplierMappingRepository } from '../src/modules/catalog/supplier-mapping-repository.js';
import type { FulfillmentMode } from '../src/modules/orders/benefit-orders.js';
import { createBenefitOrderRepository } from '../src/modules/orders/repository.js';
import { seedAccount, TEST_PASSWORD, TestClient, TestServer } from './helpers/test-server.js';

const LIST = '/api/v1/operations/orders';

/** Explicitly fictional machine tokens; they exist only in this test file. */
const TOKEN_LOCAL = 'fictional-operations-local-token-0000001';
const TOKEN_DOCTOR = 'fictional-operations-doctor-token-00002';

let server: TestServer | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

function clientsConfig(entries: Record<string, string>) {
  return loadConfig({
    DATABASE_FILE: ':memory:',
    BENEFIT_ORDER_CLIENTS_JSON: JSON.stringify(entries),
  }).businessOrderClients;
}

function startServer(
  entries: Record<string, string> = {
    'local-life': TOKEN_LOCAL,
    'card-doctor': TOKEN_DOCTOR,
  },
): TestServer {
  const testServer = new TestServer({ businessOrderClients: clientsConfig(entries) });
  server = testServer;
  return testServer;
}

function seedProduct(testServer: TestServer, code: string, name = `运营订单测试商品 ${code}`) {
  return createProduct(testServer.database.db, {
    code,
    name,
    actorAccountId: 'test-actor',
  });
}

/** Saves, validates and activates a mapping; calling again rotates it. */
function activateMapping(
  testServer: TestServer,
  productId: string,
  options: { mode: FulfillmentMode; productCode: string },
) {
  const repository = createSupplierMappingRepository(testServer.database.db);
  const current = repository.getDraft(productId);
  const draft = repository.saveDraft({
    productId,
    expectedVersion: current?.version ?? null,
    provider: 'yangmao',
    productCode: options.productCode,
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

function createOrder(
  testServer: TestServer,
  input: { businessSource: string; businessOrderNo: string; productId: string },
) {
  return createBenefitOrderRepository(testServer.database.db).createOrGetIntent(input).order;
}

function setCreatedAt(testServer: TestServer, orderId: string, createdAt: number): void {
  // Test-only seeding so pagination has deterministic timestamps; createdAt is
  // not part of the frozen order binding.
  testServer.database.sqlite
    .prepare('UPDATE benefit_orders SET created_at = ? WHERE id = ?')
    .run(createdAt, orderId);
}

function countRows(testServer: TestServer, table: string): number {
  const row = testServer.database.sqlite
    .prepare(`SELECT COUNT(*) AS value FROM ${table}`)
    .get() as { value: number };
  return row.value;
}

async function signIn(
  testServer: TestServer,
  role: 'admin' | 'viewer' = 'admin',
): Promise<TestClient> {
  await seedAccount(testServer, { username: `${role}.operations`, role });
  const client = new TestClient(testServer);
  const response = await client.login(`${role}.operations`, TEST_PASSWORD);
  expect(response.status).toBe(200);
  return client;
}

function parseList(body: unknown): OperationsOrderListResponse {
  const parsed = operationsOrderListResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      `List response does not match the shared contract: ${parsed.error.message} :: ${JSON.stringify(body)}`,
    );
  }
  return parsed.data;
}

function parseDetail(body: unknown): OperationsOrderDetailResponse {
  const parsed = operationsOrderDetailResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`Detail response does not match the shared contract: ${parsed.error.message}`);
  }
  return parsed.data;
}

function parseOrderError(body: unknown): OperationsOrderErrorResponse {
  const parsed = operationsOrderErrorResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error(`Error body does not match the shared contract: ${parsed.error.message}`);
  }
  return parsed.data;
}

function expectNoStore(response: Response) {
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('access-control-allow-origin')).toBeNull();
}

describe('operations order authentication boundary', () => {
  it('requires a valid admin session and never accepts a machine Bearer token', async () => {
    const testServer = startServer();
    const product = seedProduct(testServer, 'OPS-AUTH');
    activateMapping(testServer, product.id, { mode: 'B', productCode: 'YM-AUTH' });
    const order = createOrder(testServer, {
      businessSource: 'local-life',
      businessOrderNo: 'AUTH-1',
      productId: product.id,
    });

    const anonymousList = await testServer.app.request(LIST);
    expect(anonymousList.status).toBe(401);
    expectNoStore(anonymousList);
    expect(parseOrderError(await anonymousList.json()).error).toBe('UNAUTHENTICATED');

    const anonymousDetail = await testServer.app.request(`${LIST}/${order.id}`);
    expect(anonymousDetail.status).toBe(401);

    // A real, configured service credential is still not operator authorization.
    for (const path of [LIST, `${LIST}/${order.id}`]) {
      const machine = await testServer.app.request(path, {
        headers: { authorization: `Bearer ${TOKEN_LOCAL}` },
      });
      expect(machine.status, path).toBe(401);
      expectNoStore(machine);
      expect(parseOrderError(await machine.json()).error).toBe('UNAUTHENTICATED');
    }

    const admin = await signIn(testServer, 'viewer');
    const authorized = await admin.request(LIST);
    expect(authorized.status).toBe(200);
    expectNoStore(authorized);
    expect(parseList(await authorized.json()).total).toBe(1);

    // Expired persisted sessions are rejected independently of the cookie shape.
    testServer.database.sqlite
      .prepare('UPDATE admin_sessions SET expires_at = ?')
      .run(Date.now() - 1_000);
    const expired = await admin.request(LIST);
    expect(expired.status).toBe(401);
    expectNoStore(expired);
    expect(parseOrderError(await expired.json()).error).toBe('SESSION_EXPIRED');
  });
});

describe('operations order list', () => {
  it('pages and filters persisted SQLite orders deterministically without writes', async () => {
    const testServer = startServer();
    const product = seedProduct(testServer, 'OPS-LIST');
    activateMapping(testServer, product.id, { mode: 'B', productCode: 'YM-LIST' });
    const admin = await signIn(testServer);
    const repository = createBenefitOrderRepository(testServer.database.db);

    const base = Date.UTC(2026, 9, 20, 1, 0, 0);
    const orders = Array.from({ length: 12 }, (_, index) => {
      const businessSource = index < 6 ? 'local-life' : 'card-doctor';
      const businessOrderNo = `${index < 6 ? 'LO' : 'CD'}-${index + 1}`;
      const order = createOrder(testServer, { businessSource, businessOrderNo, productId: product.id });
      setCreatedAt(testServer, order.id, base + index * 1_000);
      return order;
    });
    // A non-pending status proves the status filter is a real predicate.
    repository.updateStatus({
      orderId: orders[7]!.id,
      expectedVersion: 1,
      status: 'processing',
    });

    const roombefore = {
      orders: countRows(testServer, 'benefit_orders'),
      events: countRows(testServer, 'benefit_order_status_events'),
      attempts: countRows(testServer, 'fulfillment_attempts'),
    };

    const firstResponse = await admin.request(LIST);
    expect(firstResponse.status).toBe(200);
    expectNoStore(firstResponse);
    const first = parseList(await firstResponse.json());
    expect(first.page).toBe(1);
    expect(first.pageSize).toBe(20);
    expect(first.total).toBe(12);
    // createdAt DESC, then id DESC: the newest seeded order comes first.
    expect(first.orders.map((order) => order.id)).toEqual(
      [...orders].reverse().map((order) => order.id),
    );
    expect(first.orders[0]).toEqual({
      id: orders[11]!.id,
      businessSource: 'card-doctor',
      businessOrderNo: 'CD-12',
      productId: product.id,
      productName: '运营订单测试商品 OPS-LIST',
      status: 'pending',
      version: 1,
      fulfillmentMode: 'B',
      mappingVersionId: orders[11]!.mappingVersionId,
      createdAt: base + 11_000,
      updatedAt: orders[11]!.updatedAt,
    });

    const secondPage = parseList(
      await (
        await admin.request(`${LIST}?page=2&pageSize=10`)
      ).json(),
    );
    expect(secondPage.page).toBe(2);
    expect(secondPage.pageSize).toBe(10);
    expect(secondPage.total).toBe(12);
    expect(secondPage.orders.map((order) => order.id)).toEqual([
      orders[1]!.id,
      orders[0]!.id,
    ]);

    const beyondLastPage = parseList(
      await (await admin.request(`${LIST}?page=9&pageSize=10`)).json(),
    );
    expect(beyondLastPage.total).toBe(12);
    expect(beyondLastPage.orders).toEqual([]);

    // Source filter is exact but accepts case-insensitive operator input.
    const bySource = parseList(
      await (await admin.request(`${LIST}?businessSource=LOCAL-LIFE`)).json(),
    );
    expect(bySource.total).toBe(6);
    expect(new Set(bySource.orders.map((order) => order.businessSource))).toEqual(
      new Set(['local-life']),
    );

    // Business order number is an exact identifier, not an unindexed substring scan.
    const exactNumber = parseList(
      await (await admin.request(`${LIST}?businessOrderNo=LO-3`)).json(),
    );
    expect(exactNumber.total).toBe(1);
    expect(exactNumber.orders[0]?.id).toBe(orders[2]!.id);
    const partialNumber = parseList(
      await (await admin.request(`${LIST}?businessOrderNo=LO-`)).json(),
    );
    expect(partialNumber.total).toBe(0);

    const byStatus = parseList(await (await admin.request(`${LIST}?status=processing`)).json());
    expect(byStatus.total).toBe(1);
    expect(byStatus.orders[0]).toMatchObject({
      id: orders[7]!.id,
      status: 'processing',
      version: 2,
    });

    const byCreatedRange = parseList(
      await (
        await admin.request(
          `${LIST}?createdFrom=${base + 3_000}&createdTo=${base + 5_000}`,
        )
      ).json(),
    );
    expect(byCreatedRange.total).toBe(3);
    expect(byCreatedRange.orders.map((order) => order.id)).toEqual([
      orders[5]!.id,
      orders[4]!.id,
      orders[3]!.id,
    ]);

    // Filters combine independently rather than replacing one another.
    const combined = parseList(
      await (
        await admin.request(`${LIST}?businessSource=local-life&status=processing`)
      ).json(),
    );
    expect(combined.total).toBe(0);

    // Reads are side-effect free.
    expect({
      orders: countRows(testServer, 'benefit_orders'),
      events: countRows(testServer, 'benefit_order_status_events'),
      attempts: countRows(testServer, 'fulfillment_attempts'),
    }).toEqual(roombefore);
  });

  it('rejects invalid paging, status and date inputs with safe 400 responses', async () => {
    const testServer = startServer();
    const admin = await signIn(testServer);

    const cases: Array<{ query: string; field: string }> = [
      { query: 'page=0', field: 'page' },
      { query: 'page=1.5', field: 'page' },
      { query: 'page=1000000001', field: 'page' },
      { query: 'pageSize=13', field: 'pageSize' },
      { query: 'pageSize=abc', field: 'pageSize' },
      { query: 'status=delivered', field: 'status' },
      { query: 'createdFrom=abc', field: 'createdFrom' },
      { query: 'createdFrom=', field: 'createdFrom' },
      { query: 'createdFrom=9007199254740992', field: 'createdFrom' },
      { query: 'createdFrom=2000&createdTo=1000', field: 'createdTo' },
      { query: 'businessSource=bad%20source', field: 'businessSource' },
      { query: 'businessOrderNo=has%20space', field: 'businessOrderNo' },
    ];

    for (const { query, field } of cases) {
      const response = await admin.request(`${LIST}?${query}`);
      expect(response.status, query).toBe(400);
      expectNoStore(response);
      const body = (await response.json()) as { error: string; fields?: string[] };
      expect(body.error, query).toBe('INVALID_REQUEST');
      expect(body.fields, query).toContain(field);
      expect(body).not.toHaveProperty('orders');
    }

    const unknownOrder = await admin.request(`${LIST}/missing-order`);
    expect(unknownOrder.status).toBe(404);
    expectNoStore(unknownOrder);
    expect(parseOrderError(await unknownOrder.json()).error).toBe('ORDER_NOT_FOUND');

    for (const malformedId of ['%20', 'x'.repeat(129)]) {
      const response = await admin.request(`${LIST}/${malformedId}`);
      expect(response.status, malformedId).toBe(400);
      const body = (await response.json()) as { error: string; fields?: string[] };
      expect(body.error).toBe('INVALID_REQUEST');
      expect(body.fields).toContain('orderId');
    }
  });
});

describe('operations order detail provenance', () => {
  it('uses the frozen mapping version and the current product name, never re-resolution', async () => {
    const testServer = startServer();
    const product = seedProduct(testServer, 'OPS-DETAIL', '旧商品名称');
    const firstVersion = activateMapping(testServer, product.id, {
      mode: 'B',
      productCode: 'YM-DETAIL-OLD',
    });
    const admin = await signIn(testServer);
    const repository = createBenefitOrderRepository(testServer.database.db);

    const order = createOrder(testServer, {
      businessSource: 'local-life',
      businessOrderNo: 'DETAIL-1',
      productId: product.id,
    });

    // Rotate the mapping and rename the product after the order exists.
    const secondVersion = activateMapping(testServer, product.id, {
      mode: 'D',
      productCode: 'YM-DETAIL-NEW',
    });
    expect(secondVersion.id).not.toBe(firstVersion.id);
    updateProduct(
      testServer.database.db,
      product.id,
      product.version,
      { name: '新商品名称' },
      'test-actor',
    );

    const response = await admin.request(`${LIST}/${order.id}`);
    expect(response.status).toBe(200);
    expectNoStore(response);
    const rawBody = await response.text();
    for (const forbidden of ['password_hash', 'appSecret', 'app_secret', 'dispatchStatus', 'balance']) {
      expect(rawBody).not.toContain(forbidden);
    }
    const detail = parseDetail(JSON.parse(rawBody) as unknown).order;

    expect(detail).toMatchObject({
      id: order.id,
      businessSource: 'local-life',
      businessOrderNo: 'DETAIL-1',
      productId: product.id,
      status: 'pending',
      version: 1,
      fulfillmentMode: 'B',
      mappingVersionId: firstVersion.id,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    });
    // The product block is the current row and must be labelled as such by the UI.
    expect(detail.product).toEqual({
      id: product.id,
      code: 'OPS-DETAIL',
      name: '新商品名称',
      status: 'active',
    });
    expect(detail.frozenMapping).toEqual({
      id: firstVersion.id,
      mappingId: firstVersion.mappingId,
      versionNumber: firstVersion.versionNumber,
      provider: 'yangmao',
      productCode: 'YM-DETAIL-OLD',
      fulfillmentMode: 'B',
      deductionUnit: 'pack',
      activatedAt: firstVersion.activatedAt,
    });
    expect(detail.statusEvents).toEqual([
      {
        id: expect.any(String),
        status: 'pending',
        version: 1,
        createdAt: order.createdAt,
      },
    ]);
    expect(detail.attempts).toEqual([]);

    // Record exactly what the repository stored; the API may not embellish it.
    const occurredAt = Date.UTC(2026, 9, 21, 2, 0, 0);
    repository.updateStatus({
      orderId: order.id,
      expectedVersion: 1,
      status: 'processing',
    });
    repository.appendAttempt({
      orderId: order.id,
      operation: 'query',
      result: 'accepted',
      observedStatus: 'processing',
      upstreamRequestNo: 'REQ-FICTIONAL-1',
      upstreamOrderNo: 'UPSTREAM-FICTIONAL-1',
      occurredAt,
      lastVerifiedAt: occurredAt + 5_000,
    });

    const updated = parseDetail(
      await (await admin.request(`${LIST}/${order.id}`)).json(),
    ).order;
    expect(updated.status).toBe('processing');
    expect(updated.version).toBe(2);
    expect(updated.statusEvents.map((event) => [event.status, event.version])).toEqual([
      ['pending', 1],
      ['processing', 2],
    ]);
    expect(updated.attempts).toEqual([
      {
        id: expect.any(String),
        operation: 'query',
        result: 'accepted',
        observedStatus: 'processing',
        upstreamRequestNo: 'REQ-FICTIONAL-1',
        upstreamOrderNo: 'UPSTREAM-FICTIONAL-1',
        occurredAt,
        lastVerifiedAt: occurredAt + 5_000,
      },
    ]);
    expect(updated.frozenMapping?.id).toBe(firstVersion.id);
  });

  it('keeps a pre-mapping legacy order honest instead of guessing provenance', () => {
    const directory = mkdtempSync(join(tmpdir(), 'benefit-hub-legacy-'));
    const file = join(directory, 'legacy.sqlite');
    const handle = openDatabase(file);

    try {
      // Simulate a database that existed before migration 0005: the nullable
      // column is added later, so this row can legitimately have no snapshot.
      runMigrations(handle.sqlite, migrations.slice(0, 4));
      const product = createProduct(handle.db, {
        code: 'LEGACY-ORDER',
        name: '历史订单商品（当前名称）',
        actorAccountId: 'test-actor',
      });
      const createdAt = Date.UTC(2026, 8, 1, 0, 0, 0);
      handle.sqlite
        .prepare(
          `INSERT INTO benefit_orders
             (id, business_source, business_order_no, product_id, fulfillment_mode, status, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'legacy-order-1',
          'local-life',
          'LEGACY-1',
          product.id,
          'B',
          'pending',
          1,
          createdAt,
          createdAt,
        );
      handle.sqlite
        .prepare(
          `INSERT INTO benefit_order_status_events
             (id, order_id, status, version, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('legacy-event-1', 'legacy-order-1', 'pending', 1, createdAt);
      runMigrations(handle.sqlite);

      const repository = createBenefitOrderRepository(handle.db);
      const detail = repository.getForOperations('legacy-order-1');
      expect(detail).not.toBeNull();
      expect(detail?.order.mappingVersionId).toBeNull();
      expect(detail?.frozenMapping).toBeNull();
      expect(detail?.currentProduct.name).toBe('历史订单商品（当前名称）');
      expect(detail?.statusEvents).toHaveLength(1);
      expect(detail?.attempts).toEqual([]);

      const list = repository.listForOperations({ page: 1, pageSize: 10 });
      expect(list.total).toBe(1);
      expect(list.orders[0]?.order.mappingVersionId).toBeNull();
      expect(list.orders[0]?.currentProductName).toBe('历史订单商品（当前名称）');

      // The read surface must stay usable without a fitting: it is not a write.
      expect(countRowsFromHandle(handle.sqlite, 'benefit_orders')).toBe(1);
    } finally {
      handle.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('serves the legacy row through the HTTP detail endpoint with a null frozen mapping', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'benefit-hub-legacy-http-'));
    const file = join(directory, 'legacy.sqlite');
    const handle = openDatabase(file);

    try {
      runMigrations(handle.sqlite, migrations.slice(0, 4));
      const product = createProduct(handle.db, {
        code: 'LEGACY-HTTP',
        name: '历史接口商品',
        actorAccountId: 'test-actor',
      });
      const createdAt = Date.UTC(2026, 8, 2, 0, 0, 0);
      handle.sqlite
        .prepare(
          `INSERT INTO benefit_orders
             (id, business_source, business_order_no, product_id, fulfillment_mode, status, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'legacy-http-order',
          'local-life',
          'LEGACY-HTTP-1',
          product.id,
          'A',
          'pending',
          1,
          createdAt,
          createdAt,
        );
      handle.sqlite
        .prepare(
          `INSERT INTO benefit_order_status_events
             (id, order_id, status, version, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('legacy-http-event', 'legacy-http-order', 'pending', 1, createdAt);
      runMigrations(handle.sqlite);

      const config = loadConfig({ DATABASE_FILE: file, NODE_ENV: 'test' });
      const app = createApp({ db: handle.db, config });
      await createAdminAccount(handle.db, {
        username: 'legacy.admin',
        password: TEST_PASSWORD,
        role: 'admin',
      });

      // Log in through the real Hono app and carry the issued cookie manually.
      const csrfResponse = await app.request('/api/v1/auth/csrf');
      const csrf = (await csrfResponse.json()) as { csrfToken: string };
      const csrfCookie = csrfResponse.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      const loginResponse = await app.request('/api/v1/auth/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrf.csrfToken,
          cookie: csrfCookie,
        },
        body: JSON.stringify({ username: 'legacy.admin', password: TEST_PASSWORD }),
      });
      expect(loginResponse.status).toBe(200);
      const sessionCookie = loginResponse.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');

      const response = await app.request(`${LIST}/legacy-http-order`, {
        headers: { cookie: sessionCookie },
      });
      expect(response.status).toBe(200);
      expectNoStore(response);
      const detail = parseDetail(await response.json()).order;
      expect(detail.product.name).toBe('历史接口商品');
      expect(detail.mappingVersionId).toBeNull();
      expect(detail.frozenMapping).toBeNull();
      expect(detail.attempts).toEqual([]);
    } finally {
      handle.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function countRowsFromHandle(
  sqlite: ReturnType<typeof openDatabase>['sqlite'],
  table: string,
): number {
  const row = sqlite.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as { value: number };
  return row.value;
}

describe('existing order security boundaries remain intact', () => {
  it('keeps the business Bearer/CSRF exemption and cookie-admin CSRF gate while operations reads stay side-effect free', async () => {
    const testServer = startServer();
    const product = seedProduct(testServer, 'OPS-REGRESSION');
    activateMapping(testServer, product.id, { mode: 'B', productCode: 'YM-REG' });

    // Machine intake still works without a CSRF cookie or header.
    const created = await testServer.app.request('/api/v1/business/orders', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN_LOCAL}`,
      },
      body: JSON.stringify({ businessOrderNo: 'REG-1', productId: product.id }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { order: { id: string } };

    // Source scoping is unchanged: another token cannot read this order.
    const foreign = await testServer.app.request(
      `/api/v1/business/orders/${createdBody.order.id}`,
      { headers: { authorization: `Bearer ${TOKEN_DOCTOR}` } },
    );
    expect(foreign.status).toBe(404);

    // Cookie-based admin mutation still requires the double-submit token.
    const admin = await signIn(testServer);
    const withoutCsrf = await admin.request('/api/v1/catalog/products', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'CSRF-OPS-1', name: '缺少 CSRF 的商品' }),
    });
    expect(withoutCsrf.status).toBe(403);
    expect(((await withoutCsrf.json()) as { error: string }).error).toBe('CSRF_TOKEN_INVALID');

    // The new operator read is not a write path and does not enable issuance.
    const before = {
      orders: countRows(testServer, 'benefit_orders'),
      attempts: countRows(testServer, 'fulfillment_attempts'),
    };
    const list = await admin.request(LIST);
    expect(list.status).toBe(200);
    const listBody = parseList(await list.json());
    expect(listBody.orders.map((row) => row.id)).toContain(createdBody.order.id);
    expect(listBody.orders.find((row) => row.id === createdBody.order.id)?.status).toBe('pending');

    const detail = await admin.request(`${LIST}/${createdBody.order.id}`);
    expect(detail.status).toBe(200);
    const detailBody = parseDetail(await detail.json()).order;
    expect(detailBody.status).toBe('pending');
    expect(detailBody.attempts).toEqual([]);
    expect(detailBody.frozenMapping).not.toBeNull();
    expect({
      orders: countRows(testServer, 'benefit_orders'),
      attempts: countRows(testServer, 'fulfillment_attempts'),
    }).toEqual(before);

    const status = await testServer.app.request('/api/v1/system/status');
    expect(await status.json()).toMatchObject({ vendorFulfillmentEnabled: false });
  });
});
