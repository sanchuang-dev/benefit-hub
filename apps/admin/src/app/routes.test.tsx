// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { installDomStubs, renderRoutes, resetUiPrefs } from '../test-utils/render-routes';
import { ADMIN_BASE_PATH } from './base-path';
import { jsonResponse, mockFetch } from '../test-utils/http';
import { UI_PREFS_STORAGE_KEY, useUiPrefs } from '../shared/lib/ui-prefs';

const ADMIN = {
  id: 'account-1',
  username: 'ops.admin',
  displayName: '运维管理员',
  role: 'admin' as const,
};

const SESSION = { admin: ADMIN, session: { expiresAt: Date.now() + 8 * 60 * 60 * 1000 } };

beforeAll(() => installDomStubs());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetUiPrefs();
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
    expect(screen.getByText('3C · BENEFIT HUB')).toBeTruthy();
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
    expect(screen.queryByText('供应商履约保持禁用')).toBeNull();
    for (const label of ['总览', '权益中心', '权益商品', '价值换算', '供给中心', '供应商管理', '供货目录', '开放平台', '下游应用', '接口管理', '订单履约', '业务订单', '平台治理', '账号与权限', '安全与会话', '操作审计', '平台状态']) {
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
    fireEvent.click(screen.getByRole('menuitem', { name: '业务订单' }));

    expect(await screen.findByRole('heading', { name: '业务订单' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /业务订单/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: '总览' }));
    expect(await screen.findByRole('heading', { name: '总览' })).toBeTruthy();
  }, 15_000);


  it('keeps owned products and the supplier catalog in separate navigation workspaces', async () => {
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return jsonResponse(200, SESSION);
      if (url.startsWith('/api/v1/catalog/products?')) {
        return jsonResponse(200, { products: [], page: 1, pageSize: 20, total: 0 });
      }
      if (url === '/api/v1/suppliers/yangmao') {
        return jsonResponse(200, {
          supplier: { key: 'yangmao', name: '上力', catalogRead: { supported: true, configured: true } },
        });
      }
      if (url.startsWith('/api/v1/catalog/supplier-products')) {
        return jsonResponse(200, {
          provider: 'yangmao', currency: 'CNY', observedAt: '2026-10-28T09:00:00Z', products: [],
        });
      }
      return undefined;
    });

    const { router } = renderRoutes('/catalog');
    expect(await screen.findByRole('menuitem', { name: '权益商品' })).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: '供货目录' }));

    // 供货目录 opens the supplier detail's 供货商品 sub-tab, and the work tab
    // keeps its own label instead of collapsing into 供应商管理.
    await waitFor(() => expect(router.state.location.pathname).toBe('/suppliers/yangmao'));
    expect(router.state.location.search).toBe('?tab=catalog');
    expect(await screen.findByRole('heading', { name: '上力' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '供货目录' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '供货商品', selected: true })).toBeTruthy();

    // Sub-tab switches clean the URL so the menu highlights the owning entry.
    fireEvent.click(screen.getByRole('tab', { name: '供应商概览' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(screen.getByRole('tab', { name: '供应商概览', selected: true })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '供应商管理' })).toBeTruthy();

    fireEvent.click(screen.getByRole('menuitem', { name: '权益商品' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/catalog'));
    expect(router.state.location.search).toBe('');
    expect(screen.getByRole('tab', { name: '权益商品' })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: '供货目录' }));
    await waitFor(() => expect(router.state.location.search).toBe('?tab=catalog'));
    expect(router.state.location.pathname).toBe('/suppliers/yangmao');
    expect(screen.getByRole('tab', { name: '供货商品', selected: true })).toBeTruthy();
  }, 45_000);

  it('keeps the click-only supplier detail sub-tabs usable without dirtying the URL', async () => {
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return jsonResponse(200, SESSION);
      if (url === '/api/v1/suppliers/yangmao') {
        return jsonResponse(200, {
          supplier: { key: 'yangmao', name: '上力', catalogRead: { supported: true, configured: true } },
        });
      }
      if (url.startsWith('/api/v1/catalog/supplier-products')) {
        return jsonResponse(200, {
          provider: 'yangmao', currency: 'CNY', observedAt: '2026-10-28T09:00:00Z', products: [],
        });
      }
      return undefined;
    });

    const { router } = renderRoutes('/suppliers/yangmao?tab=catalog');
    expect(await screen.findByRole('tab', { name: '供货商品', selected: true })).toBeTruthy();

    // 接入与规则 and 只读联调 are not deep-linkable, but clicking them must still
    // switch the pane while dropping the tab query.
    fireEvent.click(screen.getByRole('tab', { name: '接入与规则' }));
    expect(await screen.findByRole('button', { name: '编辑接入配置' })).toBeTruthy();
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(screen.getByRole('tab', { name: '接入与规则', selected: true })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: '只读联调' }));
    expect(await screen.findByRole('textbox', { name: '获授权测试手机号' })).toBeTruthy();
    expect(router.state.location.search).toBe('');
    expect(screen.getByRole('tab', { name: '只读联调', selected: true })).toBeTruthy();

    // The URL still governs 供货商品 when it is requested explicitly.
    fireEvent.click(screen.getByRole('tab', { name: '供货商品' }));
    await waitFor(() => expect(router.state.location.search).toBe('?tab=catalog'));
    expect(screen.getByRole('tab', { name: '供货商品', selected: true })).toBeTruthy();
  }, 30_000);

  it('filters the sidebar menu by search and restores it when cleared', async () => {
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return jsonResponse(200, SESSION);
      if (url === '/api/v1/system/status') {
        return jsonResponse(200, {
          service: 'benefit-hub',
          phase: 'auth-enabled',
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

    const search = await screen.findByLabelText('搜索菜单', undefined, { timeout: 5000 });
    fireEvent.change(search, { target: { value: '订单' } });

    expect(screen.getByRole('menuitem', { name: '业务订单' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: '权益商品' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: '操作审计' })).toBeNull();

    fireEvent.click(screen.getByRole('menuitem', { name: '业务订单' }));
    expect(await screen.findByRole('heading', { name: '业务订单' })).toBeTruthy();

    fireEvent.change(search, { target: { value: '不存在的菜单' } });
    expect(screen.getByText('未找到匹配的菜单')).toBeTruthy();

    fireEvent.change(search, { target: { value: '' } });
    expect(screen.getByRole('menuitem', { name: '权益商品' })).toBeTruthy();
    expect(screen.queryByText('未找到匹配的菜单')).toBeNull();
  }, 20_000);

  it('opens supplier management and shows the real catalog capability state', async () => {
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return jsonResponse(200, SESSION);
      if (url === '/api/v1/suppliers') return jsonResponse(200, {
        suppliers: [{
          key: 'yangmao',
          name: '上力',
          catalogRead: { supported: true, configured: false },
        }],
      });
      if (url === '/api/v1/catalog/supplier-products') return jsonResponse(200, {
        provider: 'yangmao', currency: 'CNY', observedAt: '2026-10-28T09:00:00Z',
        products: [{ productCode: 'FIXTURE-A', sellPriceCents: 1234 }],
      });
      if (url === '/api/v1/system/status') {
        return jsonResponse(200, {
          service: 'benefit-hub',
          phase: 'auth-enabled',
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
  }, 30_000);

  it('opens downstream applications with their actual authorization capability', async () => {
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return jsonResponse(200, SESSION);
      if (url.startsWith('/api/v1/applications?')) {
        return jsonResponse(200, {
          applications: [],
          page: 1,
          pageSize: 20,
          total: 0,
          runtimeAuthorizationEnforced: true,
        });
      }
      if (url === '/api/v1/system/status') {
        return jsonResponse(200, {
          service: 'benefit-hub',
          phase: 'auth-enabled',
          adminEnabled: true,
          authenticationRequired: true,
        });
      }
      return undefined;
    });

    renderRoutes('/');
    fireEvent.click(await screen.findByRole('menuitem', { name: '下游应用' }));
    expect(await screen.findByRole('heading', { name: '下游应用' })).toBeTruthy();
    expect(
      await screen.findByText(
        '运行时授权已生效：应用启停、凭证状态与商品授权都会约束真实机器调用。',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('tab', { name: /下游应用/ })).toBeTruthy();
  }, 30_000);

  it('opens planned platform destinations with their honest capability notices', async () => {
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return jsonResponse(200, SESSION);
      if (url === '/api/v1/system/status') {
        return jsonResponse(200, {
          service: 'benefit-hub',
          phase: 'auth-enabled',
          adminEnabled: true,
          authenticationRequired: true,
        });
      }
      return undefined;
    });
    renderRoutes('/');

    for (const [name, notice] of [
      ['价值换算', '价值换算规则服务尚未接入'],
      ['接口管理', '配置驱动的接口生成与发布尚未接入'],
    ]) {
      fireEvent.click(await screen.findByRole('menuitem', { name }));
      expect(await screen.findByRole('heading', { name })).toBeTruthy();
      expect(screen.getByText(notice)).toBeTruthy();
      expect(screen.getByRole('tab', { name: new RegExp(name) })).toBeTruthy();
    }
  }, 30_000);

  it('restores session-local work tabs after a refresh and drops unknown routes', async () => {
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return jsonResponse(200, SESSION);
      if (url === '/api/v1/system/status') {
        return jsonResponse(200, {
          service: 'benefit-hub',
          phase: 'auth-enabled',
          adminEnabled: true,
          authenticationRequired: true,
        });
      }
      if (url.startsWith('/api/v1/catalog/products?')) {
        return jsonResponse(200, { products: [], page: 1, pageSize: 20, total: 0 });
      }
      return undefined;
    });

    // Simulate a reload after an older build left a route that no longer exists.
    sessionStorage.setItem(
      UI_PREFS_STORAGE_KEY,
      JSON.stringify({
        state: {
          openTabs: ['/', '/catalog', '/removed-route'],
          catalogView: 'table',
          supplierView: 'table',
          mappingTab: 'current',
        },
        version: 1,
      }),
    );
    await useUiPrefs.persist.rehydrate();

    renderRoutes('/catalog');

    expect(await screen.findByRole('heading', { name: '权益商品' }, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '总览' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '权益商品' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: '账号与权限' })).toBeNull();
  }, 15_000);

  it('keeps the 总览 tab when the console is opened directly on a module route', async () => {
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return jsonResponse(200, SESSION);
      if (url === '/api/v1/system/status') {
        return jsonResponse(200, {
          service: 'benefit-hub',
          phase: 'auth-enabled',
          adminEnabled: true,
          authenticationRequired: true,
        });
      }
      if (url.startsWith('/api/v1/catalog/products?')) {
        return jsonResponse(200, { products: [], page: 1, pageSize: 20, total: 0 });
      }
      return undefined;
    });

    renderRoutes('/catalog');

    expect(await screen.findByRole('heading', { name: '权益商品' }, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '总览' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '权益商品', selected: true })).toBeTruthy();
  }, 15_000);

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

describe('console mount', () => {
  it('serves a module URL under /admin with the unchanged internal route key', async () => {
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return jsonResponse(200, SESSION);
      if (url === '/api/v1/system/status') {
        return jsonResponse(200, {
          service: 'benefit-hub',
          phase: 'auth-enabled',
          adminEnabled: true,
          authenticationRequired: true,
        });
      }
      if (url.startsWith('/api/v1/catalog/products?')) {
        return jsonResponse(200, { products: [], page: 1, pageSize: 20, total: 0 });
      }
      return undefined;
    });

    // `/admin/catalog` is the public URL; `routes.tsx` still defines `catalog`.
    const { router } = renderRoutes('/admin/catalog', { basename: ADMIN_BASE_PATH });

    expect(await screen.findByRole('heading', { name: '权益商品' }, { timeout: 5000 })).toBeTruthy();
    expect(router.state.location.pathname).toBe('/admin/catalog');
    expect(screen.getByRole('tab', { name: '权益商品', selected: true })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '总览' })).toBeTruthy();
  }, 15_000);
});
