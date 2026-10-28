import { afterEach, describe, expect, it } from 'vitest';
import {
  applicationDetailResponseSchema,
  applicationListResponseSchema,
  type ApplicationProductDto,
  type BusinessApplicationDto,
} from '@sanchuang-dev/benefit-contracts';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createProduct, setProductStatus } from '../src/modules/catalog/products.js';
import { createSupplierMappingRepository } from '../src/modules/catalog/supplier-mapping-repository.js';
import { seedAccount, TEST_PASSWORD, TestClient, TestServer } from './helpers/test-server.js';

const BASE = '/api/v1/applications';

/** Explicitly fictional downstream token; it exists only inside this test file. */
const FICTIONAL_ORDER_TOKEN = 'fictional-local-life-order-token-00000001';

const servers: TestServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

function startServer(overrides: Partial<AppConfig> = {}) {
  const server = new TestServer(overrides);
  servers.push(server);
  return server;
}

async function login(server: TestServer, username: string, role: 'admin' | 'viewer') {
  await seedAccount(server, { username, role });
  const client = new TestClient(server);
  expect((await client.login(username, TEST_PASSWORD)).status).toBe(200);
  return client;
}

async function createApplication(
  client: TestClient,
  input: Record<string, unknown>,
): Promise<BusinessApplicationDto> {
  const response = await client.post(BASE, input);
  expect(response.status).toBe(201);
  return ((await response.json()) as { application: BusinessApplicationDto }).application;
}

async function detail(client: TestClient, id: string) {
  const response = await client.request(`${BASE}/${id}`);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return applicationDetailResponseSchema.parse(await response.json());
}

function seedProduct(server: TestServer, code: string, name = `测试商品 ${code}`) {
  return createProduct(server.database.db, {
    code,
    name,
    actorAccountId: 'test-actor',
  });
}

function applicationEvents(server: TestServer, applicationId: string) {
  return server.database.sqlite
    .prepare(
      'SELECT action, actor_account_id FROM business_application_events WHERE application_id = ? ORDER BY created_at, rowid',
    )
    .all(applicationId) as { action: string; actor_account_id: string }[];
}

describe('application registry API authorization', () => {
  it('requires a session for reads and admin role plus CSRF for every write', async () => {
    const server = startServer();
    const admin = await login(server, 'app.admin', 'admin');
    const viewer = await login(server, 'app.viewer', 'viewer');

    const anonymous = await new TestClient(server).request(BASE);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('cache-control')).toBe('no-store');

    const anonymousDetail = await new TestClient(server).request(`${BASE}/missing-id`);
    expect(anonymousDetail.status).toBe(401);

    const created = await createApplication(admin, {
      businessSource: 'local-life',
      name: '本地生活',
    });

    for (const [path, method, body] of [
      [BASE, 'POST', { businessSource: 'card-doctor', name: '卡博士' }],
      [`${BASE}/${created.id}`, 'PATCH', { version: created.version, name: '越权重命名' }],
      [`${BASE}/${created.id}/disable`, 'POST', { version: created.version }],
      [`${BASE}/${created.id}/products`, 'PUT', { version: created.version, productIds: [] }],
    ] as const) {
      const response = await viewer.request(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(403);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }

    // A write without the double-submit token never reaches the route, even for admin.
    const withoutCsrf = await admin.request(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ businessSource: 'no-csrf', name: '无令牌' }),
    });
    expect(withoutCsrf.status).toBe(403);

    const list = await viewer.request(BASE);
    expect(list.status).toBe(200);
    expect(list.headers.get('cache-control')).toBe('no-store');
    const parsed = applicationListResponseSchema.parse(await list.json());
    expect(parsed.total).toBe(1);

    const rows = server.database.sqlite
      .prepare('SELECT business_source FROM business_applications')
      .all() as { business_source: string }[];
    expect(rows.map((row) => row.business_source)).toEqual(['local-life']);
  });
});

