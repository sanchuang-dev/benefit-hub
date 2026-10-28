// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { installDomStubs, renderRoutes } from '../test-utils/render-routes';

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
      return respond(200, { suppliers: [{ key: 'yangmao', name: '上力', catalogRead: { supported: true, configured: catalog.status !== 503 }, fulfillmentEnabled: false }] });
    }
    if (url === '/api/v1/suppliers/yangmao') {
      return respond(200, { supplier: { key: 'yangmao', name: '上力', catalogRead: { supported: true, configured: catalog.status !== 503 }, fulfillmentEnabled: false } });
    }
    if (url === '/api/v1/system/status') {
      return respond(200, {
        service: 'benefit-hub',
        phase: 'auth-enabled',
        vendorFulfillmentEnabled: false,
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
  }, 20_000);

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
  }, 20_000);
});
