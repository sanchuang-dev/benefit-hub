// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { installDomStubs, renderRoutes } from '../test-utils/render-routes';

const SESSION_EXPIRES_AT = Date.now() + 60 * 60 * 1000;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const response = await handler(url, init);
    if (!response) throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`);
    return response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeAll(() => installDomStubs());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('settings permissions', () => {
  it('shows an explanatory read-only state instead of the account table for viewers', async () => {
    const fetchMock = mockFetch((url) => {
      if (url === '/api/v1/auth/session') {
        return jsonResponse(200, {
          admin: {
            id: 'account-2',
            username: 'read.only',
            displayName: '只读观察员',
            role: 'viewer',
          },
          session: { expiresAt: SESSION_EXPIRES_AT },
        });
      }
      return undefined;
    });

    renderRoutes('/settings');

    expect(await screen.findByText('当前为只读身份', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getAllByText('只读观察员').length).toBeGreaterThan(0);
    // The account table is not rendered at all for a viewer.
    expect(screen.queryByRole('columnheader')).toBeNull();

    const accountCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/api/v1/admin/accounts'),
    );
    expect(accountCalls).toHaveLength(0);
  });

  it('lists accounts for administrators', async () => {
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') {
        return jsonResponse(200, {
          admin: {
            id: 'account-1',
            username: 'ops.admin',
            displayName: '运维管理员',
            role: 'admin',
          },
          session: { expiresAt: SESSION_EXPIRES_AT },
        });
      }
      if (url === '/api/v1/admin/accounts') {
        return jsonResponse(200, {
          accounts: [
            {
              id: 'account-1',
              username: 'ops.admin',
              displayName: '运维管理员',
              role: 'admin',
              createdAt: SESSION_EXPIRES_AT,
              disabled: false,
            },
            {
              id: 'account-2',
              username: 'read.only',
              displayName: '只读观察员',
              role: 'viewer',
              createdAt: SESSION_EXPIRES_AT,
              disabled: false,
            },
          ],
        });
      }
      return undefined;
    });

    renderRoutes('/settings');

    expect(
      await screen.findByRole('columnheader', { name: '创建时间' }, { timeout: 5000 }),
    ).toBeTruthy();
    expect(await screen.findByText('read.only', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getAllByText('只读观察员').length).toBeGreaterThan(0);
    expect(screen.queryByText('当前为只读身份')).toBeNull();
  });

  it('surfaces a forbidden response instead of hiding the failure', async () => {
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') {
        return jsonResponse(200, {
          admin: {
            id: 'account-1',
            username: 'ops.admin',
            displayName: '运维管理员',
            role: 'admin',
          },
          session: { expiresAt: SESSION_EXPIRES_AT },
        });
      }
      if (url === '/api/v1/admin/accounts') {
        return jsonResponse(403, { error: 'FORBIDDEN', message: '当前身份无权执行该操作' });
      }
      return undefined;
    });

    renderRoutes('/settings');

    expect(await screen.findByText('无法加载管理员账户', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('当前身份无权执行该操作')).toBeTruthy();
  });
});
