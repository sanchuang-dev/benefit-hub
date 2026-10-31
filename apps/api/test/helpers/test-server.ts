import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { createApp } from '../../src/app.js';
import type { AppConfig } from '../../src/config.js';
import { openDatabase, runMigrations, type DatabaseHandle } from '../../src/db/client.js';
import type { AdminRole } from '../../src/modules/auth/accounts.js';
import { createAdminAccount } from '../../src/modules/auth/admin-operations.js';
import type { AppEnv } from '../../src/middleware/auth.js';

export const TEST_PASSWORD = 'test-password-9f2a';

/** Real SQLite file per test so migrations, WAL and restarts are exercised. */
export class TestServer {
  readonly directory: string;
  readonly file: string;
  readonly config: AppConfig;
  database: DatabaseHandle;
  app: Hono<AppEnv>;
  private closed = false;

  constructor(overrides: Partial<AppConfig> = {}) {
    this.directory = mkdtempSync(join(tmpdir(), 'benefit-hub-test-'));
    this.file = join(this.directory, 'benefit.sqlite');
    this.config = {
      databaseFile: this.file,
      host: '127.0.0.1',
      port: 0,
      cookieSecure: true,
      trustProxy: false,
      sessionTtlMs: 8 * 60 * 60 * 1000,
      yangmaoInrice: null,
      supplierMasterKey: null,
      businessOrderClients: null,
      verifiedBTravelProducts: {},
      bLiveWritesEnabled: false,
      buildInfo: { version: null, commit: null, builtAt: null },
      ...overrides,
      dLiveWritesEnabled: overrides.dLiveWritesEnabled ?? false,
    };
    this.database = openDatabase(this.file);
    runMigrations(this.database.sqlite);
    this.app = createApp({ db: this.database.db, config: this.config });
  }

  /** Simulates a container restart: same file, brand new connection and app. */
  restart(): void {
    this.closeDatabase();
    this.database = openDatabase(this.file);
    this.closed = false;
    this.app = createApp({ db: this.database.db, config: this.config });
  }

  /** Closes the SQLite handle without deleting the file (restart/upgrade shape). */
  closeDatabase(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  close(): void {
    this.closeDatabase();
    rmSync(this.directory, { recursive: true, force: true });
  }
}

export async function seedAccount(
  server: TestServer,
  options: { username: string; password?: string; role?: AdminRole; displayName?: string },
) {
  return createAdminAccount(server.database.db, {
    username: options.username,
    password: options.password ?? TEST_PASSWORD,
    role: options.role ?? 'admin',
    displayName: options.displayName,
  });
}

/** Minimal cookie jar so tests carry HttpOnly cookies exactly like a browser. */
export class TestClient {
  private readonly cookies = new Map<string, string>();

  constructor(private readonly server: TestServer) {}

  cookie(name: string): string | undefined {
    return this.cookies.get(name);
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookies.size > 0) {
      headers.set(
        'cookie',
        [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '),
      );
    }

    const response = await this.server.app.request(path, { ...init, headers });
    for (const setCookie of response.headers.getSetCookie()) this.store(setCookie);
    return response;
  }

  private store(setCookie: string): void {
    const [pair = ''] = setCookie.split(';');
    const separator = pair.indexOf('=');
    if (separator < 0) return;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    const lowered = setCookie.toLowerCase();
    const expired = /max-age=0(;|$)/.test(lowered) || lowered.includes('expires=thu, 01 jan 1970');
    if (expired || value === '') this.cookies.delete(name);
    else this.cookies.set(name, value);
  }

  async csrfToken(): Promise<string> {
    const response = await this.request('/api/v1/auth/csrf');
    const body = (await response.json()) as { csrfToken: string };
    return body.csrfToken;
  }

  async post(path: string, body?: unknown, csrfToken?: string): Promise<Response> {
    return this.mutate('POST', path, body, csrfToken);
  }

  async patch(path: string, body?: unknown, csrfToken?: string): Promise<Response> {
    return this.mutate('PATCH', path, body, csrfToken);
  }

  async put(path: string, body?: unknown, csrfToken?: string): Promise<Response> {
    return this.mutate('PUT', path, body, csrfToken);
  }

  private async mutate(
    method: 'POST' | 'PATCH' | 'PUT',
    path: string,
    body?: unknown,
    csrfToken?: string,
  ): Promise<Response> {
    const token = csrfToken ?? this.cookies.get('bh_csrf') ?? (await this.csrfToken());
    return this.request(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-csrf-token': token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async login(username: string, password: string): Promise<Response> {
    const token = await this.csrfToken();
    return this.post('/api/v1/auth/login', { username, password }, token);
  }

  session(): Promise<Response> {
    return this.request('/api/v1/auth/session');
  }
}
