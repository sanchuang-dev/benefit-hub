// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { installDomStubs, renderRoutes } from '../test-utils/render-routes';

const ADMIN = {
  id: 'account-1',
  username: 'ops.admin',
  displayName: '运维管理员',
  role: 'admin' as const,
};

const SESSION = { admin: ADMIN, session: { expiresAt: Date.now() + 8 * 60 * 60 * 1000 } };

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

describe('unauthenticated access', () => {
  it('redirects a protected URL to the brand cover and login form', async () => {
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') {
        return jsonResponse(401, { error: 'UNAUTHENTICATED', message: '请先登录' });
      }
      return undefined;
    });

    renderRoutes('/settings');

    expect(await screen.findByText('运营后台登录', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('权益服务平台')).toBeTruthy();
    expect(screen.getByText(/SAN CHUANG/)).toBeTruthy();
    expect(screen.getByLabelText('账号')).toBeTruthy();
    expect(screen.getByLabelText('密码')).toBeTruthy();
    expect(screen.queryByText('管理员账户')).toBeNull();
  });

  it('explains an expired session on the login screen', async () => {
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') {
        return jsonResponse(401, { error: 'SESSION_EXPIRED', message: '登录已过期，请重新登录' });
      }
      return undefined;
    });

    renderRoutes('/');

    expect(await screen.findByText('登录已过期，请重新登录。', undefined, { timeout: 5000 })).toBeTruthy();
  });
});

