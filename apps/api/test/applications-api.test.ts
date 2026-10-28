import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applicationDetailResponseSchema,
  applicationListResponseSchema,
  businessOrderErrorResponseSchema,
  createBusinessOrderResponseSchema,
  issueApplicationCredentialResponseSchema,
  revokeApplicationCredentialResponseSchema,
  type ApplicationProductDto,
  type BusinessApplicationDto,
  type BusinessOrderErrorResponse,
  type IssueApplicationCredentialResponse,
} from '@sanchuang-dev/benefit-contracts';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createProduct, setProductStatus } from '../src/modules/catalog/products.js';
import { createSupplierMappingRepository } from '../src/modules/catalog/supplier-mapping-repository.js';
import { MAX_ACTIVE_CREDENTIALS_PER_APPLICATION } from '../src/modules/applications/credentials.js';
import { seedAccount, TEST_PASSWORD, TestClient, TestServer } from './helpers/test-server.js';

const BASE = '/api/v1/applications';
const BUSINESS_ORDERS = '/api/v1/business/orders';

/** Explicitly fictional downstream token; it exists only inside this test file. */
const FICTIONAL_ORDER_TOKEN = 'fictional-local-life-order-token-00000001';
const FICTIONAL_DOCTOR_TOKEN = 'fictional-card-doctor-order-token-000002';

function clientsConfig(entries: Record<string, string>) {
  return loadConfig({
    DATABASE_FILE: ':memory:',
    BENEFIT_ORDER_CLIENTS_JSON: JSON.stringify(entries),
  }).businessOrderClients;
}

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
    const issued = issueApplicationCredentialResponseSchema.parse(
      await (await admin.post(`${BASE}/${created.id}/credentials`)).json(),
    );

    // Anonymous credential reads/writes are rejected before any handler runs.
    for (const path of [
      `${BASE}/${created.id}/credentials`,
      `${BASE}/${created.id}/credentials/${issued.credential.id}/revoke`,
    ]) {
      const anonymousClient = new TestClient(server);
      const csrf = await anonymousClient.csrfToken();
      const response = await anonymousClient.post(path, undefined, csrf);
      expect(response.status, path).toBe(401);
    }

    for (const [path, method, body] of [
      [BASE, 'POST', { businessSource: 'card-doctor', name: '卡博士' }],
      [`${BASE}/${created.id}`, 'PATCH', { version: created.version, name: '越权重命名' }],
      [`${BASE}/${created.id}/disable`, 'POST', { version: created.version }],
      [`${BASE}/${created.id}/products`, 'PUT', { version: created.version, productIds: [] }],
      [`${BASE}/${created.id}/credentials`, 'POST', undefined],
      [`${BASE}/${created.id}/credentials/${issued.credential.id}/revoke`, 'POST', undefined],
    ] as const) {
      const response =
        method === 'PATCH'
          ? await viewer.patch(path, body)
          : method === 'PUT'
            ? await viewer.put(path, body)
            : await viewer.post(path, body);
      expect(response.status, path).toBe(403);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }

    // A write without the double-submit token never reaches the route, even for admin.
    const withoutCsrf = await admin.request(BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ businessSource: 'no-csrf', name: '无令牌' }),
    });
    expect(withoutCsrf.status).toBe(403);
    expect((await withoutCsrf.json()).error).toBe('CSRF_TOKEN_INVALID');

    for (const path of [
      `${BASE}/${created.id}/credentials`,
      `${BASE}/${created.id}/credentials/${issued.credential.id}/revoke`,
    ]) {
      const response = await admin.request(path, { method: 'POST' });
      expect(response.status, path).toBe(403);
      expect((await response.json()).error).toBe('CSRF_TOKEN_INVALID');
    }

    // Viewer can read the non-sensitive credential state but never the secret.
    const viewerDetail = await viewer.request(`${BASE}/${created.id}`);
    expect(viewerDetail.status).toBe(200);
    const viewerDetailText = await viewerDetail.text();
    expect(viewerDetailText).not.toContain(issued.secret);
    expect(applicationDetailResponseSchema.parse(JSON.parse(viewerDetailText)).credentials).toEqual([
      issued.credential,
    ]);

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
      activeCredentialCount: 0,
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