describe('application registration and edits', () => {
  it('normalizes the source, rejects duplicate identity, and never accepts a source rename', async () => {
    const server = startServer();
    const admin = await login(server, 'app.admin', 'admin');

    const application = await createApplication(admin, {
      businessSource: '  Local-Life  ',
      name: '本地生活',
      note: '首期接入',
    });
    expect(application).toMatchObject({
      businessSource: 'local-life',
      name: '本地生活',
      note: '首期接入',
      status: 'enabled',
      version: 1,
      configuredProductCount: 0,
      runtimeAuthorizationEnforced: false,
    });

    // The registered source is immutable at the database boundary, not only in
    // the HTTP schema.
    expect(() =>
      server.database.sqlite
        .prepare("UPDATE business_applications SET business_source = 'other-source' WHERE id = ?")
        .run(application.id),
    ).toThrow(/immutable/);

    const duplicate = await admin.post(BASE, {
      businessSource: 'LOCAL-LIFE',
      name: '重复来源',
    });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error).toBe('APPLICATION_SOURCE_CONFLICT');

    const invalid = await admin.post(BASE, {
      businessSource: 'Local Life',
      name: '非法来源',
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).fields).toContain('businessSource');

    const renameSource = await admin.patch(`${BASE}/${application.id}`, {
      version: application.version,
      businessSource: 'other-source',
      name: '改名',
    });
    expect(renameSource.status).toBe(400);
    expect((await renameSource.json()).fields).toContain('businessSource');

    const renamed = await admin.patch(`${BASE}/${application.id}`, {
      version: application.version,
      name: '本地生活（新）',
      note: '已更新备注',
    });
    expect(renamed.status).toBe(200);
    const renamedBody = (await renamed.json()) as { application: BusinessApplicationDto };
    expect(renamedBody.application.version).toBe(2);
    expect(renamedBody.application.name).toBe('本地生活（新）');
    expect(renamedBody.application.businessSource).toBe('local-life');

    // A stale version is rejected instead of overwriting the newer edit.
    const stale = await admin.patch(`${BASE}/${application.id}`, {
      version: 1,
      name: '过期写入',
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toBe('APPLICATION_VERSION_CONFLICT');

    // Repeating the persisted value is a no-op, not a new version.
    const unchanged = await admin.patch(`${BASE}/${application.id}`, {
      version: 2,
      name: '本地生活（新）',
    });
    expect(unchanged.status).toBe(200);
    const unchangedBody = (await unchanged.json()) as { application: BusinessApplicationDto };
    expect(unchangedBody.application.version).toBe(2);

    const actor = server.database.sqlite
      .prepare('SELECT id FROM admin_accounts WHERE username = ?')
      .get('app.admin') as { id: string };
    const events = applicationEvents(server, application.id);
    expect(events.map((row) => row.action)).toEqual(['created', 'updated']);
    expect(events.every((row) => row.actor_account_id === actor.id)).toBe(true);
    expect(
      server.database.sqlite
        .prepare(
          'SELECT COUNT(*) AS value FROM business_application_events WHERE application_id = ? AND created_at > 0',
        )
        .get(application.id),
    ).toEqual({ value: 2 });

    const lost = await admin.request(`${BASE}/does-not-exist`);
    expect(lost.status).toBe(404);
    expect((await lost.json()).error).toBe('APPLICATION_NOT_FOUND');
  });

  it('disables, keeps the record inspectable, and re-enables without deleting configuration', async () => {
    const server = startServer();
    const admin = await login(server, 'app.admin', 'admin');
    const product = seedProduct(server, 'APP-P-1');
    const application = await createApplication(admin, {
      businessSource: 'card-doctor',
      name: '卡博士',
    });

    const assigned = await admin.put(`${BASE}/${application.id}/products`, {
      version: 1,
      productIds: [product.id],
    });
    expect(assigned.status).toBe(200);
    expect(((await assigned.json()) as { application: BusinessApplicationDto }).application.version).toBe(
      2,
    );

    const disabled = await admin.post(`${BASE}/${application.id}/disable`, { version: 2 });
    expect(disabled.status).toBe(200);
    expect(((await disabled.json()) as { application: BusinessApplicationDto }).application).toMatchObject(
      { status: 'disabled', version: 3 },
    );

    const listed = await admin.request(`${BASE}?status=disabled`);
    expect(listed.status).toBe(200);
    const listedBody = applicationListResponseSchema.parse(await listed.json());
    expect(listedBody.applications.map((row) => row.businessSource)).toEqual(['card-doctor']);

    // Still readable and its configuration is intact while disabled.
    const whileDisabled = await detail(admin, application.id);
    expect(whileDisabled.application.status).toBe('disabled');
    expect(whileDisabled.products.map((row) => row.productId)).toEqual([product.id]);

    // Repeating the current status is not a version bump.
    const repeated = await admin.post(`${BASE}/${application.id}/disable`, { version: 3 });
    expect(repeated.status).toBe(200);
    expect(((await repeated.json()) as { application: BusinessApplicationDto }).application.version).toBe(
      3,
    );

    const enabled = await admin.post(`${BASE}/${application.id}/enable`, { version: 3 });
    expect(enabled.status).toBe(200);
    expect(((await enabled.json()) as { application: BusinessApplicationDto }).application).toMatchObject({
      status: 'enabled',
      version: 4,
      configuredProductCount: 1,
    });

    expect(applicationEvents(server, application.id).map((row) => row.action)).toEqual([
      'created',
      'products_updated',
      'disabled',
      'enabled',
    ]);
    expect(
      server.database.sqlite
        .prepare('SELECT COUNT(*) AS value FROM business_application_products WHERE application_id = ?')
        .get(application.id),
    ).toEqual({ value: 1 });
  });

  it('paginates and filters by keyword and status on the server', async () => {
    const server = startServer();
    const admin = await login(server, 'app.admin', 'admin');
    for (const [source, name] of [
      ['local-life', '本地生活'],
      ['card-doctor', '卡博士'],
      ['points-mall', '积分商城'],
    ] as const) {
      await createApplication(admin, { businessSource: source, name });
    }
    await admin.post(`${BASE}/${(await detailBySource(admin, 'points-mall')).id}/disable`, {
      version: 1,
    });

    const firstPage = applicationListResponseSchema.parse(
      await (await admin.request(`${BASE}?page=1&pageSize=2`)).json(),
    );
    expect(firstPage.total).toBe(3);
    expect(firstPage.applications).toHaveLength(2);

    const keyword = applicationListResponseSchema.parse(
      await (await admin.request(`${BASE}?keyword=${encodeURIComponent('卡博')}`)).json(),
    );
    expect(keyword.applications.map((row) => row.businessSource)).toEqual(['card-doctor']);

    const enabledOnly = applicationListResponseSchema.parse(
      await (await admin.request(`${BASE}?status=enabled`)).json(),
    );
    expect(enabledOnly.applications.map((row) => row.businessSource).sort()).toEqual([
      'card-doctor',
      'local-life',
    ]);

    const invalid = await admin.request(`${BASE}?pageSize=1000`);
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get('cache-control')).toBe('no-store');

    const invalidStatus = await admin.request(`${BASE}?status=pending`);
    expect(invalidStatus.status).toBe(400);
  });
});

