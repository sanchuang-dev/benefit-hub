// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { installDomStubs, renderRoutes } from '../test-utils/render-routes';
import { jsonResponse, mockFetch } from '../test-utils/http';

const SESSION_EXPIRES_AT = Date.now() + 60 * 60 * 1000;

const ADMIN_SESSION = {
  admin: {
    id: 'account-1',
    username: 'ops.admin',
    displayName: '运维管理员',
    role: 'admin',
  },
  session: { expiresAt: SESSION_EXPIRES_AT },
};

const VIEWER_SESSION = {
  admin: {
    id: 'account-2',
    username: 'read.only',
    displayName: '只读观察员',
    role: 'viewer',
  },
  session: { expiresAt: SESSION_EXPIRES_AT },
};

const ADMIN_ACCOUNTS = {
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
};

/** Fixture mirrors the server contract; no value is derived by the test. */
const RUNTIME = {
  runtime: {
    service: 'benefit-hub',
    generatedAt: SESSION_EXPIRES_AT - 1_000,
    startedAt: SESSION_EXPIRES_AT - 3 * 60 * 60 * 1000,
    nodeVersion: 'v22.14.0',
    build: { version: null, commit: null, builtAt: null },
    database: {
      healthy: true,
      appliedMigrations: 9,
      latestMigration: '0009_benefit_order_grants',
    },
    security: {
      sessionTtlHours: 8,
      cookieSecure: true,
      trustProxy: false,
      loginFailure: { perAccount: 5, perAddress: 20, windowMinutes: 15 },
      password: {
        minLength: 12,
        maxLength: 256,
        mustNotContainUsername: true,
        noLeadingTrailingWhitespace: true,
      },
    },
    capabilities: {
      supplierReadCredentialsConfigured: true,
      supplierMasterKeyConfigured: false,
      businessOrderClientCount: 2,
    },
  },
};

const AUDIT_EVENTS = {
  events: [
    {
      id: 'event-1',
      event: 'login.succeeded',
      category: 'authentication',
      account: {
        id: 'account-1',
        username: 'ops.admin',
        displayName: '运维管理员',
      },
      detail: null,
      createdAt: SESSION_EXPIRES_AT,
    },
  ],
  page: 1,
  pageSize: 20,
  total: 1,
};

beforeAll(() => installDomStubs());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('settings account permissions', () => {
  it('shows an explanatory read-only state instead of the account table for viewers', async () => {
    const fetchMock = mockFetch((url) => {
      if (url === '/api/v1/auth/session') return jsonResponse(200, VIEWER_SESSION);
      return undefined;
    });

    renderRoutes('/settings/accounts');

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
      if (url === '/api/v1/auth/session') return jsonResponse(200, ADMIN_SESSION);
      if (url === '/api/v1/admin/accounts') return jsonResponse(200, ADMIN_ACCOUNTS);
      return undefined;
    });

    renderRoutes('/settings/accounts');

    expect(
      await screen.findByRole('columnheader', { name: '创建时间' }, { timeout: 5000 }),
    ).toBeTruthy();
    expect(await screen.findByText('read.only', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getAllByText('只读观察员').length).toBeGreaterThan(0);
    expect(screen.queryByText('当前为只读身份')).toBeNull();
  });

  it('surfaces a forbidden response instead of hiding the failure', async () => {
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return jsonResponse(200, ADMIN_SESSION);
      if (url === '/api/v1/admin/accounts') {
        return jsonResponse(403, { error: 'FORBIDDEN', message: '当前身份无权执行该操作' });
      }
      return undefined;
    });

    renderRoutes('/settings/accounts');

    expect(await screen.findByText('无法加载管理员账户', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('当前身份无权执行该操作')).toBeTruthy();
  });
});