describe('application machine credentials', () => {
  it('issues a one-time secret and persists only its SHA-256 digest', async () => {
    const server = startServer();
    const admin = await login(server, 'app.admin', 'admin');
    const product = seedProduct(server, 'CRED-P-1');
    activateMapping(server, product.id);

    const application = await createApplication(admin, {
      businessSource: 'local-life',
      name: '本地生活',
    });

    const issuedResponse = await admin.post(`${BASE}/${application.id}/credentials`);
    expect(issuedResponse.status).toBe(201);
    expect(issuedResponse.headers.get('cache-control')).toBe('no-store');
    const issued = issueApplicationCredentialResponseSchema.parse(await issuedResponse.json());
    expect(issued.credential).toMatchObject({ status: 'active', revokedAt: null });
    expect(issued.secret.length).toBeGreaterThanOrEqual(32);
    expect(issued.secret.startsWith('bhk_')).toBe(true);

    const stored = server.database.sqlite
      .prepare(
        'SELECT token_sha256, revoked_at FROM business_application_credentials WHERE application_id = ?',
      )
      .all(application.id) as { token_sha256: string; revoked_at: number | null }[];
    expect(stored).toHaveLength(1);
    expect(stored[0]!.token_sha256).toBe(createHash('sha256').update(issued.secret).digest('hex'));
    expect(stored[0]!.token_sha256).not.toContain(issued.secret);
    expect(stored[0]!.revoked_at).toBeNull();

    const actor = server.database.sqlite
      .prepare('SELECT id FROM admin_accounts WHERE username = ?')
      .get('app.admin') as { id: string };
    const events = server.database.sqlite
      .prepare(
        'SELECT action, actor_account_id FROM business_application_credential_events WHERE application_id = ? ORDER BY created_at, rowid',
      )
      .all(application.id) as { action: string; actor_account_id: string }[];
    expect(events).toEqual([{ action: 'issued', actor_account_id: actor.id }]);

    // A credential alone is not permission: the product must also be allowlisted.
    expect(
      (
        await admin.put(`${BASE}/${application.id}/products`, {
          version: 1,
          productIds: [product.id],
        })
      ).status,
    ).toBe(200);

    // The secret appears exactly once: no list, detail or restart read exposes it.
    const listed = applicationListResponseSchema.parse(
      await (await admin.request(BASE)).json(),
    );
    expect(listed.runtimeAuthorizationEnforced).toBe(true);
    expect(listed.applications[0]!.activeCredentialCount).toBe(1);
    const listedRaw = JSON.stringify(listed);
    expect(listedRaw).not.toContain(issued.secret);
    expect(listedRaw).not.toContain(stored[0]!.token_sha256);

    const detailBody = await detail(admin, application.id);
    expect(detailBody.runtimeAuthorizationEnforced).toBe(true);
    expect(detailBody.credentials).toEqual([issued.credential]);
    const detailRaw = JSON.stringify(detailBody);
    expect(detailRaw).not.toContain(issued.secret);
    expect(detailRaw).not.toContain(stored[0]!.token_sha256);

    server.restart();
    const afterRestart = await detail(admin, application.id);
    expect(afterRestart.credentials).toEqual([issued.credential]);
    expect(JSON.stringify(afterRestart)).not.toContain(issued.secret);

    // The issued secret keeps working after a restart; it is a persisted digest.
    const replayAfterRestart = await fetchOrder(server, issued.secret, {
      businessOrderNo: 'CRED-ORDER-1',
      productId: product.id,
    });
    expect(replayAfterRestart.status).toBe(201);
  });

  it('authenticates the existing machine order API and rejects products outside the allowlist', async () => {
    const server = startServer();
    const admin = await login(server, 'app.admin', 'admin');
    const allowed = seedProduct(server, 'CRED-ALLOWED');
    const unlisted = seedProduct(server, 'CRED-UNLISTED');
    const allowedMapping = activateMapping(server, allowed.id);
    activateMapping(server, unlisted.id);

    const localLife = await createApplication(admin, {
      businessSource: 'local-life',
      name: '本地生活',
    });
    const doctor = await createApplication(admin, {
      businessSource: 'card-doctor',
      name: '卡博士',
    });
    expect(
      (
        await admin.put(`${BASE}/${localLife.id}/products`, {
          version: 1,
          productIds: [allowed.id],
        })
      ).status,
    ).toBe(200);
    // card-doctor gets its own allowlist so its credential can also create orders.
    await admin.put(`${BASE}/${doctor.id}/products`, {
      version: 1,
      productIds: [allowed.id],
    });

    const localSecret = (
      await (
        await admin.post(`${BASE}/${localLife.id}/credentials`)
      ).json()
    ) as IssueApplicationCredentialResponse;
    const doctorSecret = (
      await (
        await admin.post(`${BASE}/${doctor.id}/credentials`)
      ).json()
    ) as IssueApplicationCredentialResponse;

    const createdResponse = await fetchOrder(server, localSecret.secret, {
      businessOrderNo: 'CRED-ORDER-1',
      productId: allowed.id,
    });
    expect(createdResponse.status).toBe(201);
    expect(createdResponse.headers.get('cache-control')).toBe('no-store');
    const created = createBusinessOrderResponseSchema.parse(await createdResponse.json());
    expect(created.order).toMatchObject({
      businessSource: 'local-life',
      businessOrderNo: 'CRED-ORDER-1',
      productId: allowed.id,
      status: 'pending',
      fulfillmentMode: 'D',
      mappingVersionId: allowedMapping.id,
    });

    // Exact replay stays idempotent and keeps the frozen snapshot.
    const replayResponse = await fetchOrder(server, localSecret.secret, {
      businessOrderNo: 'CRED-ORDER-1',
      productId: allowed.id,
    });
    expect(replayResponse.status).toBe(200);
    expect(createBusinessOrderResponseSchema.parse(await replayResponse.json()).order).toEqual(
      created.order,
    );

    // A product that exists but is not on this application's allowlist.
    const unlistedResponse = await fetchOrder(server, localSecret.secret, {
      businessOrderNo: 'CRED-ORDER-2',
      productId: unlisted.id,
    });
    expect(unlistedResponse.status).toBe(403);
    expect(
      businessOrderErrorResponseSchema.parse(await unlistedResponse.json()).error,
    ).toBe('PRODUCT_NOT_AUTHORIZED');

    // An unknown product is not distinguished from an unauthorized one.
    const unknownResponse = await fetchOrder(server, localSecret.secret, {
      businessOrderNo: 'CRED-ORDER-3',
      productId: 'missing-product',
    });
    expect(unknownResponse.status).toBe(403);
    expect(
      businessOrderErrorResponseSchema.parse(await unknownResponse.json()).error,
    ).toBe('PRODUCT_NOT_AUTHORIZED');

    expect(orderCount(server)).toBe(1);
    expect(statusEventCount(server)).toBe(1);
    expect(attemptCount(server)).toBe(0);

    // Own order is readable; the same internal id is not probeable by another app.
    const ownRead = await getOrderWithToken(
      server,
      localSecret.secret,
      `${BUSINESS_ORDERS}/${created.order.id}`,
    );
    expect(ownRead.status).toBe(200);
    const foreignRead = await getOrderWithToken(
      server,
      doctorSecret.secret,
      `${BUSINESS_ORDERS}/${created.order.id}`,
    );
    expect(foreignRead.status).toBe(404);
    expect(JSON.stringify(await foreignRead.json())).not.toContain(created.order.id);

    // A human admin session still cannot act as a machine identity.
    const cookieOnly = await admin.post(BUSINESS_ORDERS, {
      businessOrderNo: 'CRED-ORDER-4',
      productId: allowed.id,
    });
    expect(cookieOnly.status).toBe(401);
    expect(orderCount(server)).toBe(1);
  });

  it('rejects allowlisted products that are disabled or have no active mapping', async () => {
    const server = startServer();
    const admin = await login(server, 'app.admin', 'admin');
    const disabledProduct = seedProduct(server, 'CRED-DISABLED');
    const unmappedProduct = seedProduct(server, 'CRED-UNMAPPED');
    activateMapping(server, disabledProduct.id);

    const application = await createApplication(admin, {
      businessSource: 'local-life',
      name: '本地生活',
    });
    // Configured while active, then disabled afterwards: the allowlist keeps the
    // pair (product disable does not silently rewrite configuration), but no new
    // order may start from it.
    expect(
      (
        await admin.put(`${BASE}/${application.id}/products`, {
          version: 1,
          productIds: [disabledProduct.id, unmappedProduct.id],
        })
      ).status,
    ).toBe(200);
    setProductStatus(server.database.db, disabledProduct.id, 'disabled', 1, 'test-actor');
    const issued = issueApplicationCredentialResponseSchema.parse(
      await (await admin.post(`${BASE}/${application.id}/credentials`)).json(),
    );

    const disabled = await fetchOrder(server, issued.secret, {
      businessOrderNo: 'CRED-DISABLED-1',
      productId: disabledProduct.id,
    });
    expect(disabled.status).toBe(409);
    expect(businessOrderErrorResponseSchema.parse(await disabled.json()).error).toBe(
      'PRODUCT_NOT_ACTIVE',
    );

    const unmapped = await fetchOrder(server, issued.secret, {
      businessOrderNo: 'CRED-UNMAPPED-1',
      productId: unmappedProduct.id,
    });
    expect(unmapped.status).toBe(409);
    expect(businessOrderErrorSchema(await unmapped.json())).toBe('ORDER_MAPPING_UNAVAILABLE');
    expect(orderCount(server)).toBe(0);
  });

  it('revokes immediately, idempotently and without cross-application access', async () => {
    const server = startServer();
    const admin = await login(server, 'app.admin', 'admin');
    const product = seedProduct(server, 'CRED-REVOKE');
    activateMapping(server, product.id);

    const primary = await createApplication(admin, {
      businessSource: 'local-life',
      name: '本地生活',
    });
    const other = await createApplication(admin, {
      businessSource: 'card-doctor',
      name: '卡博士',
    });
    for (const application of [primary, other]) {
      await admin.put(`${BASE}/${application.id}/products`, {
        version: 1,
        productIds: [product.id],
      });
    }

    const issued = issueApplicationCredentialResponseSchema.parse(
      await (await admin.post(`${BASE}/${primary.id}/credentials`)).json(),
    );
    const otherIssued = issueApplicationCredentialResponseSchema.parse(
      await (await admin.post(`${BASE}/${other.id}/credentials`)).json(),
    );

    // Another application cannot revoke this credential, and the id is not probeable.
    const crossRevoke = await admin.post(
      `${BASE}/${other.id}/credentials/${issued.credential.id}/revoke`,
    );
    expect(crossRevoke.status).toBe(404);
    expect((await crossRevoke.json()).error).toBe('APPLICATION_CREDENTIAL_NOT_FOUND');

    const firstRevoke = await admin.post(
      `${BASE}/${primary.id}/credentials/${issued.credential.id}/revoke`,
    );
    expect(firstRevoke.status).toBe(200);
    const revoked = revokeApplicationCredentialResponseSchema.parse(await firstRevoke.json());
    expect(revoked.credential.status).toBe('revoked');
    expect(revoked.credential.revokedAt).toEqual(expect.any(Number));

    const denied = await fetchOrder(server, issued.secret, {
      businessOrderNo: 'CRED-REVOKED-1',
      productId: product.id,
    });
    expect(denied.status).toBe(401);
    expect(businessOrderErrorResponseSchema.parse(await denied.json()).error).toBe(
      'UNAUTHORIZED',
    );
    const deniedRead = await getOrderWithToken(server, issued.secret, BUSINESS_ORDERS);
    expect(deniedRead.status).toBe(401);

    // Repeated revocation is a no-op: same terminal state, single audit fact.
    const secondRevoke = await admin.post(
      `${BASE}/${primary.id}/credentials/${issued.credential.id}/revoke`,
    );
    expect(secondRevoke.status).toBe(200);
    expect(
      revokeApplicationCredentialResponseSchema.parse(await secondRevoke.json()).credential,
    ).toEqual(revoked.credential);
    const revokeEvents = server.database.sqlite
      .prepare(
        "SELECT COUNT(*) AS value FROM business_application_credential_events WHERE credential_id = ? AND action = 'revoked'",
      )
      .get(issued.credential.id) as { value: number };
    expect(revokeEvents.value).toBe(1);

    // The other application's credential is untouched.
    const otherStillWorks = await fetchOrder(server, otherIssued.secret, {
      businessOrderNo: 'CRED-OTHER-1',
      productId: product.id,
    });
    expect(otherStillWorks.status).toBe(201);

    const detailBody = await detail(admin, primary.id);
    expect(detailBody.application.activeCredentialCount).toBe(0);
    expect(detailBody.credentials).toHaveLength(1);
    expect(detailBody.credentials[0]!.status).toBe('revoked');

    // Revoking the last remaining credential must not degrade into a misleading
    // 503 "not configured" response: it stays a generic authentication failure.
    await admin.post(`${BASE}/${other.id}/credentials/${otherIssued.credential.id}/revoke`);
    const lastRevoked = await fetchOrder(server, otherIssued.secret, {
      businessOrderNo: 'CRED-OTHER-2',
      productId: product.id,
    });
    expect(lastRevoked.status).toBe(401);
    expect(businessOrderErrorSchema(await lastRevoked.json())).toBe('UNAUTHORIZED');
  });

  it('serializes duplicate revocations into one terminal transition', async () => {
    const server = startServer();
    const admin = await login(server, 'app.admin', 'admin');
    const application = await createApplication(admin, {
      businessSource: 'local-life',
      name: '本地生活',
    });
    const issued = issueApplicationCredentialResponseSchema.parse(
      await (await admin.post(`${BASE}/${application.id}/credentials`)).json(),
    );

    const responses = await Promise.all(
      Array.from({ length: 3 }, () =>
        admin.post(`${BASE}/${application.id}/credentials/${issued.credential.id}/revoke`),
      ),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const revokedAt = new Set(
      await Promise.all(
        responses.map(async (response) =>
          revokeApplicationCredentialResponseSchema.parse(await response.json()).credential
            .revokedAt,
        ),
      ),
    );
    expect(revokedAt.size).toBe(1);
    expect(
      (
        server.database.sqlite
          .prepare(
            "SELECT COUNT(*) AS value FROM business_application_credential_events WHERE action = 'revoked'",
          )
          .get() as { value: number }
      ).value,
    ).toBe(1);
  });

  it('bounds the number of simultaneously active credentials', async () => {
    const server = startServer();
    const admin = await login(server, 'app.admin', 'admin');
    const application = await createApplication(admin, {
      businessSource: 'local-life',
      name: '本地生活',
    });

    for (let index = 0; index < MAX_ACTIVE_CREDENTIALS_PER_APPLICATION; index += 1) {
      expect((await admin.post(`${BASE}/${application.id}/credentials`)).status).toBe(201);
    }
    const overflow = await admin.post(`${BASE}/${application.id}/credentials`);
    expect(overflow.status).toBe(409);
    expect((await overflow.json()).error).toBe('APPLICATION_CREDENTIAL_LIMIT_REACHED');
  });
});

describe('registered application governs legacy environment credentials', () => {
  it('keeps unregistered sources working while constraining a registered source', async () => {
    const server = startServer({
      businessOrderClients: clientsConfig({
        'local-life': FICTIONAL_ORDER_TOKEN,
        'card-doctor': FICTIONAL_DOCTOR_TOKEN,
      }),
    });
    const admin = await login(server, 'app.admin', 'admin');

    const allowed = seedProduct(server, 'LEGACY-ALLOWED');
    const unlisted = seedProduct(server, 'LEGACY-UNLISTED');
    activateMapping(server, allowed.id);
    activateMapping(server, unlisted.id);

    const application = await createApplication(admin, {
      businessSource: 'local-life',
      name: '本地生活',
    });
    await admin.put(`${BASE}/${application.id}/products`, {
      version: 1,
      productIds: [allowed.id],
    });

    // The environment credential is accepted, but only for the allowlisted product.
    const allowedOrder = await fetchOrder(server, FICTIONAL_ORDER_TOKEN, {
      businessOrderNo: 'LEGACY-1',
      productId: allowed.id,
    });
    expect(allowedOrder.status).toBe(201);

    const blocked = await fetchOrder(server, FICTIONAL_ORDER_TOKEN, {
      businessOrderNo: 'LEGACY-2',
      productId: unlisted.id,
    });
    expect(blocked.status).toBe(403);
    expect(businessOrderErrorSchema(await blocked.json())).toBe('PRODUCT_NOT_AUTHORIZED');

    // An unregistered source keeps the legacy compatibility path unchanged.
    const doctorOrder = await fetchOrder(server, FICTIONAL_DOCTOR_TOKEN, {
      businessOrderNo: 'LEGACY-3',
      productId: unlisted.id,
    });
    expect(doctorOrder.status).toBe(201);

    // Disabling the registered application suspends even its environment credential.
    await admin.post(`${BASE}/${application.id}/disable`, { version: 2 });
    const disabled = await fetchOrder(server, FICTIONAL_ORDER_TOKEN, {
      businessOrderNo: 'LEGACY-4',
      productId: allowed.id,
    });
    expect(disabled.status).toBe(403);
    expect(businessOrderErrorSchema(await disabled.json())).toBe('APPLICATION_DISABLED');
    const disabledRead = await getOrderWithToken(server, FICTIONAL_ORDER_TOKEN, BUSINESS_ORDERS);
    expect(disabledRead.status).toBe(403);

    // Re-enable with an empty allowlist: the existing order replays unchanged,
    // while a new order for the removed product is rejected.
    await admin.post(`${BASE}/${application.id}/enable`, { version: 3 });
    await admin.put(`${BASE}/${application.id}/products`, {
      version: 4,
      productIds: [],
    });

    const replay = await fetchOrder(server, FICTIONAL_ORDER_TOKEN, {
      businessOrderNo: 'LEGACY-1',
      productId: allowed.id,
    });
    expect(replay.status).toBe(200);
    const replayedOrder = createBusinessOrderResponseSchema.parse(await replay.json());
    expect(replayedOrder.created).toBe(false);
    expect(replayedOrder.order.productId).toBe(allowed.id);
    expect(replayedOrder.order.mappingVersionId).not.toBeNull();

    const removed = await fetchOrder(server, FICTIONAL_ORDER_TOKEN, {
      businessOrderNo: 'LEGACY-5',
      productId: allowed.id,
    });
    expect(removed.status).toBe(403);
    expect(businessOrderErrorSchema(await removed.json())).toBe('PRODUCT_NOT_AUTHORIZED');
  });

  it('never exposes the environment token in application read models', async () => {
    const server = startServer({
      businessOrderClients: clientsConfig({ 'local-life': FICTIONAL_ORDER_TOKEN }),
    });
    const admin = await login(server, 'app.admin', 'admin');
    const application = await createApplication(admin, {
      businessSource: 'local-life',
      name: '本地生活',
    });

    const raw = await (await admin.request(`${BASE}/${application.id}`)).text();
    expect(raw).not.toContain(FICTIONAL_ORDER_TOKEN);
    expect(raw).toContain('"runtimeAuthorizationEnforced":true');
    expect(raw).not.toContain('token_sha256');
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
  return server.app.request(BUSINESS_ORDERS, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

/** Saves, validates and activates a D-mode mapping, returning the frozen version. */
function activateMapping(server: TestServer, productId: string) {
  const repository = createSupplierMappingRepository(server.database.db);
  const current = repository.getDraft(productId);
  const draft = repository.saveDraft({
    productId,
    expectedVersion: current?.version ?? null,
    provider: 'yangmao',
    productCode: `YM-${productId.slice(0, 8)}`,
    fulfillmentMode: 'D',
    deductionUnit: 'amount',
  });
  repository.validateDraft({ productId, expectedVersion: draft.version });
  return repository.activateDraft({
    productId,
    expectedVersion: draft.version,
    actorAccountId: 'test-actor',
  });
}

async function getOrderWithToken(
  server: TestServer,
  token: string,
  path: string,
): Promise<Response> {
  return server.app.request(path, {
    headers: { authorization: `Bearer ${token}` },
  });
}

function businessOrderErrorSchema(body: unknown): BusinessOrderErrorResponse['error'] {
  const parsed = businessOrderErrorResponseSchema.safeParse(body);
  if (!parsed.success) throw new Error('Error body does not match the shared contract');
  return parsed.data.error;
}

function countRows(server: TestServer, table: string): number {
  const row = server.database.sqlite
    .prepare(`SELECT COUNT(*) AS value FROM ${table}`)
    .get() as { value: number };
  return row.value;
}

function orderCount(server: TestServer): number {
  return countRows(server, 'benefit_orders');
}

function statusEventCount(server: TestServer): number {
  return countRows(server, 'benefit_order_status_events');
}

function attemptCount(server: TestServer): number {
  return countRows(server, 'fulfillment_attempts');
}
