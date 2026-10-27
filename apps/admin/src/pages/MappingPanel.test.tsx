// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { CatalogProduct } from '../features/catalog/api';
import { installDomStubs, renderRoutes } from '../test-utils/render-routes';

const SESSION_EXPIRES_AT = Date.now() + 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 27, 1, 30, 0);

const ADMIN = {
  id: 'account-1',
  username: 'ops.admin',
  displayName: '运维管理员',
  role: 'admin' as const,
};

const VIEWER = {
  id: 'account-2',
  username: 'read.only',
  displayName: '只读观察员',
  role: 'viewer' as const,
};

type Session = typeof ADMIN | typeof VIEWER;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sessionResponse(admin: Session): Response {
  return jsonResponse(200, { admin, session: { expiresAt: SESSION_EXPIRES_AT } });
}

function product(
  overrides: Partial<CatalogProduct> & Pick<CatalogProduct, 'id' | 'code' | 'name'>,
): CatalogProduct {
  return {
    shortDescription: '',
    status: 'active',
    displayPriceCents: null,
    estimatedCostCents: null,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    vendorFulfillmentEnabled: false,
    ...overrides,
  };
}

function listResponse(products: CatalogProduct[]): Response {
  return jsonResponse(200, { products, page: 1, pageSize: 20, total: products.length });
}

function emptyOverview(productId: string) {
  return {
    productId,
    validationScope: 'local',
    upstreamVerified: false,
    draft: null,
    activeVersion: null,
    versions: [],
  };
}

function draft(productId: string, overrides: Record<string, unknown> = {}) {
  return {
    mappingId: `mapping-${productId}`,
    productId,
    provider: 'yangmao',
    productCode: 'YM-1001',
    fulfillmentMode: 'B',
    deductionUnit: 'pack',
    version: 2,
    validatedVersion: 2,
    validatedAt: NOW,
    activeVersionId: null,
    createdAt: NOW - 1000,
    updatedAt: NOW,
    ...overrides,
  };
}

function activatedVersion(productId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `version-${productId}-1`,
    mappingId: `mapping-${productId}`,
    productId,
    versionNumber: 1,
    provider: 'yangmao',
    productCode: 'YM-ACTIVE',
    fulfillmentMode: 'D',
    deductionUnit: 'amount',
    sourceDraftVersion: 1,
    activatedBy: 'ops.admin',
    activatedAt: NOW - 5000,
    ...overrides,
  };
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

function findButtonText(text: string): HTMLElement {
  const element = screen.getByText((content) => content.replace(/\s/g, '') === text);
  const button = element.closest('button');
  if (!button) throw new Error(`No button containing ${text}`);
  return button;
}

function rowButton(productName: string, label: string): HTMLElement {
  const row = screen.getByText(productName).closest('tr');
  if (!row) throw new Error(`No table row for ${productName}`);
  const element = within(row).getByText((content) => content.replace(/\s/g, '') === label);
  const button = element.closest('button');
  if (!button) throw new Error(`No ${label} button for ${productName}`);
  return button;
}

function writeCalls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return (fetchMock.mock.calls as [string, RequestInit | undefined][])
    .filter(([, init]) => (init?.method ?? 'GET') !== 'GET')
    .map(([url, init]) => `${init?.method ?? 'GET'} ${url}`);
}

function mappingRequests(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return (fetchMock.mock.calls as [string][])
    .map(([url]) => url)
    .filter((url) => url.endsWith('/mapping'));
}

function standardHandler(options: {
  session?: Session;
  products: CatalogProduct[];
  mapping: (productId: string) => Response | Promise<Response> | undefined;
}) {
  const { session = ADMIN, products, mapping } = options;
  return (url: string, init?: RequestInit) => {
    if (url === '/api/v1/auth/session') return sessionResponse(session);
    if (url.startsWith('/api/v1/catalog/products?') && (init?.method ?? 'GET') === 'GET') {
      return listResponse(products);
    }
    const detailMatch = /^\/api\/v1\/catalog\/products\/([^/?]+)$/.exec(url);
    if (detailMatch && (init?.method ?? 'GET') === 'GET') {
      const found = products.find((item) => item.id === detailMatch[1]);
      return found ? jsonResponse(200, { product: found }) : undefined;
    }
    const mappingMatch = /^\/api\/v1\/catalog\/products\/([^/?]+)\/mapping$/.exec(url);
    if (mappingMatch && (init?.method ?? 'GET') === 'GET') {
      return mapping(decodeURIComponent(mappingMatch[1]));
    }
    return undefined;
  };
}