describe('settings governance pages', () => {
  it('redirects /settings to the account workspace instead of rendering a blank parent page', async () => {
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return jsonResponse(200, ADMIN_SESSION);
      if (url === '/api/v1/admin/accounts') return jsonResponse(200, ADMIN_ACCOUNTS);
      return undefined;
    });

    const { router } = renderRoutes('/settings');

    expect(
      await screen.findByRole('heading', { name: '账号与权限' }, { timeout: 5000 }),
    ).toBeTruthy();
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/accounts'));
    expect(screen.getByRole('tab', { name: /账号与权限/ })).toBeTruthy();
  });

  it('keeps retired ?tab= deep links working', async () => {
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return jsonResponse(200, ADMIN_SESSION);
      if (url.startsWith('/api/v1/admin/audit-events')) return jsonResponse(200, AUDIT_EVENTS);
      return undefined;
    });

    const { router } = renderRoutes('/settings?tab=audit');

    expect(await screen.findByText('登录成功', undefined, { timeout: 5000 })).toBeTruthy();
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/audit'));
    expect(router.state.location.search).toBe('');
    expect(screen.getByRole('heading', { name: '操作审计' })).toBeTruthy();
  });

  it('renders the runtime workspace at its own deep link', async () => {
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return jsonResponse(200, ADMIN_SESSION);
      if (url === '/api/v1/system/runtime') return jsonResponse(200, RUNTIME);
      return undefined;
    });

    renderRoutes('/settings/runtime');

    expect(await screen.findByRole('heading', { name: '平台状态' })).toBeTruthy();
    expect(await screen.findByText('数据库已连接', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('9 个')).toBeTruthy();
    expect(screen.getByText('0009_benefit_order_grants')).toBeTruthy();
    expect(screen.getAllByText('未注入').length).toBeGreaterThan(0);
    expect(screen.getByText('2 个业务来源')).toBeTruthy();
    expect(screen.getByText('未配置')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /平台状态/ })).toBeTruthy();
  });

  it('renders effective security policy from the server, not hard-coded copy', async () => {
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return jsonResponse(200, ADMIN_SESSION);
      if (url === '/api/v1/system/runtime') return jsonResponse(200, RUNTIME);
      return undefined;
    });

    renderRoutes('/settings/security');

    expect(await screen.findByRole('heading', { name: '安全与会话' })).toBeTruthy();
    expect(await screen.findByText('生效安全策略', undefined, { timeout: 5000 })).toBeTruthy();
    expect(await screen.findByText('8 小时', undefined, { timeout: 5000 })).toBeTruthy();
    expect(
      await screen.findByText('同一账号 15 分钟内 5 次失败；同一来源 15 分钟内 20 次失败'),
    ).toBeTruthy();
    expect(
      await screen.findByText('至少 12 个字符；不超过 256 个字符；首尾不能是空白；不能包含账号名'),
    ).toBeTruthy();
  });

  it('lists real audit facts for an administrator', async () => {
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return jsonResponse(200, ADMIN_SESSION);
      if (url.startsWith('/api/v1/admin/audit-events')) return jsonResponse(200, AUDIT_EVENTS);
      return undefined;
    });

    renderRoutes('/settings/audit');

    expect(await screen.findByRole('heading', { name: '操作审计' })).toBeTruthy();
    expect(await screen.findByText('登录成功', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('运维管理员（ops.admin）')).toBeTruthy();
    expect(screen.getByText('登录与会话')).toBeTruthy();
    expect(screen.getByText('共 1 条')).toBeTruthy();
  });

  it('does not request the admin audit endpoint for viewers', async () => {
    const fetchMock = mockFetch((url) => {
      if (url === '/api/v1/auth/session') return jsonResponse(200, VIEWER_SESSION);
      return undefined;
    });

    renderRoutes('/settings/audit');

    expect(
      await screen.findByText('操作审计包含登录、会话与账号变更事实，仅管理员可以查看。', undefined, {
        timeout: 5000,
      }),
    ).toBeTruthy();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('/api/v1/admin/audit-events')),
    ).toBe(false);
  });

  it('switches between governance pages from the sidebar and keeps one work tab each', async () => {
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return jsonResponse(200, ADMIN_SESSION);
      if (url === '/api/v1/admin/accounts') return jsonResponse(200, ADMIN_ACCOUNTS);
      if (url.startsWith('/api/v1/admin/audit-events')) return jsonResponse(200, AUDIT_EVENTS);
      if (url === '/api/v1/system/runtime') return jsonResponse(200, RUNTIME);
      return undefined;
    });

    const { router } = renderRoutes('/settings/accounts');

    expect(
      await screen.findByRole('heading', { name: '账号与权限' }, { timeout: 5000 }),
    ).toBeTruthy();
    expect(await screen.findByText('read.only', undefined, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(screen.getByRole('menuitem', { name: '操作审计' }));
    expect(await screen.findByText('登录成功', undefined, { timeout: 5000 })).toBeTruthy();
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/audit'));
    expect(screen.getByRole('tab', { name: /账号与权限/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /操作审计/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('menuitem', { name: '平台状态' }));
    expect(await screen.findByText('数据库已连接', undefined, { timeout: 5000 })).toBeTruthy();
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/runtime'));
    expect(screen.getByRole('tab', { name: /平台状态/ })).toBeTruthy();
  }, 20_000);
});
