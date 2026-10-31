import { afterEach, describe, expect, it } from 'vitest';
import { systemRuntimeResponseSchema } from '@sanchuang-dev/benefit-contracts';
import { TEST_PASSWORD, TestClient, TestServer, seedAccount } from '../helpers/test-server.js';

const ENDPOINT = '/api/v1/system/runtime';

const YANGMAO_CREDENTIALS = {
  baseUrl: 'https://vendor.invalid',
  appKey: 'fixture-key-should-never-leak',
  appSecret: 'fixture-secret-should-never-leak',
};

let server: TestServer | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

function startServer(overrides: ConstructorParameters<typeof TestServer>[0] = {}): TestServer {
  const testServer = new TestServer(overrides);
  server = testServer;
  return testServer;
}

async function login(role: 'admin' | 'viewer' = 'admin'): Promise<TestClient> {
  const testServer = server;
  if (!testServer) throw new Error('server not started');
  await seedAccount(testServer, { username: `runtime.${role}`, role });
  const client = new TestClient(testServer);
  const response = await client.login(`runtime.${role}`, TEST_PASSWORD);
  expect(response.status).toBe(200);
  return client;
}

describe('system runtime snapshot', () => {
  it('requires a session', async () => {
    const testServer = startServer();
    const response = await new TestClient(testServer).request(ENDPOINT);
    expect(response.status).toBe(401);
  });

  it('reports effective security facts and configuration presence without secrets', async () => {
    const testServer = startServer({
      sessionTtlMs: 2 * 60 * 60 * 1000,
      cookieSecure: false,
      trustProxy: true,
      yangmaoInrice: YANGMAO_CREDENTIALS,
      supplierMasterKey: Buffer.alloc(32, 7),
      businessOrderClients: {
        clients: [
          { businessSource: 'local-life', tokenSha256: Buffer.alloc(32, 1) },
          { businessSource: 'card-doctor', tokenSha256: Buffer.alloc(32, 2) },
        ],
      },
    });
    const client = await login('viewer');

    const response = await client.request(ENDPOINT);
    expect(response.status).toBe(200);

    const raw = await response.text();
    // Capability facts must not become a credential side channel.
    expect(raw).not.toContain(YANGMAO_CREDENTIALS.appKey);
    expect(raw).not.toContain(YANGMAO_CREDENTIALS.appSecret);
    expect(raw).not.toContain(YANGMAO_CREDENTIALS.baseUrl);
    expect(raw).not.toContain(testServer.file);

    const parsed = systemRuntimeResponseSchema.safeParse(JSON.parse(raw));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const runtime = parsed.data.runtime;
    expect(runtime.service).toBe('benefit-hub');
    expect(runtime.nodeVersion).toBe(process.version);
    expect(runtime.build).toEqual({ version: null, commit: null, builtAt: null });
    expect(runtime.database.healthy).toBe(true);
    expect(runtime.database.appliedMigrations).toBeGreaterThan(0);
    expect(runtime.database.latestMigration).toBeTruthy();
    expect(runtime.security).toEqual({
      sessionTtlHours: 2,
      cookieSecure: false,
      trustProxy: true,
      loginFailure: { perAccount: 5, perAddress: 20, windowMinutes: 15 },
      password: {
        minLength: 12,
        maxLength: 256,
        mustNotContainUsername: true,
        noLeadingTrailingWhitespace: true,
      },
    });
    expect(runtime.capabilities).toEqual({
      supplierReadCredentialsConfigured: true,
      supplierMasterKeyConfigured: true,
      businessOrderClientCount: 2,
    });
  });

  it('reports unconfigured capabilities as false/zero instead of guessing', async () => {
    startServer();
    const client = await login();

    const body = (await (await client.request(ENDPOINT)).json()) as {
      runtime: {
        capabilities: {
          supplierReadCredentialsConfigured: boolean;
          supplierMasterKeyConfigured: boolean;
          businessOrderClientCount: number;
        };
      };
    };

    expect(body.runtime.capabilities).toEqual({
      supplierReadCredentialsConfigured: false,
      supplierMasterKeyConfigured: false,
      businessOrderClientCount: 0,
    });
  });

  it('passes the injected build stamp through without inventing one', async () => {
    const builtAt = Date.parse('2026-10-29T04:00:00.000Z');
    startServer({
      buildInfo: { version: '0.1.0', commit: 'abc1234', builtAt },
    });
    const client = await login();

    const body = (await (await client.request(ENDPOINT)).json()) as {
      runtime: { build: { version: string | null; commit: string | null; builtAt: number | null } };
    };

    expect(body.runtime.build).toEqual({ version: '0.1.0', commit: 'abc1234', builtAt });
  });
});
