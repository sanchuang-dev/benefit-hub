import { afterEach, describe, expect, it } from 'vitest';
import { auditEventListResponseSchema } from '@sanchuang-dev/benefit-contracts';
import { TEST_PASSWORD, TestClient, TestServer, seedAccount } from '../helpers/test-server.js';

const ENDPOINT = '/api/v1/admin/audit-events';

let server: TestServer | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

function startServer(): TestServer {
  const testServer = new TestServer();
  server = testServer;
  return testServer;
}

/**
 * Seeds both roles and a mixture of authentication/account events:
 * - account creation events from `seedAccount`
 * - one successful login and one failed login for the admin account
 * - a viewer login attempt
 */
async function seedAuditFacts() {
  const testServer = startServer();
  const admin = await seedAccount(testServer, {
    username: 'audit.admin',
    role: 'admin',
    displayName: '审计管理员',
  });
  await seedAccount(testServer, { username: 'audit.viewer', role: 'viewer' });

  const adminClient = new TestClient(testServer);
  expect((await adminClient.login('audit.admin', TEST_PASSWORD)).status).toBe(200);
  expect((await adminClient.login('audit.admin', 'wrong-password-123')).status).toBe(401);

  const viewerClient = new TestClient(testServer);
  expect((await viewerClient.login('audit.viewer', TEST_PASSWORD)).status).toBe(200);

  return { testServer, admin, adminClient };
}

function parseBody(raw: string) {
  const parsed = auditEventListResponseSchema.safeParse(JSON.parse(raw));
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error('audit response does not match the contract');
  return parsed.data;
}

describe('administrator audit trail', () => {
  it('requires a session', async () => {
    const testServer = startServer();
    const response = await new TestClient(testServer).request(ENDPOINT);
    expect(response.status).toBe(401);
  });

  it('rejects viewers at the server, not only in the UI', async () => {
    const testServer = startServer();
    await seedAccount(testServer, { username: 'audit.viewer', role: 'viewer' });
    const client = new TestClient(testServer);
    expect((await client.login('audit.viewer', TEST_PASSWORD)).status).toBe(200);

    const response = await client.request(ENDPOINT);
    expect(response.status).toBe(403);
  });

  it('lists newest-first events with the responsible operator and no secrets', async () => {
    const { adminClient } = await seedAuditFacts();

    const response = await adminClient.request(ENDPOINT);
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain(TEST_PASSWORD);
    expect(raw).not.toContain('wrong-password-123');

    const body = parseBody(raw);
    expect(body.total).toBeGreaterThan(0);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(20);
    expect(body.events.length).toBe(body.total);

    const failedLogin = body.events.find((event) => event.event === 'login.failed');
    expect(failedLogin).toBeDefined();
    expect(failedLogin?.category).toBe('authentication');
    expect(failedLogin?.account?.username).toBe('audit.admin');
    expect(failedLogin?.detail).toBe('invalid_credentials');

    const created = body.events.find((event) => event.event === 'admin_account.created');
    expect(created?.category).toBe('account');

    for (let index = 1; index < body.events.length; index += 1) {
      expect(body.events[index - 1]!.createdAt).toBeGreaterThanOrEqual(
        body.events[index]!.createdAt,
      );
    }
  });

  it('filters by category, event and account', async () => {
    const { admin, adminClient } = await seedAuditFacts();

    const categoryResponse = await adminClient.request(`${ENDPOINT}?category=account&pageSize=100`);
    const categoryBody = parseBody(await categoryResponse.text());
    expect(categoryBody.total).toBeGreaterThan(0);
    expect(categoryBody.events.every((event) => event.category === 'account')).toBe(true);

    const eventResponse = await adminClient.request(`${ENDPOINT}?event=login.failed`);
    const eventBody = parseBody(await eventResponse.text());
    expect(eventBody.events.length).toBeGreaterThan(0);
    expect(eventBody.events.every((event) => event.event === 'login.failed')).toBe(true);

    const accountResponse = await adminClient.request(`${ENDPOINT}?accountId=${admin.id}`);
    const accountBody = parseBody(await accountResponse.text());
    expect(accountBody.events.length).toBeGreaterThan(0);
    expect(accountBody.events.every((event) => event.account?.id === admin.id)).toBe(true);
  });

  it('paginates with a server-side total', async () => {
    const { adminClient } = await seedAuditFacts();

    const first = parseBody(await (await adminClient.request(`${ENDPOINT}?pageSize=2`)).text());
    expect(first.events).toHaveLength(2);
    expect(first.total).toBeGreaterThan(2);

    const second = parseBody(
      await (await adminClient.request(`${ENDPOINT}?pageSize=2&page=2`)).text(),
    );
    expect(second.events).toHaveLength(2);
    expect(second.events.map((event) => event.id)).not.toEqual(
      first.events.map((event) => event.id),
    );
  });

  it('rejects invalid paging parameters instead of silently clamping', async () => {
    const { adminClient } = await seedAuditFacts();

    const badPage = await adminClient.request(`${ENDPOINT}?page=0`);
    expect(badPage.status).toBe(400);

    const badPageSize = await adminClient.request(`${ENDPOINT}?pageSize=101`);
    expect(badPageSize.status).toBe(400);

    const badCategory = await adminClient.request(`${ENDPOINT}?category=unknown`);
    expect(badCategory.status).toBe(400);
  });
});
