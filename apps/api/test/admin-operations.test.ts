import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountConflictError, AccountNotFoundError } from '../src/modules/auth/accounts.js';
import {
  createAdminAccount,
  disableAdminAccount,
  listAdminAccounts,
  PasswordPolicyError,
  resetAdminPassword,
} from '../src/modules/auth/admin-operations.js';
import { TEST_PASSWORD, TestClient, TestServer } from './helpers/test-server.js';

let server: TestServer;

beforeEach(() => {
  server = new TestServer();
});

afterEach(() => {
  server.close();
});

describe('administrator provisioning', () => {
  it('creates admin and viewer accounts with audited, hash-only storage', async () => {
    const admin = await createAdminAccount(server.database.db, {
      username: 'OPS.Admin',
      password: 'initial-password-123',
      role: 'admin',
      displayName: '运维管理员',
    });
    expect(admin).toMatchObject({
      username: 'ops.admin',
      displayName: '运维管理员',
      role: 'admin',
      disabled: false,
    });

    await createAdminAccount(server.database.db, {
      username: 'read.only',
      password: 'viewer-password-123',
      role: 'viewer',
    });

    const rows = server.database.sqlite
      .prepare('SELECT username, password_hash FROM admin_accounts ORDER BY username')
      .all() as { username: string; password_hash: string }[];
    expect(rows.map((row) => row.username)).toEqual(['ops.admin', 'read.only']);
    for (const row of rows) {
      expect(row.password_hash.startsWith('scrypt$')).toBe(true);
      expect(row.password_hash).not.toContain('password-123');
    }

    const audits = server.database.sqlite
      .prepare("SELECT event FROM auth_events WHERE event = 'admin_account.created'")
      .all() as { event: string }[];
    expect(audits).toHaveLength(2);

    expect(listAdminAccounts(server.database.db).map((account) => account.role)).toEqual([
      'admin',
      'viewer',
    ]);
  });

  it('rejects duplicate usernames and passwords containing the account name', async () => {
    await createAdminAccount(server.database.db, {
      username: 'ops.admin',
      password: 'initial-password-123',
      role: 'admin',
    });

    await expect(
      createAdminAccount(server.database.db, {
        username: 'ops.admin',
        password: 'another-password-123',
        role: 'viewer',
      }),
    ).rejects.toBeInstanceOf(AccountConflictError);

    await expect(
      createAdminAccount(server.database.db, {
        username: 'new.admin',
        password: 'new.admin-password',
        role: 'admin',
      }),
    ).rejects.toBeInstanceOf(PasswordPolicyError);

    const { changes } = server.database.sqlite
      .prepare('SELECT COUNT(*) AS changes FROM admin_accounts')
      .get() as { changes: number };
    expect(changes).toBe(1);
  });

  it('rejects a password reset for an unknown account', async () => {
    await expect(resetAdminPassword(server.database.db, 'missing.admin', 'some-password-123')).rejects.toBeInstanceOf(
      AccountNotFoundError,
    );
  });

  it('supports the full create, login, reset, and disable operator flow', async () => {
    await createAdminAccount(server.database.db, {
      username: 'ops.admin',
      password: TEST_PASSWORD,
      role: 'admin',
    });

    const client = new TestClient(server);
    expect((await client.login('ops.admin', TEST_PASSWORD)).status).toBe(200);

    const rotated = 'rotated-password-456';
    await resetAdminPassword(server.database.db, 'ops.admin', rotated);
    expect((await client.session()).status).toBe(401);
    expect((await new TestClient(server).login('ops.admin', rotated)).status).toBe(200);

    disableAdminAccount(server.database.db, 'ops.admin');
    expect((await new TestClient(server).login('ops.admin', rotated)).status).toBe(401);
  });

  it('refuses weak passwords when provisioning', async () => {
    await expect(
      createAdminAccount(server.database.db, {
        username: 'ops.admin',
        password: 'short',
        role: 'admin',
      }),
    ).rejects.toBeInstanceOf(PasswordPolicyError);
  });
});