beforeAll(() => installDomStubs());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('read-only supplier mapping panel', () => {
  it('shows a real empty state for a product without a mapping and still closes cleanly', {
    timeout: 60_000,
  }, async () => {
    const travel = product({ id: 'p-1', code: 'TRAVEL-1', name: '腾讯出行券 10 元' });
    const fetchMock = mockFetch(
      standardHandler({ products: [travel], mapping: (id) => jsonResponse(200, emptyOverview(id)) }),
    );

    renderRoutes('/catalog');
    expect(await screen.findByText('腾讯出行券 10 元', undefined, { timeout: 5000 })).toBeTruthy();

    // The list never guesses mapping state from the fulfillment flag.
    expect(screen.getByText('映射见详情')).toBeTruthy();

    fireEvent.click(rowButton('腾讯出行券 10 元', '查看'));
    expect(await screen.findByText('内部商品详情', undefined, { timeout: 5000 })).toBeTruthy();

    const panel = await screen.findByLabelText('供应商映射面板');
    expect(await within(panel).findByText('尚未配置供应商映射')).toBeTruthy();
    expect(within(panel).queryByText('上游尚未验证，真实权益发放仍禁用')).toBeNull();
    expect(within(panel).queryByText(/upstreamVerified/)).toBeNull();
    expect((screen.getByLabelText('商品名称') as HTMLInputElement).value).toBe(
      '腾讯出行券 10 元',
    );

    fireEvent.click(findButtonText('关闭'));
    await waitFor(() => expect(screen.queryByText('内部商品详情')).toBeNull());
    expect(writeCalls(fetchMock)).toEqual([]);
  });

  it('separates a saved locally-validated draft from an activated upstream-verified mapping', {
    timeout: 60_000,
  }, async () => {
    const travel = product({ id: 'p-1', code: 'TRAVEL-1', name: '腾讯出行券 10 元' });
    const fetchMock = mockFetch(
      standardHandler({
        products: [travel],
        mapping: (id) =>
          jsonResponse(200, {
            ...emptyOverview(id),
            draft: draft(id),
          }),
      }),
    );

    renderRoutes('/catalog');
    expect(await screen.findByText('腾讯出行券 10 元', undefined, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(rowButton('腾讯出行券 10 元', '编辑'));

    const panel = await screen.findByLabelText('供应商映射面板');
    expect(await within(panel).findByText('草稿已保存')).toBeTruthy();
    expect(within(panel).getByText('已通过本地校验')).toBeTruthy();
    expect(within(panel).getByText('当前没有生效映射')).toBeTruthy();
    expect(within(panel).getByText('上游尚未验证，真实权益发放仍禁用')).toBeTruthy();
    expect(within(panel).getByText(/upstreamVerified 为 false/)).toBeTruthy();
    expect(within(panel).getByText('YM-1001')).toBeTruthy();

    // The read-only slice exposes no save, validate, or activate control.
    expect(within(panel).queryByRole('button', { name: /保\s*存/ })).toBeNull();
    expect(within(panel).queryByRole('button', { name: /校\s*验/ })).toBeNull();
    expect(within(panel).queryByRole('button', { name: /激\s*活/ })).toBeNull();
    expect(writeCalls(fetchMock)).toEqual([]);
  });

  it('shows the active version and read-only history with snapshot fields', {
    timeout: 60_000,
  }, async () => {
    const travel = product({ id: 'p-1', code: 'TRAVEL-1', name: '腾讯出行券 10 元' });
    const active = activatedVersion('p-1');
    const fetchMock = mockFetch(
      standardHandler({
        products: [travel],
        mapping: (id) =>
          jsonResponse(200, {
            ...emptyOverview(id),
            draft: draft(id, { version: 3, validatedVersion: 2 }),
            activeVersion: active,
            versions: [active],
          }),
      }),
    );

    renderRoutes('/catalog');
    expect(await screen.findByText('腾讯出行券 10 元', undefined, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(rowButton('腾讯出行券 10 元', '编辑'));

    const panel = await screen.findByLabelText('供应商映射面板');
    expect(await within(panel).findByText('映射已激活')).toBeTruthy();
    expect(within(panel).getAllByText('YM-ACTIVE').length).toBeGreaterThan(0);
    expect(within(panel).getByText('ops.admin')).toBeTruthy();
    expect(within(panel).getByText('草稿已修改，需重新校验')).toBeTruthy();
    expect(within(panel).getByText('上游尚未验证，真实权益发放仍禁用')).toBeTruthy();

    fireEvent.click(within(panel).getByRole('tab', { name: /历史版本/ }));
    expect(await within(panel).findByText('历史版本只读')).toBeTruthy();
    expect(within(panel).getAllByText('YM-ACTIVE').length).toBeGreaterThan(0);
    expect(within(panel).getAllByText('amount（金额）').length).toBeGreaterThan(0);
    expect(writeCalls(fetchMock)).toEqual([]);
  });

  it('lets a viewer read the mapping but never sends a write request', { timeout: 60_000 }, async () => {
    const travel = product({ id: 'p-1', code: 'TRAVEL-1', name: '腾讯出行券 10 元' });
    const active = activatedVersion('p-1');
    const fetchMock = mockFetch(
      standardHandler({
        session: VIEWER,
        products: [travel],
        mapping: (id) =>
          jsonResponse(200, {
            ...emptyOverview(id),
            activeVersion: active,
            versions: [active],
          }),
      }),
    );

    renderRoutes('/catalog');
    expect(await screen.findByText('腾讯出行券 10 元', undefined, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(rowButton('腾讯出行券 10 元', '查看'));

    const panel = await screen.findByLabelText('供应商映射面板');
    expect(await within(panel).findByText('映射已激活')).toBeTruthy();
    expect(screen.getAllByText('当前为只读身份').length).toBeGreaterThan(0);
    expect(within(panel).queryByRole('button', { name: /保\s*存/ })).toBeNull();
    expect(within(panel).queryByRole('button', { name: /校\s*验/ })).toBeNull();
    expect(within(panel).queryByRole('button', { name: /激\s*活/ })).toBeNull();
    expect(writeCalls(fetchMock)).toEqual([]);
  });

  it('shows a load failure with retry instead of an empty mapping', { timeout: 60_000 }, async () => {
    const travel = product({ id: 'p-1', code: 'TRAVEL-1', name: '腾讯出行券 10 元' });
    let fail = true;

    mockFetch(
      standardHandler({
        products: [travel],
        mapping: (id) => {
          if (fail) {
            return jsonResponse(500, {
              error: 'INTERNAL_ERROR',
              message: '供应商映射服务暂时不可用',
            });
          }
          return jsonResponse(200, { ...emptyOverview(id), draft: draft(id) });
        },
      }),
    );

    renderRoutes('/catalog');
    expect(await screen.findByText('腾讯出行券 10 元', undefined, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(rowButton('腾讯出行券 10 元', '编辑'));

    const panel = await screen.findByLabelText('供应商映射面板');
    expect(await within(panel).findByText('无法加载供应商映射')).toBeTruthy();
    expect(within(panel).getByText('供应商映射服务暂时不可用')).toBeTruthy();
    expect(within(panel).queryByText('尚未配置供应商映射')).toBeNull();

    fail = false;
    fireEvent.click(within(panel).getByRole('button', { name: /重\s*试/ }));
    expect(await within(panel).findByText('草稿已保存', undefined, { timeout: 5000 })).toBeTruthy();
    expect(within(panel).queryByText('无法加载供应商映射')).toBeNull();
  });

  it('shows a network failure as an error instead of an empty mapping', { timeout: 60_000 }, async () => {
    const travel = product({ id: 'p-1', code: 'TRAVEL-1', name: '腾讯出行券 10 元' });
    mockFetch(
      standardHandler({
        products: [travel],
        mapping: () => {
          throw new Error('socket hang up');
        },
      }),
    );

    renderRoutes('/catalog');
    expect(await screen.findByText('腾讯出行券 10 元', undefined, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(rowButton('腾讯出行券 10 元', '查看'));

    const panel = await screen.findByLabelText('供应商映射面板');
    expect(await within(panel).findByText('无法加载供应商映射')).toBeTruthy();
    expect(
      within(panel).getByText('网络请求失败，请检查网络连接后重试'),
    ).toBeTruthy();
    expect(within(panel).queryByText('尚未配置供应商映射')).toBeNull();
  });

  it('treats a contract-invalid response as an error, not an empty mapping', {
    timeout: 60_000,
  }, async () => {
    const travel = product({ id: 'p-1', code: 'TRAVEL-1', name: '腾讯出行券 10 元' });
    mockFetch(
      standardHandler({
        products: [travel],
        mapping: (id) =>
          // `upstreamVerified: true` is not representable in the shared contract.
          jsonResponse(200, { ...emptyOverview(id), upstreamVerified: true }),
      }),
    );

    renderRoutes('/catalog');
    expect(await screen.findByText('腾讯出行券 10 元', undefined, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(rowButton('腾讯出行券 10 元', '编辑'));

    const panel = await screen.findByLabelText('供应商映射面板');
    expect(await within(panel).findByText('供应商映射数据不符合共享契约')).toBeTruthy();
    expect(within(panel).getByText(/不符合契约/)).toBeTruthy();
    expect(within(panel).queryByText('尚未配置供应商映射')).toBeNull();
  });

  it.each([
    [401, { error: 'UNAUTHENTICATED', message: '请先登录' }, '登录状态已失效'],
    [403, { error: 'FORBIDDEN', message: '当前身份无权执行该操作' }, '无权查看供应商映射'],
    [404, { error: 'PRODUCT_NOT_FOUND', message: '商品不存在' }, '内部商品不存在'],
  ])('distinguishes a %s mapping read failure from an empty state', async (status, body, title) => {
    const travel = product({ id: 'p-1', code: 'TRAVEL-1', name: '腾讯出行券 10 元' });
    mockFetch(
      standardHandler({
        products: [travel],
        mapping: () => jsonResponse(status, body),
      }),
    );

    renderRoutes('/catalog');
    expect(await screen.findByText('腾讯出行券 10 元', undefined, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(rowButton('腾讯出行券 10 元', '查看'));

    const panel = await screen.findByLabelText('供应商映射面板');
    expect(await within(panel).findByText(title)).toBeTruthy();
    expect(within(panel).queryByText('尚未配置供应商映射')).toBeNull();
  });

  it('loads mapping only for the opened product and never flashes the previous one', {
    timeout: 60_000,
  }, async () => {
    const travel = product({ id: 'p-1', code: 'TRAVEL-1', name: '腾讯出行券 10 元' });
    const coffee = product({ id: 'p-2', code: 'COFFEE-1', name: '咖啡券' });
    let activeCode = 'YM-ACTIVE';
    const fetchMock = mockFetch(
      standardHandler({
        products: [travel, coffee],
        mapping: (id) => {
          if (id !== 'p-1') return jsonResponse(200, emptyOverview(id));
          const active = activatedVersion(id, { productCode: activeCode });
          return jsonResponse(200, {
            ...emptyOverview(id),
            activeVersion: active,
            versions: [active],
          });
        },
      }),
    );

    renderRoutes('/catalog');
    expect(await screen.findByText('腾讯出行券 10 元', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('咖啡券')).toBeTruthy();
    // Merely rendering the list must not trigger per-row mapping requests.
    expect(mappingRequests(fetchMock)).toEqual([]);

    fireEvent.click(rowButton('腾讯出行券 10 元', '查看'));
    const firstPanel = await screen.findByLabelText('供应商映射面板');
    expect(await within(firstPanel).findByText('映射已激活')).toBeTruthy();
    expect(within(firstPanel).getAllByText('YM-ACTIVE').length).toBeGreaterThan(0);

    fireEvent.click(findButtonText('关闭'));
    await waitFor(() => expect(screen.queryByText('内部商品详情')).toBeNull());

    fireEvent.click(rowButton('咖啡券', '查看'));
    const secondPanel = await screen.findByLabelText('供应商映射面板');
    expect(await within(secondPanel).findByText('尚未配置供应商映射')).toBeTruthy();
    expect(within(secondPanel).queryByText('YM-ACTIVE')).toBeNull();
    expect(within(secondPanel).queryByText('映射已激活')).toBeNull();

    // Reopening the first product must fetch and show the new server snapshot,
    // never the cached overview from the previous drawer session.
    fireEvent.click(findButtonText('关闭'));
    await waitFor(() => expect(screen.queryByText('内部商品详情')).toBeNull());
    activeCode = 'YM-FRESH';
    fireEvent.click(rowButton('腾讯出行券 10 元', '查看'));
    const reopenedPanel = await screen.findByLabelText('供应商映射面板');
    expect(await within(reopenedPanel).findByText('YM-FRESH', undefined, { timeout: 5000 })).toBeTruthy();
    expect(within(reopenedPanel).queryByText('YM-ACTIVE')).toBeNull();

    // Only the opened product sessions were queried; the list caused no N+1.
    expect(mappingRequests(fetchMock).map((url) => url.split('/')[5])).toEqual([
      'p-1',
      'p-2',
      'p-1',
    ]);
  });
});