describe('application product configuration', () => {
  it('atomically replaces the internal product allowlist with version and audit protection', async () => {
    const server = startServer();
    const admin = await login(server, 'app.admin', 'admin');
    const first = seedProduct(server, 'APP-A');
    const second = seedProduct(server, 'APP-B');
    const application = await createApplication(admin, {
      businessSource: 'local-life',
      name: '本地生活',
    });

    const saved = await admin.put(`${BASE}/${application.id}/products`, {
      version: 1,
      productIds: [first.id, second.id],
    });
    expect(saved.status).toBe(200);
    const savedBody = applicationDetailResponseSchema.parse(await saved.json());
    expect(savedBody.application.version).toBe(2);
    expect(savedBody.application.configuredProductCount).toBe(2);
    expect(savedBody.products.map((row) => row.code)).toEqual(['APP-A', 'APP-B']);
    expect(savedBody.products.every((row: ApplicationProductDto) => row.status === 'active')).toBe(
      true,
    );

    // The database itself refuses a duplicate (application, product) pair.
    expect(() =>
      server.database.sqlite
        .prepare(
          'INSERT INTO business_application_products (application_id, product_id, configured_at) VALUES (?, ?, ?)',
        )
        .run(application.id, first.id, Date.now()),
    ).toThrow(/UNIQUE constraint failed/);

    // Same set (order-independent) is a no-op instead of a new version.
    const unchanged = await admin.put(`${BASE}/${application.id}/products`, {
      version: 2,
      productIds: [second.id, first.id],
    });
    expect(unchanged.status).toBe(200);
    expect(
      ((await unchanged.json()) as { application: BusinessApplicationDto }).application.version,
    ).toBe(2);

    // A stale version cannot mutate the configuration.
    const stale = await admin.put(`${BASE}/${application.id}/products`, {
      version: 1,
      productIds: [first.id],
    });
    expect(stale.status).toBe(409);

    // Unknown ids are rejected as a whole; the previous set is untouched.
    const unknown = await admin.put(`${BASE}/${application.id}/products`, {
      version: 2,
      productIds: [first.id, 'supplier-product-code-not-an-internal-id'],
    });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toBe('APPLICATION_UNKNOWN_PRODUCT');
    expect((await detail(admin, application.id)).products).toHaveLength(2);

    // Duplicates are rejected rather than silently collapsed.
    const duplicates = await admin.put(`${BASE}/${application.id}/products`, {
      version: 2,
      productIds: [first.id, first.id],
    });
    expect(duplicates.status).toBe(400);
    expect((await duplicates.json()).fields).toContain('productIds');

    // A newly added product must be active; a previously configured one may
    // stay when it is later disabled.
    const disabledProduct = seedProduct(server, 'APP-DISABLED');
    setProductStatus(server.database.db, disabledProduct.id, 'disabled', 1, 'test-actor');
    const addDisabled = await admin.put(`${BASE}/${application.id}/products`, {
      version: 2,
      productIds: [first.id, second.id, disabledProduct.id],
    });
    expect(addDisabled.status).toBe(400);
    expect((await addDisabled.json()).error).toBe('PRODUCT_NOT_ACTIVE');

    setProductStatus(server.database.db, second.id, 'disabled', 1, 'test-actor');
    const keepDisabled = await admin.put(`${BASE}/${application.id}/products`, {
      version: 2,
      productIds: [first.id, second.id],
    });
    expect(keepDisabled.status).toBe(200);
    const keepBody = applicationDetailResponseSchema.parse(await keepDisabled.json());
    expect(keepBody.products.map((row) => `${row.code}:${row.status}`)).toEqual([
      'APP-A:active',
      'APP-B:disabled',
    ]);
  });

  it('persists the registry and allowlist across a service restart', async () => {
    const server = startServer();
    const admin = await login(server, 'app.admin', 'admin');
    const product = seedProduct(server, 'APP-RESTART');
    const application = await createApplication(admin, {
      businessSource: 'restart-source',
      name: '重启验证应用',
      note: '持久化备注',
    });
    expect(
      (
        await admin.put(`${BASE}/${application.id}/products`, {
          version: 1,
          productIds: [product.id],
        })
      ).status,
    ).toBe(200);

    server.restart();
    const afterRestart = await detail(admin, application.id);
    expect(afterRestart.application).toMatchObject({
      businessSource: 'restart-source',
      name: '重启验证应用',
      note: '持久化备注',
      status: 'enabled',
      version: 2,
      configuredProductCount: 1,
    });
    expect(afterRestart.products.map((row) => row.productId)).toEqual([product.id]);
  });
});

