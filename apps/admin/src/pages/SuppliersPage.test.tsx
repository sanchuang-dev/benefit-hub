// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { installDomStubs, renderRoutes } from '../test-utils/render-routes';
import { jsonResponse, mockFetch } from '../test-utils/http';
import { findButtonText, writeCalls } from '../test-utils/dom';

const ADMIN = {
  id: 'supplier-admin-1',
  username: 'ops.admin',
  displayName: '运营管理员',
  role: 'admin' as const,
};

function respond(status: number, data: unknown) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Ant Design inserts a space inside two-character button labels; match on text. */
function stubFetch(catalog: Response, detail?: Response) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (init?.method && init.method !== 'GET') {
      throw new Error('Unexpected write request on supplier read-only pages');
    }
    if (url === '/api/v1/auth/session') {
      return respond(200, { admin: ADMIN, session: { expiresAt: Date.now() + 3_600_000 } });
    }
    if (url === '/api/v1/suppliers') {
      return respond(200, { suppliers: [{ key: 'yangmao', name: '上力', catalogRead: { supported: true, configured: catalog.status !== 503 } }] });
    }
    if (url === '/api/v1/suppliers/yangmao') {
      return respond(200, { supplier: { key: 'yangmao', name: '上力', catalogRead: { supported: true, configured: catalog.status !== 503 } } });
    }
    if (url === '/api/v1/system/status') {
      return respond(200, {
        service: 'benefit-hub',
        phase: 'auth-enabled',
        adminEnabled: true,
        authenticationRequired: true,
      });
    }
    if (url === '/api/v1/catalog/supplier-products') return catalog.clone();
    if (url === '/api/v1/catalog/supplier-products/FIXTURE-A' && detail) return detail.clone();
    throw new Error('Unexpected request: ' + url);
  });
}

