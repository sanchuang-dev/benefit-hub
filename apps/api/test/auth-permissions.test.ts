import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { disableAdminAccount, resetAdminPassword } from '../src/modules/auth/admin-operations.js';
import { seedAccount, TEST_PASSWORD, TestClient, TestServer } from './helpers/test-server.js';

let server: TestServer;

beforeEach(() => {
  server = new TestServer();
});

afterEach(() => {
  server.close();
});

describe('authorization boundary', () => {
  it('rejects unauthenticated access to the admin API', async () => {
    const response = await new TestClient(server).request('/api/v1/admin/accounts');
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe('UNAUTHENTICATED');
  });

  it('allows admins to read the account list without exposing password hashes', async () => {
    await seedAccount(server, { username: 'ops.admin', displayName: '运维管理员' });
    await seedAccount(server, { username: 'read.only', role: 'viewer' });
    const client = new TestClient(server);
    expect((await client.login('ops.admin', TEST_PASSWORD)).status).toBe(200);

    const response = await client.request('/api/v1/admin/accounts');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { accounts: { username: string; role: string }[] };
    expect(body.accounts.map((account) => account.username)).toEqual(['ops.admin', 'read.only']);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain('scrypt$');
  });

  it('forbids a viewer from the admin-only endpoint', async () => {
    await seedAccount(server, { username: 'read.only', role: 'viewer' });
    const client = new TestClient(server);
    expect((await client.login('read.only', TEST_PASSWORD)).status).toBe(200);

    const allowed = await client.session();
    expect(allowed.status).toBe(200);
    expect(((await allowed.json()) as { admin: { role: string } }).admin.role).toBe('viewer');

    const forbidden = await client.request('/api/v1/admin/accounts');
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      error: 'FORBIDDEN',
      message: '当前身份无权执行该操作',
    });
  });

  it('revokes existing sessions when an admin resets a password', async () => {
    await seedAccount(server, { username: 'ops.admin' });
    const client = new TestClient(server);
    expect((await client.login('ops.admin', TEST_PASSWORD)).status).toBe(200);

    const newPassword = 'rotated-password-7c1d';
    await resetAdminPassword(server.database.db, 'ops.admin', newPassword);

    const oldSession = await client.session();
    expect(oldSession.status).toBe(401);
    expect((await oldSession.json()).error).toBe('SESSION_EXPIRED');

    expect((await new TestClient(server).login('ops.admin', TEST_PASSWORD)).status).toBe(401);
    expect((await new TestClient(server).login('ops.admin', newPassword)).status).toBe(200);
  });

  it('blocks a disabled account and invalidates its session', async () => {
    await seedAccount(server, { username: 'ops.admin' });
    const client = new TestClient(server);
    expect((await client.login('ops.admin', TEST_PASSWORD)).status).toBe(200);

    disableAdminAccount(server.database.db, 'ops.admin');

    expect((await client.session()).status).toBe(401);

    const login = await new TestClient(server).login('ops.admin', TEST_PASSWORD);
    expect(login.status).toBe(401);
    expect((await login.json()).error).toBe('INVALID_CREDENTIALS');
  });
});