describe('configuration plane stays separate from machine authorization', () => {
  it('does not mint credentials, grant the legacy order API, or enforce the allowlist', async () => {
    const clients = loadConfig({
      DATABASE_FILE: ':memory:',
      BENEFIT_ORDER_CLIENTS_JSON: JSON.stringify({ 'local-life': FICTIONAL_ORDER_TOKEN }),
    }).businessOrderClients;
    const server = startServer({ businessOrderClients: clients });
    const admin = await login(server, 'app.admin', 'admin');

    const configuredProduct = seedProduct(server, 'MACHINE-P-1');
    const unlistedProduct = seedProduct(server, 'MACHINE-P-2');
    const mappingRepository = createSupplierMappingRepository(server.database.db);
    for (const product of [configuredProduct, unlistedProduct]) {
      const draft = mappingRepository.saveDraft({
        productId: product.id,
        expectedVersion: null,
        provider: 'yangmao',
        productCode: `YM-${product.code}`,
        fulfillmentMode: 'D',
        deductionUnit: 'amount',
      });
      mappingRepository.validateDraft({ productId: product.id, expectedVersion: draft.version });
      mappingRepository.activateDraft({
        productId: product.id,
        expectedVersion: draft.version,
        actorAccountId: 'test-actor',
      });
    }

    const application = await createApplication(admin, {
      businessSource: 'local-life',
      name: '本地生活',
    });
    await admin.put(`${BASE}/${application.id}/products`, {
      version: 1,
      productIds: [configuredProduct.id],
    });

    const order = (productId: string) =>
      fetchOrder(server, FICTIONAL_ORDER_TOKEN, {
        businessOrderNo: `ORDER-${productId.slice(0, 8)}`,
        productId,
      });

    // The legacy machine route keeps working exactly as before, including for a
    // product that is not in the configured allowlist.
    const baseline = await order(unlistedProduct.id);
    expect(baseline.status).toBe(201);

    // Disabling the registered application and clearing its allowlist does not
    // revoke the separately configured legacy Bearer credential.
    await admin.post(`${BASE}/${application.id}/disable`, { version: 2 });
    await admin.put(`${BASE}/${application.id}/products`, {
      version: 3,
      productIds: [],
    });
    const afterConfigurationChange = await order(configuredProduct.id);
    expect(afterConfigurationChange.status).toBe(201);

    // Conversely, an existing registered and enabled application never becomes a
    // machine credential: no Bearer, a wrong Bearer, and an admin cookie all fail.
    await admin.post(`${BASE}/${application.id}/enable`, { version: 4 });
    const deniedHeaders: Record<string, string>[] = [
      { 'content-type': 'application/json' },
      {
        'content-type': 'application/json',
        authorization: 'Bearer fictional-wrong-token-0000000000000001',
      },
    ];
    for (const headers of deniedHeaders) {
      const denied = await server.app.request('/api/v1/business/orders', {
        method: 'POST',
        headers,
        body: JSON.stringify({ businessOrderNo: 'ORDER-NO-AUTH', productId: configuredProduct.id }),
      });
      expect(denied.status).toBe(401);
      expect(denied.headers.get('cache-control')).toBe('no-store');
    }
    const cookieOnly = await admin.post('/api/v1/business/orders', {
      businessOrderNo: 'ORDER-COOKIE-ONLY',
      productId: configuredProduct.id,
    });
    expect(cookieOnly.status).toBe(401);

    // The configuration response never carries the server-side token.
    const raw = await (await admin.request(`${BASE}/${application.id}`)).text();
    expect(raw).not.toContain(FICTIONAL_ORDER_TOKEN);
    expect(raw).not.toContain('"token"');
    expect(raw).toContain('"runtimeAuthorizationEnforced":false');
  });
});

async function detailBySource(client: TestClient, businessSource: string) {
  const response = await client.request(`${BASE}?keyword=${encodeURIComponent(businessSource)}`);
  const parsed = applicationListResponseSchema.parse(await response.json());
  const found = parsed.applications.find((row) => row.businessSource === businessSource);
  if (!found) throw new Error(`Missing application ${businessSource}`);
  return found;
}

async function fetchOrder(
  server: TestServer,
  token: string,
  body: { businessOrderNo: string; productId: string },
) {
  return server.app.request('/api/v1/business/orders', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}