beforeAll(() => installDomStubs());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Yangmao supplier management', () => {
  it('opens a supplier from the first-level route and reads live-shaped list/detail without writes', async () => {
    const fetchMock = stubFetch(
      respond(200, {
        provider: 'yangmao',
        currency: 'CNY',
        observedAt: '2026-10-28T09:00:00Z',
        products: [{ productCode: 'FIXTURE-A', sellPriceCents: 1234 }],
      }),
      respond(200, {
        product: {
          provider: 'yangmao',
          currency: 'CNY',
          productCode: 'FIXTURE-A',
          name: '供应商商品示例',
          sellPriceCents: 1234,
          observedAt: '2026-10-28T09:00:02Z',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    renderRoutes('/suppliers');
    expect(await screen.findByRole('heading', { name: '供应商管理' })).toBeTruthy();
    // The list panel shows only server-owned registry facts: identity, the
    // catalogue-read capability flag and the credential-configured flag.
    expect(await screen.findByText('上力')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '供应商' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '目录读取能力' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '目录凭证' })).toBeTruthy();
    expect(screen.getByText('已配置')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: '查看供应商' }));
    expect(await screen.findByRole('heading', { name: '上力' })).toBeTruthy();
    // The overview only reads safe registration metadata; opening the catalogue triggers the signed GET.
    fireEvent.click(screen.getByRole('tab', { name: '供货商品' }));
    expect(await screen.findByText('FIXTURE-A')).toBeTruthy();
    expect(screen.getByText('¥12.34')).toBeTruthy();

    const supplierList = screen.getByRole('region', { name: '供应商商品列表' });
    fireEvent.click(within(supplierList).getByRole('button', { name: /查看详情/ }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('供应商商品示例')).toBeTruthy();
    expect(within(dialog).getByText('待核实')).toBeTruthy();
    expect((fetchMock.mock.calls as [string, RequestInit | undefined][])
      .every(([, options]) => (options?.method ?? 'GET') === 'GET')).toBe(true);
  }, 45_000);

  it('places the supplier detail under 供应商管理 with a breadcrumb instead of a peer page', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(respond(200, {
        provider: 'yangmao',
        currency: 'CNY',
        observedAt: '2026-10-28T09:00:00Z',
        products: [],
      })),
    );

    const { router } = renderRoutes('/suppliers/yangmao');
    // The current crumb carries the page-heading semantics at title scale; the
    // page must not repeat 上力 as a second heading below the breadcrumb.
    expect(await screen.findByRole('heading', { name: '上力', level: 2 })).toBeTruthy();

    const breadcrumb = screen.getByRole('navigation', { name: '面包屑' });
    expect(within(breadcrumb).getByText('供应商管理')).toBeTruthy();
    expect(within(breadcrumb).getByRole('heading', { name: '上力', level: 2 })).toBeTruthy();
    // The breadcrumb is the only back affordance; a second back button would
    // duplicate the hierarchy the crumb already expresses.
    expect(screen.queryByRole('button', { name: '返回供应商列表' })).toBeNull();

    fireEvent.click(within(breadcrumb).getByRole('link', { name: '供应商管理' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/suppliers'));
    expect(await screen.findByRole('heading', { name: '供应商管理' })).toBeTruthy();
  }, 45_000);

  it('does not pretend a missing server-side supplier configuration is an empty list', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(respond(503, {
        error: 'SUPPLIER_NOT_CONFIGURED',
        message: '上力供应商商品读取尚未配置；请在服务器侧配置只读凭证后重试',
      })),
    );

    renderRoutes('/suppliers/yangmao');
    expect(await screen.findByRole('heading', { name: '上力' })).toBeTruthy();
    expect(await screen.findByText('服务器未配置上力只读凭证')).toBeTruthy();
    expect(screen.queryByText('共 0 条')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '供货商品' }));
    expect(await screen.findByText('尚未配置上力只读凭证')).toBeTruthy();
  }, 45_000);
  it('runs a real-shaped A/B read only after explicit admin input and reports vendor fields', async () => {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body });
      if (url === '/api/v1/auth/session') return respond(200, { admin: ADMIN, session: { expiresAt: Date.now() + 3_600_000 } });
      if (url === '/api/v1/suppliers/yangmao') return respond(200, { supplier: { key: 'yangmao', name: '上力', catalogRead: { supported: true, configured: true } } });
      if (url === '/api/v1/auth/csrf') return respond(200, { csrfToken: 'fixture-csrf' });
      if (url === '/api/v1/suppliers/yangmao/purchase-check' && method === 'POST') {
        return respond(200, { eligibility: {
          provider: 'yangmao', observedAt: '2026-10-29T00:00:00Z',
          purchaseRestricted: true, giftUnclaimed: false, lotteryUnbet: false,
        } });
      }
      throw new Error('Unexpected request: ' + url);
    }));
    renderRoutes('/suppliers/yangmao');
    expect(await screen.findByRole('heading', { name: '上力' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '只读联调' }));
    const field = await screen.findByRole('textbox', { name: '获授权测试手机号' });
    fireEvent.change(field, { target: { value: '13800138000' } });
    fireEvent.click(screen.getByRole('button', { name: '真实查询' }));
    expect(await screen.findByText('限领中')).toBeTruthy();
    expect(calls.some((c) => c.url === '/api/v1/suppliers/yangmao/purchase-check' &&
      c.method === 'POST' && c.body === JSON.stringify({ phone: '13800138000' }))).toBe(true);
    expect(screen.getByText(/响应成功不等于已扣额、发券或到账/)).toBeTruthy();
  }, 45_000);

});

