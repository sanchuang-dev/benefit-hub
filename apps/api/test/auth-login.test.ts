import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedAccount, TEST_PASSWORD, TestClient, TestServer } from './helpers/test-server.js';

let server: TestServer;

beforeEach(() => {
  server = new TestServer();
});

afterEach(() => {
  server.close();
});

describe('admin login', () => {
  it('rejects a login without the CSRF double-submit token', async () => {
    await seedAccount(server, { username: 'ops.admin' });
    const client = new TestClient(server);

    const response = await client.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ops.admin', password: TEST_PASSWORD }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'CSRF_TOKEN_INVALID',
      message: '请求校验失败，请刷新页面后重试',
    });
    expect(await client.session().then((r) => r.status)).toBe(401);
  });

  it('rejects a cross-origin login even with a valid CSRF token', async () => {
    await seedAccount(server, { username: 'ops.admin' });
    const client = new TestClient(server);
    const token = await client.csrfToken();

    const response = await client.request('/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': token,
        origin: 'https://attacker.example',
      },
      body: JSON.stringify({ username: 'ops.admin', password: TEST_PASSWORD }),
    });

    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe('CSRF_ORIGIN_REJECTED');
  });

  it('issues a hardened session cookie and returns no credential material', async () => {
    await seedAccount(server, { username: 'ops.admin', displayName: '运维管理员' });
    const client = new TestClient(server);

    const response = await client.login('ops.admin', TEST_PASSWORD);
    expect(response.status).toBe(200);

    const setCookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith('bh_session='));
    expect(setCookie).toBeDefined();
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).toMatch(/Max-Age=28800/);

    expect(response.headers.get('cache-control')).toBe('no-store');

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.admin).toMatchObject({
      username: 'ops.admin',
      displayName: '运维管理员',
      role: 'admin',
    });
    expect(typeof body.csrfToken).toBe('string');
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(TEST_PASSWORD);
    expect(serialized).not.toContain('passwordHash');

    const session = await client.session();
    expect(session.status).toBe(200);
    expect(session.headers.get('cache-control')).toBe('no-store');
    const payload = (await session.json()) as { admin: { username: string }; session: { expiresAt: number } };
    expect(payload.admin.username).toBe('ops.admin');
    expect(payload.session.expiresAt).toBeGreaterThan(Date.now());
  });

  it('returns an identical generic error for a wrong password and an unknown account', async () => {
    await seedAccount(server, { username: 'ops.admin' });
    const wrongPassword = new TestClient(server).login('ops.admin', 'wrong-password-0000');
    const unknownAccount = new TestClient(server).login('missing.admin', TEST_PASSWORD);

    const [wrongResponse, unknownResponse] = await Promise.all([wrongPassword, unknownAccount]);
    expect(wrongResponse.status).toBe(401);
    expect(unknownResponse.status).toBe(401);
    expect(await wrongResponse.json()).toEqual(await unknownResponse.json());
    expect(await new TestClient(server).session().then((r) => r.status)).toBe(401);
  });

  it('rate limits repeated failures for the same account, including correct passwords', async () => {
    await seedAccount(server, { username: 'ops.admin' });
    const client = new TestClient(server);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await client.login('ops.admin', `wrong-password-${attempt}`);
      expect(response.status).toBe(401);
    }

    const limited = await client.login('ops.admin', TEST_PASSWORD);
    expect(limited.status).toBe(429);
    const retryAfter = Number(limited.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(0);
    expect((await limited.json()).error).toBe('TOO_MANY_ATTEMPTS');
  });

  it('reserves limiter slots before concurrent password checks', async () => {
    await seedAccount(server, { username: 'ops.admin' });

    // Each client obtains its own CSRF token. All 12 password checks are
    // submitted concurrently; only five can reach credential verification.
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        new TestClient(server).login('ops.admin', `incorrect-password-${index}`),
      ),
    );
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 401)).toHaveLength(5);
    expect(statuses.filter((status) => status === 429)).toHaveLength(7);
  });

  it('does not clear address-wide failures after another account logs in successfully', async () => {
    await seedAccount(server, { username: 'ops.admin' });
    const client = new TestClient(server);

    expect((await client.login('unknown-0', 'wrong-password')).status).toBe(401);
    expect((await client.login('ops.admin', TEST_PASSWORD)).status).toBe(200);
    for (let i = 1; i < 20; i += 1) {
      expect((await client.login(`unknown-${i}`, 'wrong-password')).status).toBe(401);
    }
    const limited = await client.login('another-user', 'wrong-password');
    expect(limited.status).toBe(429);
    expect((await limited.json()).error).toBe('TOO_MANY_ATTEMPTS');
  });

  it('does not authenticate an account with invalid input lengths', async () => {
    await seedAccount(server, { username: 'ops.admin' });
    const client = new TestClient(server);
    const token = await client.csrfToken();

    for (const body of [{}, { username: '' }, { username: 'ops.admin' }, { username: 'ops.admin', password: '' }]) {
      const response = await client.post('/api/v1/auth/login', body, token);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe('INVALID_REQUEST');
    }
  });
});