describe('login flow', () => {
  it('authenticates and enters the protected platform shell', async () => {
    mockFetch((url, init) => {
      if (url === '/api/v1/auth/session') {
        return jsonResponse(401, { error: 'UNAUTHENTICATED', message: '请先登录' });
      }
      if (url === '/api/v1/auth/csrf') return jsonResponse(200, { csrfToken: 'csrf-token' });
      if (url === '/api/v1/auth/login' && init?.method === 'POST') {
        return jsonResponse(200, { ...SESSION, csrfToken: 'csrf-token-2' });
      }
      if (url === '/api/v1/system/status') {
        return jsonResponse(200, {
          service: 'benefit-hub',
          phase: 'auth-enabled',
          vendorFulfillmentEnabled: false,
          adminEnabled: true,
          authenticationRequired: true,
        });
      }
      return undefined;
    });

    renderRoutes('/login');

    fireEvent.change(await screen.findByLabelText('账号'), { target: { value: 'ops.admin' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'secret-password-1' } });
    fireEvent.click(screen.getByRole('button', { name: '登 录' }));

    expect(await screen.findByRole('heading', { name: '总览' }, { timeout: 5000 })).toBeTruthy();
    expect(await screen.findByText('供应商履约保持禁用')).toBeTruthy();
    for (const label of ['总览', '商品管理', '供应商管理', '下游应用', '价值换算', '接口管理', '发放记录', '系统设置']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getAllByText('运维管理员').length).toBeGreaterThan(0);
    expect(screen.getByRole('tab', { name: '总览' })).toBeTruthy();

    const loginCall = (vi.mocked(fetch).mock.calls as [string, RequestInit][]).find(
      ([url]) => url === '/api/v1/auth/login',
    );
    expect(loginCall).toBeDefined();
    const [, loginInit] = loginCall as [string, RequestInit];
    expect((loginInit.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-token');
  }, 10_000);

  it('keeps the form values and shows a generic error for bad credentials', async () => {
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') {
        return jsonResponse(401, { error: 'UNAUTHENTICATED', message: '请先登录' });
      }
      if (url === '/api/v1/auth/csrf') return jsonResponse(200, { csrfToken: 'csrf-token' });
      if (url === '/api/v1/auth/login') {
        return jsonResponse(401, { error: 'INVALID_CREDENTIALS', message: '账号或密码不正确' });
      }
      return undefined;
    });

    renderRoutes('/login');

    fireEvent.change(await screen.findByLabelText('账号'), { target: { value: 'ops.admin' } });
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'wrong-password-1' } });
    fireEvent.click(screen.getByRole('button', { name: '登 录' }));

    expect(await screen.findByText('账号或密码不正确', undefined, { timeout: 5000 })).toBeTruthy();
    expect((screen.getByLabelText('账号') as HTMLInputElement).value).toBe('ops.admin');
    expect(screen.getByText('运营后台登录')).toBeTruthy();
  });

  // Real route transitions through Ant Design can exceed Vitest's 5s default on a loaded CI runner.
  it('opens visited modules as session-local route tabs', async () => {
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return jsonResponse(200, SESSION);
      if (url === '/api/v1/system/status') {
        return jsonResponse(200, {
          service: 'benefit-hub',
          phase: 'auth-enabled',
          vendorFulfillmentEnabled: false,
          adminEnabled: true,
          authenticationRequired: true,
        });
      }
      if (url.startsWith('/api/v1/operations/orders?')) {
        return jsonResponse(200, { orders: [], page: 1, pageSize: 20, total: 0 });
      }
      return undefined;
    });

    renderRoutes('/');

    expect(await screen.findByRole('tab', { name: '总览' }, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: '发放记录' }));

    expect(await screen.findByRole('heading', { name: '发放记录' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /发放记录/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: '总览' }));
    expect(await screen.findByRole('heading', { name: '总览' })).toBeTruthy();
  }, 15_000);


  it('opens each platform domain from the first-level sidebar without inventing a backend', async () => {
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return jsonResponse(200, SESSION);
      if (url === '/api/v1/suppliers') return jsonResponse(200, {
        suppliers: [{
          key: 'yangmao',
          name: '上力',
          catalogRead: { supported: true, configured: false },
          fulfillmentEnabled: false,
        }],
      });
      if (url === '/api/v1/catalog/supplier-products') return jsonResponse(200, { provider: 'yangmao', currency: 'CNY', observedAt: '2026-10-28T09:00:00Z', products: [{ productCode: 'FIXTURE-A', sellPriceCents: 1234 }] });
      if (url === '/api/v1/system/status') {
        return jsonResponse(200, {
          service: 'benefit-hub',
          phase: 'auth-enabled',
          vendorFulfillmentEnabled: false,
          adminEnabled: true,
          authenticationRequired: true,
        });
      }
      return undefined;
    });

    renderRoutes('/');

    fireEvent.click(await screen.findByRole('menuitem', { name: '供应商管理' }));
    expect(await screen.findByRole('heading', { name: '供应商管理' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: '查看供应商' })).toBeTruthy();

    for (const [name, notice] of [
      ['下游应用', '应用登记与授权管理 API 尚未接入'],
      ['价值换算', '价值换算规则服务尚未接入'],
      ['接口管理', '配置驱动的接口生成与发布尚未接入'],
    ]) {
      fireEvent.click(await screen.findByRole('menuitem', { name }));
      expect(await screen.findByRole('heading', { name })).toBeTruthy();
      expect(screen.getByText(notice)).toBeTruthy();
      expect(screen.getByRole('tab', { name: new RegExp(name) })).toBeTruthy();
    }
  // Four Ant Design route transitions render asynchronously on loaded CI runners;
  // retain the full assertions with a bounded 45s integration budget.
  }, 45_000);

  it('logs out through the user menu and returns to the login screen', async () => {
    let loggedOut = false;
    mockFetch((url, init) => {
      if (url === '/api/v1/auth/session') {
        return loggedOut
          ? jsonResponse(401, { error: 'UNAUTHENTICATED', message: '请先登录' })
          : jsonResponse(200, SESSION);
      }
      if (url === '/api/v1/system/status') {
        return jsonResponse(200, {
          service: 'benefit-hub',
          phase: 'auth-enabled',
          vendorFulfillmentEnabled: false,
          adminEnabled: true,
          authenticationRequired: true,
        });
      }
      if (url === '/api/v1/auth/logout' && init?.method === 'POST') {
        loggedOut = true;
        return new Response(null, { status: 204 });
      }
      if (url === '/api/v1/auth/csrf') return jsonResponse(200, { csrfToken: 'csrf-token' });
      return undefined;
    });

    renderRoutes('/');

    fireEvent.click(await screen.findByRole('button', { name: /运维管理员/ }));
    const logoutItem = await screen.findByText('退出登录');
    fireEvent.click(logoutItem);

    await waitFor(() => expect(screen.getByText('已安全退出登录。')).toBeTruthy(), {
      timeout: 5000,
    });
    expect(screen.getByText('运营后台登录')).toBeTruthy();
  });
});