describe('supplier registry panel', () => {
  const YANGMAO = {
    key: 'yangmao',
    name: '上力',
    catalogRead: { supported: true, configured: true },
  };

  function session() {
    return jsonResponse(200, { admin: ADMIN, session: { expiresAt: Date.now() + 3_600_000 } });
  }

  it('filters the registry through URL state and resets back to the full list', { timeout: 60_000 }, async () => {
    const fetchMock = mockFetch((url) => {
      if (url === '/api/v1/auth/session') return session();
      if (url === '/api/v1/suppliers') return jsonResponse(200, { suppliers: [YANGMAO] });
      return undefined;
    });

    const { router } = renderRoutes('/suppliers');
    expect(await screen.findByRole('heading', { name: '供应商管理' })).toBeTruthy();
    expect(await screen.findByText('上力')).toBeTruthy();

    // A keyword nobody matches is a filtered empty state, not an empty
    // registry and not a request failure.
    fireEvent.change(screen.getByLabelText('关键词'), { target: { value: '不存在' } });
    fireEvent.click(findButtonText('查询'));

    expect(await screen.findByText('没有符合条件的供应商')).toBeTruthy();
    expect(router.state.location.search).toContain('q=');
    // The registry page is read-only: filters live in the URL, never in a
    // write request.
    expect(writeCalls(fetchMock)).toEqual([]);

    fireEvent.click(findButtonText('清除筛选'));
    await waitFor(() => expect(router.state.location.search).not.toContain('q='));
    expect(await screen.findByText('上力')).toBeTruthy();

    // Credential-status filter: the only supplier is configured, so choosing
    // 待配置 empties the result set again.
    fireEvent.mouseDown(screen.getByLabelText('接入状态'));
    fireEvent.click(await screen.findByTitle('凭证待配置'));
    fireEvent.click(findButtonText('查询'));
    await waitFor(() => expect(router.state.location.search).toContain('status=unconfigured'));
    expect(await screen.findByText('没有符合条件的供应商')).toBeTruthy();
    expect(writeCalls(fetchMock)).toEqual([]);
  });

  it('restores the keyword and status filters from a shared URL', { timeout: 60_000 }, async () => {
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return session();
      if (url === '/api/v1/suppliers') return jsonResponse(200, { suppliers: [YANGMAO] });
      return undefined;
    });

    // This is exactly what the browser restores when the operator refreshes.
    renderRoutes('/suppliers?status=unconfigured');

    expect(await screen.findByRole('heading', { name: '供应商管理' })).toBeTruthy();
    expect(await screen.findByText('没有符合条件的供应商')).toBeTruthy();
    // The select shows the restored value, not the default 全部状态.
    expect(screen.getByText('凭证待配置')).toBeTruthy();
  });

  it('distinguishes an empty registry from a filter with no results', { timeout: 60_000 }, async () => {
    let registry: unknown[] = [];
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return session();
      if (url === '/api/v1/suppliers') return jsonResponse(200, { suppliers: registry });
      return undefined;
    });

    renderRoutes('/suppliers');
    expect(await screen.findByText('尚无已登记供应商')).toBeTruthy();

    registry = [YANGMAO];
    fireEvent.click(findButtonText('刷新'));
    expect(await screen.findByText('上力', undefined, { timeout: 50_000 })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('关键词'), { target: { value: '不存在' } });
    fireEvent.click(findButtonText('查询'));
    expect(await screen.findByText('没有符合条件的供应商')).toBeTruthy();
    expect(screen.queryByText('尚无已登记供应商')).toBeNull();

    fireEvent.click(findButtonText('清除筛选'));
    expect(await screen.findByText('上力')).toBeTruthy();
  });

  it('shows a load failure with retry instead of pretending the registry is empty', { timeout: 60_000 }, async () => {
    let fail = true;
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return session();
      if (url === '/api/v1/suppliers') {
        if (fail) {
          return jsonResponse(500, { error: 'INTERNAL_ERROR', message: '供应商服务暂时不可用' });
        }
        return jsonResponse(200, { suppliers: [YANGMAO] });
      }
      return undefined;
    });

    renderRoutes('/suppliers');
    expect(await screen.findByText('无法加载供应商档案')).toBeTruthy();
    expect(screen.getByText('供应商服务暂时不可用')).toBeTruthy();
    // A failed load must never render as an empty registry.
    expect(screen.queryByText('尚无已登记供应商')).toBeNull();

    fail = false;
    fireEvent.click(findButtonText('重试'));
    expect(await screen.findByText('上力', undefined, { timeout: 50_000 })).toBeTruthy();
  });
});