describe('session lifecycle', () => {
  it('requires a session for the session endpoint', async () => {
    const response = await new TestClient(server).session();
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe('UNAUTHENTICATED');
  });

  it('rejects an expired session with an explicit reason', async () => {
    await seedAccount(server, { username: 'ops.admin' });
    const client = new TestClient(server);
    expect((await client.login('ops.admin', TEST_PASSWORD)).status).toBe(200);

    server.database.sqlite
      .prepare('UPDATE admin_sessions SET expires_at = ?')
      .run(Date.now() - 60_000);

    const response = await client.session();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'SESSION_EXPIRED',
      message: '登录已过期，请重新登录',
    });
  });

  it('keeps sessions valid across a server restart (SQLite persistence)', async () => {
    await seedAccount(server, { username: 'ops.admin' });
    const client = new TestClient(server);
    expect((await client.login('ops.admin', TEST_PASSWORD)).status).toBe(200);

    server.restart();

    const response = await new TestClient(server).request('/api/v1/auth/session', {
      headers: { cookie: `bh_session=${client.cookie('bh_session')}` },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { admin: { username: string } }).admin.username).toBe('ops.admin');
  });

  it('revokes the session on logout and clears the cookie', async () => {
    await seedAccount(server, { username: 'ops.admin' });
    const client = new TestClient(server);
    expect((await client.login('ops.admin', TEST_PASSWORD)).status).toBe(200);
    const capturedToken = client.cookie('bh_session');

    const logout = await client.post('/api/v1/auth/logout');
    expect(logout.status).toBe(204);
    expect(client.cookie('bh_session')).toBeUndefined();

    // Replaying the captured cookie must not restore access.
    const replayed = await client.request('/api/v1/auth/session', {
      headers: { cookie: `bh_session=${capturedToken}` },
    });
    expect(replayed.status).toBe(401);
    expect((await client.session()).status).toBe(401);
  });

  it('records audit events without passwords or tokens', async () => {
    await seedAccount(server, { username: 'ops.admin' });
    const client = new TestClient(server);
    await client.login('ops.admin', 'wrong-password-0000');
    await client.login('ops.admin', TEST_PASSWORD);
    await client.post('/api/v1/auth/logout');

    const rows = server.database.sqlite
      .prepare('SELECT event, detail FROM auth_events ORDER BY created_at')
      .all() as { event: string; detail: string | null }[];
    expect(rows.map((row) => row.event)).toEqual([
      'admin_account.created',
      'login.failed',
      'login.succeeded',
      'logout',
    ]);

    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(TEST_PASSWORD);
    expect(dump).not.toContain('wrong-password');
    expect(dump).not.toContain('bh_session');
  });
});
