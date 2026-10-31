// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type {
  CatalogProductListItem,
  ProductMappingSummary,
  SupplierFilterOption,
} from '../features/catalog/api';
import { installDomStubs, renderRoutes, resetUiPrefs } from '../test-utils/render-routes';
import { jsonResponse, mockFetch } from '../test-utils/http';
import { findButtonText, findButtonTextAsync, queryParams, writeCalls } from '../test-utils/dom';
import { useUiPrefs } from '../shared/lib/ui-prefs';

const SESSION_EXPIRES_AT = Date.now() + 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 24, 2, 0, 0);

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

function sessionResponse(admin: typeof ADMIN | typeof VIEWER): Response {
  return jsonResponse(200, { admin, session: { expiresAt: SESSION_EXPIRES_AT } });
}

const UNMAPPED: ProductMappingSummary = {
  state: 'none',
  provider: null,
  productCode: null,
  fulfillmentMode: null,
  versionNumber: null,
};

/** Server facet that backs the 供货方 dropdown; displayed name is server data. */
const DEFAULT_SUPPLIERS: SupplierFilterOption[] = [
  { key: 'yangmao', name: '上力', configured: true },
];

function product(
  overrides: Partial<CatalogProductListItem> & Pick<CatalogProductListItem, 'id' | 'code' | 'name'>,
): CatalogProductListItem {
  return {
    shortDescription: '',
    status: 'active',
    displayPriceCents: null,
    estimatedCostCents: null,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    mapping: UNMAPPED,
    ...overrides,
  };
}

function listResponse(
  products: CatalogProductListItem[],
  page = 1,
  pageSize = 20,
  suppliers: SupplierFilterOption[] = DEFAULT_SUPPLIERS,
): Response {
  return jsonResponse(200, { products, suppliers, page, pageSize, total: products.length });
}

/**
 * Sortable table headers expose the same accessible name as the drawer fields
 * (e.g. 商品名称), so drawer inputs must be queried inside the dialog.
 */
async function drawerField(label: string): Promise<HTMLElement> {
  const dialog = await screen.findByRole('dialog');
  return within(dialog).getByLabelText(label);
}

/** Ant Design inserts a space inside two-character button labels; match on text. */
beforeAll(() => installDomStubs());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetUiPrefs();
});

describe('internal product list', () => {
  it('lists real API products, marks real fulfillment disabled, and applies keyword and status filters', { timeout: 60_000 }, async () => {
    const travel = product({
      id: 'p-1',
      code: 'TRAVEL-1',
      name: '腾讯出行券 10 元',
      displayPriceCents: 1000,
    });
    const coffee = product({
      id: 'p-2',
      code: 'COFFEE-1',
      name: '咖啡券',
      status: 'disabled',
      displayPriceCents: 1250,
    });
    const listRequests: URLSearchParams[] = [];

    const fetchMock = mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url.startsWith('/api/v1/catalog/products?')) {
        const params = queryParams(url);
        listRequests.push(params);
        const keyword = params.get('keyword');
        const status = params.get('status');
        const matched = [travel, coffee].filter((item) => {
          const matchesKeyword =
            !keyword || item.name.includes(keyword) || item.code.toLowerCase().includes(keyword.toLowerCase());
          const matchesStatus = !status || item.status === status;
          return matchesKeyword && matchesStatus;
        });
        return listResponse(matched, Number(params.get('page') ?? '1'), Number(params.get('pageSize') ?? '20'));
      }
      return undefined;
    });

    renderRoutes('/catalog');

    expect(await screen.findByText('腾讯出行券 10 元', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('COFFEE-1')).toBeTruthy();
    expect(screen.getByText('¥12.50')).toBeTruthy();
    expect(screen.queryByRole('columnheader', { name: '真实发放' })).toBeNull();
    expect(screen.queryByText('未启用')).toBeNull();

    // Keyword filter is sent to the API, not applied to a local fake array.
    fireEvent.change(screen.getByLabelText('关键词'), { target: { value: '咖啡' } });
    fireEvent.click(findButtonText('查询'));

    await waitFor(() => expect(screen.queryByText('腾讯出行券 10 元')).toBeNull());
    expect(screen.getByText('咖啡券')).toBeTruthy();
    await waitFor(() =>
      expect(listRequests.some((params) => params.get('keyword') === '咖啡')).toBe(true),
    );

    // Reset, then filter by status only.
    fireEvent.click(findButtonText('重置'));
    await screen.findByText('腾讯出行券 10 元');
    fireEvent.mouseDown(screen.getByLabelText('状态'));
    fireEvent.click(await screen.findByTitle('已停用'));
    fireEvent.click(findButtonText('查询'));

    await waitFor(() =>
      expect(listRequests.some((params) => params.get('status') === 'disabled')).toBe(true),
    );
    await waitFor(() => expect(screen.queryByText('腾讯出行券 10 元')).toBeNull());
    expect(screen.getByText('咖啡券')).toBeTruthy();
    expect(writeCalls(fetchMock)).toEqual([]);
  });

  it('restores filters and paging from the URL after a refresh', { timeout: 60_000 }, async () => {
    const travel = product({ id: 'p-1', code: 'TRAVEL-1', name: '腾讯出行券 10 元' });
    const coffee = product({
      id: 'p-2',
      code: 'COFFEE-1',
      name: '咖啡券',
      status: 'disabled',
    });
    const listRequests: URLSearchParams[] = [];

    const fetchMock = mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url.startsWith('/api/v1/catalog/products?')) {
        const params = queryParams(url);
        listRequests.push(params);
        return listResponse([travel, coffee], Number(params.get('page') ?? '1'));
      }
      return undefined;
    });

    // This is exactly what the browser restores when the operator refreshes.
    renderRoutes('/catalog?q=%E5%92%96%E5%95%A1&status=disabled&page=2&pageSize=50');

    expect(await screen.findByText('咖啡券', undefined, { timeout: 5000 })).toBeTruthy();
    expect((screen.getByLabelText('关键词') as HTMLInputElement).value).toBe('咖啡');
    // The status filter is applied from the URL, so the restored request and the
    // rendered status tag both show 已停用.
    expect(screen.getAllByText('已停用').length).toBeGreaterThan(0);

    await waitFor(() => {
      const request = listRequests.at(-1);
      expect(request?.get('keyword')).toBe('咖啡');
      expect(request?.get('status')).toBe('disabled');
      expect(request?.get('page')).toBe('2');
      expect(request?.get('pageSize')).toBe('50');
    });
    // The URL owns the state; no extra write request may be sent.
    expect(writeCalls(fetchMock)).toEqual([]);
  });

  it('distinguishes an empty catalogue from a filter with no results', { timeout: 60_000 }, async () => {
    const fetchMock = mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url.startsWith('/api/v1/catalog/products?')) {
        return listResponse([]);
      }
      return undefined;
    });

    renderRoutes('/catalog');

    expect(await screen.findByText('还没有内部商品', undefined, { timeout: 5000 })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('关键词'), { target: { value: '不存在' } });
    fireEvent.click(findButtonText('查询'));

    expect(await screen.findByText('没有符合条件的商品')).toBeTruthy();
    expect(screen.queryByText('还没有内部商品')).toBeNull();

    fireEvent.click(findButtonText('清除筛选'));
    expect(await screen.findByText('还没有内部商品')).toBeTruthy();
    const lastListCall = (fetchMock.mock.calls as [string][])
      .filter(([url]) => url.startsWith('/api/v1/catalog/products?'))
      .at(-1);
    if (!lastListCall) throw new Error('expected a catalogue list request');
    expect(lastListCall[0]).not.toContain('keyword=');
  });

  it('shows a load failure with retry instead of pretending the catalogue is empty', { timeout: 60_000 }, async () => {
    let fail = true;
    const travel = product({ id: 'p-1', code: 'TRAVEL-1', name: '腾讯出行券 10 元' });

    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url.startsWith('/api/v1/catalog/products?')) {
        if (fail) {
          return jsonResponse(500, { error: 'INTERNAL_ERROR', message: '商品服务暂时不可用' });
        }
        return listResponse([travel]);
      }
      return undefined;
    });

    renderRoutes('/catalog');

    expect(await screen.findByText('商品加载失败', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('商品服务暂时不可用')).toBeTruthy();
    expect(screen.queryByText('还没有内部商品')).toBeNull();

    fail = false;
    fireEvent.click(findButtonText('重试'));

    expect(await screen.findByText('腾讯出行券 10 元', undefined, { timeout: 5000 })).toBeTruthy();
  });

  it('tells a viewer that an empty catalogue is populated by an administrator', { timeout: 60_000 }, async () => {
    const fetchMock = mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse(VIEWER);
      if (url.startsWith('/api/v1/catalog/products?')) return listResponse([]);
      return undefined;
    });

    renderRoutes('/catalog');

    expect(
      await screen.findByText('还没有内部商品，请联系管理员创建', undefined, { timeout: 5000 }),
    ).toBeTruthy();
    expect(screen.getByText('当前为只读身份')).toBeTruthy();
    expect((findButtonText('新建商品') as HTMLButtonElement).disabled).toBe(true);
    expect(writeCalls(fetchMock)).toEqual([]);
  });
});

describe('single internal catalogue', () => {
  it('renders supplier, mapping status and upstream code without supplier tabs', { timeout: 60_000 }, async () => {
    const travel = product({
      id: 'p-1',
      code: 'TRAVEL-1',
      name: '腾讯出行券 10 元',
      mapping: {
        state: 'active',
        provider: 'yangmao',
        productCode: 'YM-1001',
        fulfillmentMode: 'D',
        versionNumber: 3,
      },
    });
    const coffee = product({
      id: 'p-2',
      code: 'COFFEE-1',
      name: '咖啡券',
      status: 'disabled',
      mapping: {
        state: 'draft',
        provider: 'yangmao',
        productCode: 'YM-2002',
        fulfillmentMode: 'B',
        versionNumber: 2,
      },
    });

    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url.startsWith('/api/v1/catalog/products?')) return listResponse([travel, coffee]);
      return undefined;
    });

    renderRoutes('/catalog');

    expect(await screen.findByText('腾讯出行券 10 元', undefined, { timeout: 5000 })).toBeTruthy();

    // The legacy 内部商品 / 供应商商品 tabs are gone; the supplier catalogue
    // lives on the supplier detail page only. The global work tabs stay.
    expect(screen.queryByRole('tab', { name: '内部商品' })).toBeNull();
    expect(screen.queryByRole('tab', { name: '供应商商品' })).toBeNull();
    expect(screen.queryByText('内部商品')).toBeNull();
    expect(screen.queryByText('供应商商品')).toBeNull();
    expect(screen.getByRole('heading', { name: '权益商品' })).toBeTruthy();

    expect(screen.getByRole('columnheader', { name: '供货方' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '映射状态' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '上游编码' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '模式' })).toBeTruthy();

    expect(screen.getAllByText('上力').length).toBeGreaterThan(0);
    expect(screen.getByText('已生效')).toBeTruthy();
    expect(screen.getByText('v3')).toBeTruthy();
    expect(screen.getByText('草稿未生效')).toBeTruthy();
    expect(screen.getByText('YM-1001')).toBeTruthy();
    expect(screen.getByText('YM-2002')).toBeTruthy();
    expect(screen.getByText('D')).toBeTruthy();
  });

  it('sends the selected supplier to the API and resets pagination', { timeout: 60_000 }, async () => {
    const coffee = product({
      id: 'p-2',
      code: 'COFFEE-1',
      name: '咖啡券',
      mapping: {
        state: 'active',
        provider: 'yangmao',
        productCode: 'YM-2002',
        fulfillmentMode: 'D',
        versionNumber: 1,
      },
    });
    const listRequests: URLSearchParams[] = [];

    const fetchMock = mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url.startsWith('/api/v1/catalog/products?')) {
        const params = queryParams(url);
        listRequests.push(params);
        return listResponse([coffee], Number(params.get('page') ?? '1'));
      }
      return undefined;
    });

    const { router } = renderRoutes('/catalog?page=2');
    expect(await screen.findByText('咖啡券', undefined, { timeout: 5000 })).toBeTruthy();
    await waitFor(() => expect(listRequests.at(-1)?.get('page')).toBe('2'), { timeout: 5000 });

    fireEvent.mouseDown(screen.getByLabelText('供货方'));
    fireEvent.click(await screen.findByTitle('上力', undefined, { timeout: 5000 }));
    fireEvent.click(findButtonText('查询'));

    await waitFor(
      () => {
        const request = listRequests.at(-1);
        expect(request?.get('supplier')).toBe('yangmao');
        // Filtering starts a new result set, so page two must not leak over.
        expect(request?.get('page')).toBe('1');
      },
      { timeout: 5000 },
    );
    expect(router.state.location.search).toContain('supplier=yangmao');
    expect(router.state.location.search).not.toContain('page=');

    // Reset clears the supplier filter as well as keyword/status/paging.
    fireEvent.click(findButtonText('重置'));
    await waitFor(() => expect(listRequests.at(-1)?.get('supplier')).toBeNull(), {
      timeout: 5000,
    });
    expect(router.state.location.search).not.toContain('supplier=');
    expect(writeCalls(fetchMock)).toEqual([]);
  });

  it('marks a supplier without credentials as 未配置 in the filter', { timeout: 60_000 }, async () => {
    const coffee = product({
      id: 'p-2',
      code: 'COFFEE-1',
      name: '咖啡券',
      mapping: {
        state: 'draft',
        provider: 'yangmao',
        productCode: 'YM-2002',
        fulfillmentMode: 'B',
        versionNumber: 1,
      },
    });

    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url.startsWith('/api/v1/catalog/products?')) {
        return listResponse([coffee], 1, 20, [
          { key: 'yangmao', name: '上力', configured: false },
        ]);
      }
      return undefined;
    });

    renderRoutes('/catalog');
    expect(await screen.findByText('咖啡券', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getAllByText('未配置').length).toBeGreaterThan(0);

    fireEvent.mouseDown(screen.getByLabelText('供货方'));
    expect(
      await screen.findByTitle('上力（未配置）', undefined, { timeout: 5000 }),
    ).toBeTruthy();
  });

  it('restores a valid supplier filter from the URL', { timeout: 60_000 }, async () => {
    const coffee = product({
      id: 'p-2',
      code: 'COFFEE-1',
      name: '咖啡券',
      mapping: {
        state: 'active',
        provider: 'yangmao',
        productCode: 'YM-2002',
        fulfillmentMode: 'D',
        versionNumber: 1,
      },
    });
    const listRequests: URLSearchParams[] = [];

    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url.startsWith('/api/v1/catalog/products?')) {
        const params = queryParams(url);
        listRequests.push(params);
        return listResponse([coffee]);
      }
      return undefined;
    });

    renderRoutes('/catalog?supplier=yangmao');
    expect(await screen.findByText('咖啡券', undefined, { timeout: 5000 })).toBeTruthy();

    await waitFor(() => expect(listRequests.at(-1)?.get('supplier')).toBe('yangmao'), {
      timeout: 5000,
    });
    expect(screen.getAllByText('上力').length).toBeGreaterThan(0);
  });

  it('drops an unknown supplier from a hand-edited URL instead of requesting it', { timeout: 60_000 }, async () => {
    const coffee = product({ id: 'p-2', code: 'COFFEE-1', name: '咖啡券' });
    const listRequests: URLSearchParams[] = [];

    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url.startsWith('/api/v1/catalog/products?')) {
        const params = queryParams(url);
        listRequests.push(params);
        return listResponse([coffee], Number(params.get('page') ?? '1'));
      }
      return undefined;
    });

    renderRoutes('/catalog?supplier=evil&page=2');
    expect(await screen.findByText('咖啡券', undefined, { timeout: 5000 })).toBeTruthy();

    await waitFor(() => expect(listRequests.length).toBeGreaterThan(0), { timeout: 5000 });
    expect(listRequests.every((params) => params.get('supplier') === null)).toBe(true);
    expect(listRequests.at(-1)?.get('page')).toBe('2');
    expect(screen.getAllByText('全部供货方').length).toBeGreaterThan(0);
  });

  it('redirects the legacy supplier tab to the supplier catalogue page', { timeout: 60_000 }, async () => {
    const catalogListCalls: string[] = [];
    const supplier = {
      key: 'yangmao',
      name: '上力',
      catalogRead: { supported: true, configured: true },
    };

    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url === '/api/v1/suppliers') return jsonResponse(200, { suppliers: [supplier] });
      if (url === '/api/v1/suppliers/yangmao') return jsonResponse(200, { supplier });
      if (url === '/api/v1/catalog/supplier-products') {
        return jsonResponse(200, {
          provider: 'yangmao',
          currency: 'CNY',
          observedAt: new Date(NOW).toISOString(),
          products: [],
        });
      }
      if (url.startsWith('/api/v1/catalog/products?')) {
        catalogListCalls.push(url);
        return listResponse([]);
      }
      return undefined;
    });

    const { router } = renderRoutes('/catalog?tab=supplier');

    await waitFor(
      () => {
        expect(router.state.location.pathname).toBe('/suppliers/yangmao');
        expect(router.state.location.search).toBe('?tab=catalog');
      },
      { timeout: 5000 },
    );
    // The internal product list must not be fetched on the way to the redirect.
    expect(catalogListCalls).toEqual([]);
  });
});

describe('product writes', () => {
  it('creates a product through the API and shows the refetched row after saving', { timeout: 60_000 }, async () => {
    let created: CatalogProductListItem | null = null;
    let postedBody: Record<string, unknown> | null = null;

    const fetchMock = mockFetch((url, init) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url === '/api/v1/auth/csrf') return jsonResponse(200, { csrfToken: 'csrf-token' });
      if (url === '/api/v1/catalog/products' && init?.method === 'POST') {
        postedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        created = product({
          id: 'p-new',
          code: String(postedBody.code).toUpperCase(),
          name: String(postedBody.name),
          displayPriceCents: postedBody.displayPriceCents as number | null,
          estimatedCostCents: postedBody.estimatedCostCents as number | null,
        });
        return jsonResponse(201, { product: created });
      }
      if (url.startsWith('/api/v1/catalog/products?')) {
        return listResponse(created ? [created] : []);
      }
      return undefined;
    });

    renderRoutes('/catalog');
    expect(await screen.findByText('还没有内部商品', undefined, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(findButtonText('新建商品'));
    expect(await screen.findByText('新建内部商品', undefined, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(findButtonText('保存'));
    expect(await screen.findByText('请输入商品编码')).toBeTruthy();
    expect(writeCalls(fetchMock)).toEqual([]);

    fireEvent.change(await drawerField('商品编码'), { target: { value: 'new-1' } });
    fireEvent.change(await drawerField('商品名称'), { target: { value: '新商品' } });
    fireEvent.change(screen.getByLabelText('展示价（元）'), { target: { value: '12.50' } });
    fireEvent.click(findButtonText('保存'));

    expect(await screen.findByText('商品已保存', undefined, { timeout: 5000 })).toBeTruthy();
    expect(await screen.findByText('NEW-1', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('新商品')).toBeTruthy();
    expect(screen.getByText('¥12.50')).toBeTruthy();
    expect(postedBody).toEqual({
      code: 'new-1',
      name: '新商品',
      shortDescription: '',
      displayPriceCents: 1250,
      estimatedCostCents: null,
    });

    const postCall = (vi.mocked(fetch).mock.calls as [string, RequestInit][]).find(
      ([url, init]) => url === '/api/v1/catalog/products' && init.method === 'POST',
    );
    if (!postCall) throw new Error('expected a create request');
    expect((postCall[1].headers as Record<string, string>)['x-csrf-token']).toBe('csrf-token');
  });

  it('shows the real duplicate-code error and never reports a fake save', { timeout: 60_000 }, async () => {
    mockFetch((url, init) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url === '/api/v1/auth/csrf') return jsonResponse(200, { csrfToken: 'csrf-token' });
      if (url === '/api/v1/catalog/products' && init?.method === 'POST') {
        return jsonResponse(409, { error: 'PRODUCT_CODE_CONFLICT', message: '商品编码已存在' });
      }
      if (url.startsWith('/api/v1/catalog/products?')) return listResponse([]);
      return undefined;
    });

    renderRoutes('/catalog');
    expect(await screen.findByText('还没有内部商品', undefined, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(findButtonText('新建商品'));
    fireEvent.change(await drawerField('商品编码'), { target: { value: 'dup-1' } });
    fireEvent.change(await drawerField('商品名称'), { target: { value: '重复商品' } });
    fireEvent.click(findButtonText('保存'));

    expect(await screen.findByText('商品编码已存在', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText('商品已保存')).toBeNull();
    expect(screen.getByText('新建内部商品')).toBeTruthy();
    expect(((await drawerField('商品编码')) as HTMLInputElement).value).toBe('dup-1');
  });

  it('does not report success when the API fails', { timeout: 60_000 }, async () => {
    mockFetch((url, init) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url === '/api/v1/auth/csrf') return jsonResponse(200, { csrfToken: 'csrf-token' });
      if (url === '/api/v1/catalog/products' && init?.method === 'POST') {
        return jsonResponse(500, { error: 'INTERNAL_ERROR', message: '服务器内部错误' });
      }
      if (url.startsWith('/api/v1/catalog/products?')) return listResponse([]);
      return undefined;
    });

    renderRoutes('/catalog');
    expect(await screen.findByText('还没有内部商品', undefined, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(findButtonText('新建商品'));
    fireEvent.change(await drawerField('商品编码'), { target: { value: 'fail-1' } });
    fireEvent.change(await drawerField('商品名称'), { target: { value: '故障商品' } });
    fireEvent.click(findButtonText('保存'));

    expect(await screen.findByText('服务器内部错误', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText('商品已保存')).toBeNull();
    expect(screen.getByText('新建内部商品')).toBeTruthy();
  });

  it('edits with the server version and surfaces a version conflict without overwriting', { timeout: 60_000 }, async () => {
    const coffee = product({
      id: 'p-2',
      code: 'COFFEE-1',
      name: '咖啡券',
      displayPriceCents: 1250,
      version: 2,
    });
    let patchedBody: Record<string, unknown> | null = null;

    mockFetch((url, init) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url === '/api/v1/auth/csrf') return jsonResponse(200, { csrfToken: 'csrf-token' });
      if (url === '/api/v1/catalog/products/p-2' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse(200, { product: coffee });
      }
      if (url === '/api/v1/catalog/products/p-2' && init?.method === 'PATCH') {
        patchedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse(409, {
          error: 'PRODUCT_VERSION_CONFLICT',
          message: '商品已被他人更新，请刷新后按最新版本重试',
        });
      }
      if (url.startsWith('/api/v1/catalog/products?')) return listResponse([coffee]);
      return undefined;
    });

    renderRoutes('/catalog');
    expect(await screen.findByText('咖啡券', undefined, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(findButtonText('编辑'));
    expect(await screen.findByText('编辑内部商品', undefined, { timeout: 5000 })).toBeTruthy();
    const nameInput = await screen.findByDisplayValue('咖啡券');
    fireEvent.change(nameInput, { target: { value: '咖啡券（新版）' } });
    fireEvent.click(findButtonText('保存'));

    expect(
      await screen.findByText('商品已被他人更新，请刷新后按最新版本重试', undefined, {
        timeout: 5000,
      }),
    ).toBeTruthy();
    expect(patchedBody).toMatchObject({
      version: 2,
      code: 'COFFEE-1',
      name: '咖啡券（新版）',
      displayPriceCents: 1250,
    });
    expect(screen.queryByText('商品已保存')).toBeNull();
    expect(((await drawerField('商品名称')) as HTMLInputElement).value).toBe('咖啡券（新版）');
  });

  it('disables a product with its current version and shows the persisted state', { timeout: 60_000 }, async () => {
    let current = product({ id: 'p-2', code: 'COFFEE-1', name: '咖啡券', version: 1 });
    let statusBody: Record<string, unknown> | null = null;
    let enableBody: Record<string, unknown> | null = null;

    mockFetch((url, init) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url === '/api/v1/auth/csrf') return jsonResponse(200, { csrfToken: 'csrf-token' });
      if (url === '/api/v1/catalog/products/p-2' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse(200, { product: current });
      }
      if (url === '/api/v1/catalog/products/p-2/disable' && init?.method === 'POST') {
        statusBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        current = { ...current, status: 'disabled', version: 2 };
        return jsonResponse(200, { product: current });
      }
      if (url === '/api/v1/catalog/products/p-2/enable' && init?.method === 'POST') {
        enableBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        current = { ...current, status: 'active', version: 3 };
        return jsonResponse(200, { product: current });
      }
      if (url.startsWith('/api/v1/catalog/products?')) return listResponse([current]);
      return undefined;
    });

    renderRoutes('/catalog');
    expect(await screen.findByText('咖啡券', undefined, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(findButtonText('编辑'));
    fireEvent.click(await findButtonTextAsync('停用商品'));
    fireEvent.click(await findButtonTextAsync('确认'));

    expect(await screen.findByText('商品已停用', undefined, { timeout: 5000 })).toBeTruthy();
    expect(statusBody).toEqual({ version: 1 });
    expect(await findButtonTextAsync('启用商品')).toBeTruthy();
    expect(screen.getAllByText('已停用').length).toBeGreaterThan(0);

    fireEvent.click(await findButtonTextAsync('启用商品'));
    fireEvent.click(await findButtonTextAsync('确认'));
    expect(await screen.findByText('商品已启用', undefined, { timeout: 5000 })).toBeTruthy();
    expect(enableBody).toEqual({ version: 2 });
    expect(await findButtonTextAsync('停用商品')).toBeTruthy();
    expect(screen.getAllByText('已启用').length).toBeGreaterThan(0);
  });

  it('keeps a viewer read-only and sends no write requests', { timeout: 60_000 }, async () => {
    const coffee = product({ id: 'p-2', code: 'COFFEE-1', name: '咖啡券' });

    const fetchMock = mockFetch((url, init) => {
      if (url === '/api/v1/auth/session') return sessionResponse(VIEWER);
      if (url === '/api/v1/catalog/products/p-2' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse(200, { product: coffee });
      }
      if (url.startsWith('/api/v1/catalog/products?')) return listResponse([coffee]);
      return undefined;
    });

    renderRoutes('/catalog');

    expect(await screen.findByText('咖啡券', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('当前为只读身份')).toBeTruthy();
    expect(screen.queryByText('编辑')).toBeNull();
    const createButton = findButtonText('新建商品') as HTMLButtonElement;
    expect(createButton.disabled).toBe(true);

    fireEvent.click(findButtonText('查看'));

    expect(await screen.findByText('内部商品详情', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText('只读身份可以查看商品，但不能保存或启停；服务端同时拒绝越权写入。')).toBeTruthy();
    const nameInput = (await drawerField('商品名称')) as HTMLInputElement;
    expect(nameInput.value).toBe('咖啡券');
    expect(nameInput.disabled).toBe(true);
    expect(
      screen.queryByText((content) => content.replace(/\s/g, '') === '保存'),
    ).toBeNull();
    expect(screen.queryByText('停用商品')).toBeNull();
    expect(writeCalls(fetchMock)).toEqual([]);
  });

  it('shows the current status and grouped fields in the editor drawer', { timeout: 60_000 }, async () => {
    const coffee = product({
      id: 'p-2',
      code: 'COFFEE-1',
      name: '咖啡券',
      status: 'disabled',
      version: 3,
    });

    mockFetch((url, init) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url === '/api/v1/catalog/products/p-2' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse(200, { product: coffee });
      }
      if (url.startsWith('/api/v1/catalog/products?')) return listResponse([coffee]);
      return undefined;
    });

    renderRoutes('/catalog');
    expect(await screen.findByText('咖啡券', undefined, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(findButtonText('编辑'));

    await screen.findByText('编辑内部商品', undefined, { timeout: 5000 });
    const drawer = await screen.findByRole('dialog');

    // The drawer header repeats the persisted status so an operator can read it
    // without scanning the table behind the mask.
    expect(within(drawer).getByText('已停用')).toBeTruthy();
    expect(within(drawer).getByText('基本信息')).toBeTruthy();
    expect(within(drawer).getByText('价格与成本')).toBeTruthy();
    expect(within(drawer).getByText('版本 v3', { exact: false })).toBeTruthy();
    expect((within(drawer).getByLabelText('商品名称') as HTMLInputElement).value).toBe('咖啡券');
  });

  it('reloads a fresh product snapshot when the editor is reopened', { timeout: 60_000 }, async () => {
    let current = product({ id: 'p-2', code: 'COFFEE-1', name: '旧商品名称', version: 1 });
    const writes: Record<string, unknown>[] = [];
    mockFetch((url, init) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url === '/api/v1/auth/csrf') return jsonResponse(200, { csrfToken: 'csrf-token' });
      if (url === '/api/v1/catalog/products/p-2' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse(200, { product: current });
      }
      if (url === '/api/v1/catalog/products/p-2' && init?.method === 'PATCH') {
        writes.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse(200, { product: current });
      }
      if (url.startsWith('/api/v1/catalog/products?')) return listResponse([current]);
      return undefined;
    });
    renderRoutes('/catalog');
    expect(await screen.findByText('旧商品名称', undefined, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(findButtonText('编辑'));
    expect(await screen.findByDisplayValue('旧商品名称')).toBeTruthy();
    fireEvent.click(findButtonText('关闭'));
    await waitFor(() => expect(screen.queryByText('编辑内部商品')).toBeNull());
    current = { ...current, name: '服务器新名称', version: 2 };
    fireEvent.click(findButtonText('编辑'));
    expect(await screen.findByDisplayValue('服务器新名称')).toBeTruthy();
    fireEvent.click(findButtonText('保存'));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ name: '服务器新名称', version: 2 });
  });

  it('locks a stale form after 409 until explicitly reloading fields and version', { timeout: 60_000 }, async () => {
    let current = product({ id: 'p-2', code: 'COFFEE-1', name: '原始名称', version: 2 });
    const writes: Record<string, unknown>[] = [];
    mockFetch((url, init) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url === '/api/v1/auth/csrf') return jsonResponse(200, { csrfToken: 'csrf-token' });
      if (url === '/api/v1/catalog/products/p-2' && (init?.method ?? 'GET') === 'GET') {
        return jsonResponse(200, { product: current });
      }
      if (url === '/api/v1/catalog/products/p-2' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        writes.push(body);
        if (body.version === 2) {
          current = { ...current, name: '其他管理员修改', version: 3 };
          return jsonResponse(409, { error: 'PRODUCT_VERSION_CONFLICT', message: '商品版本冲突' });
        }
        return jsonResponse(200, { product: current });
      }
      if (url.startsWith('/api/v1/catalog/products?')) return listResponse([current]);
      return undefined;
    });
    renderRoutes('/catalog');
    expect(await screen.findByText('原始名称', undefined, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(findButtonText('编辑'));
    fireEvent.change(await screen.findByDisplayValue('原始名称'), { target: { value: '我的未保存修改' } });
    fireEvent.click(findButtonText('保存'));
    expect(await screen.findByText('商品已被他人修改')).toBeTruthy();
    expect(writes).toHaveLength(1);
    expect((findButtonText('保存') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(findButtonText('保存'));
    expect(writes).toHaveLength(1);
    fireEvent.click(findButtonText('重新加载详情'));
    expect(await screen.findByDisplayValue('其他管理员修改')).toBeTruthy();
    await waitFor(() => expect((findButtonText('保存') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(findButtonText('保存'));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toMatchObject({ name: '其他管理员修改', version: 3 });
  });

  it('warns before discarding unsaved product edits', { timeout: 60_000 }, async () => {
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url.startsWith('/api/v1/catalog/products?')) return listResponse([]);
      return undefined;
    });

    renderRoutes('/catalog');
    expect(await screen.findByText('还没有内部商品', undefined, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(findButtonText('新建商品'));
    fireEvent.change(await drawerField('商品名称'), {
      target: { value: '尚未保存的商品' },
    });
    fireEvent.click(findButtonText('关闭'));

    expect((await screen.findAllByText('放弃未保存的修改？')).length).toBeGreaterThan(0);
    fireEvent.click(findButtonText('继续编辑'));
    expect(await screen.findByText('新建内部商品')).toBeTruthy();
    expect(((await drawerField('商品名称')) as HTMLInputElement).value).toBe('尚未保存的商品');

    fireEvent.click(findButtonText('关闭'));
    expect((await screen.findAllByText('放弃未保存的修改？')).length).toBeGreaterThan(0);
    fireEvent.click(findButtonText('放弃修改'));
    await waitFor(() => expect(screen.queryByText('新建内部商品')).toBeNull());
  });

});

describe('configurable catalogue panel', () => {
  it('sends advanced filters, resets paging and keeps them shareable in the URL', { timeout: 60_000 }, async () => {
    const coffee = product({
      id: 'p-2',
      code: 'COFFEE-1',
      name: '咖啡券',
      displayPriceCents: 1500,
    });
    const listRequests: URLSearchParams[] = [];

    const fetchMock = mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url.startsWith('/api/v1/catalog/products?')) {
        const params = queryParams(url);
        listRequests.push(params);
        return listResponse([coffee], Number(params.get('page') ?? '1'));
      }
      return undefined;
    });

    const { router } = renderRoutes('/catalog?page=2');
    expect(await screen.findByText('咖啡券', undefined, { timeout: 5000 })).toBeTruthy();
    await waitFor(() => expect(listRequests.at(-1)?.get('page')).toBe('2'));

    // Advanced filters live inside a real modal, not in the compact toolbar.
    expect(screen.queryByLabelText('展示价（元）最小值')).toBeNull();
    fireEvent.click(findButtonText('高级检索'));
    const advancedDialog = await screen.findByRole('dialog', { name: '高级检索' });
    expect(within(advancedDialog).getByLabelText('展示价（元）最小值')).toBeTruthy();

    fireEvent.mouseDown(screen.getByLabelText('映射状态'));
    fireEvent.click(await screen.findByTitle('已生效'));
    fireEvent.change(screen.getByLabelText('展示价（元）最小值'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('展示价（元）最大值'), { target: { value: '20' } });
    fireEvent.click(within(advancedDialog).getByRole('button', { name: /查\s*询/ }));

    await waitFor(() => {
      const request = listRequests.at(-1);
      expect(request?.get('mappingState')).toBe('active');
      expect(request?.get('displayPriceMinCents')).toBe('1000');
      expect(request?.get('displayPriceMaxCents')).toBe('2000');
      // A filter change starts a new result set instead of staying on page two.
      expect(request?.get('page')).toBe('1');
    });

    const search = new URLSearchParams(router.state.location.search);
    expect(search.get('mappingState')).toBe('active');
    expect(search.get('displayPriceMinCents')).toBe('1000');
    expect(search.get('displayPriceMaxCents')).toBe('2000');
    expect(search.get('page')).toBeNull();
    expect(writeCalls(fetchMock)).toEqual([]);
  });

  it('restores mapping state, price range and server sort from a shared URL', { timeout: 60_000 }, async () => {
    const coffee = product({ id: 'p-2', code: 'COFFEE-1', name: '咖啡券' });
    const listRequests: URLSearchParams[] = [];

    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url.startsWith('/api/v1/catalog/products?')) {
        const params = queryParams(url);
        listRequests.push(params);
        return listResponse([coffee], Number(params.get('page') ?? '1'));
      }
      return undefined;
    });

    renderRoutes(
      '/catalog?mappingState=draft&displayPriceMinCents=1000&displayPriceMaxCents=2000' +
        '&sortBy=updatedAt&sortOrder=desc&page=2',
    );
    expect(await screen.findByText('咖啡券', undefined, { timeout: 5000 })).toBeTruthy();

    await waitFor(() => {
      const request = listRequests.at(-1);
      expect(request?.get('mappingState')).toBe('draft');
      expect(request?.get('displayPriceMinCents')).toBe('1000');
      expect(request?.get('displayPriceMaxCents')).toBe('2000');
      expect(request?.get('sortBy')).toBe('updatedAt');
      expect(request?.get('sortOrder')).toBe('desc');
      expect(request?.get('page')).toBe('2');
    });

    fireEvent.click(findButtonText('高级检索'));
    const dialog = await screen.findByRole('dialog', { name: '高级检索' });
    expect((within(dialog).getByLabelText('展示价（元）最小值') as HTMLInputElement).value).toBe('10');
    expect((screen.getByLabelText('展示价（元）最大值') as HTMLInputElement).value).toBe('20');
    // The select shows the parsed state, not the raw URL token.
    expect(screen.getByTitle('草稿未生效')).toBeTruthy();
  });

  it('refuses a contradictory price range instead of sending an invalid request', { timeout: 60_000 }, async () => {
    const coffee = product({ id: 'p-2', code: 'COFFEE-1', name: '咖啡券' });
    const listRequests: URLSearchParams[] = [];

    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url.startsWith('/api/v1/catalog/products?')) {
        const params = queryParams(url);
        listRequests.push(params);
        return listResponse([coffee]);
      }
      return undefined;
    });

    const { router } = renderRoutes('/catalog');
    expect(await screen.findByText('咖啡券', undefined, { timeout: 5000 })).toBeTruthy();
    const initialCalls = listRequests.length;

    fireEvent.click(findButtonText('高级检索'));
    const dialog = await screen.findByRole('dialog', { name: '高级检索' });
    fireEvent.change(screen.getByLabelText('展示价（元）最小值'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('展示价（元）最大值'), { target: { value: '20' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /查\s*询/ }));

    expect(await screen.findByText('展示价最低值不能高于最高值')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: '高级检索' })).toBeTruthy();
    expect(listRequests).toHaveLength(initialCalls);
    expect(router.state.location.search).toBe('');
    expect(listRequests.every((params) => params.get('displayPriceMinCents') === null)).toBe(true);
  });

  it('sorts through the server whitelist and resets to page one on a sort change', { timeout: 60_000 }, async () => {
    const coffee = product({
      id: 'p-2',
      code: 'COFFEE-1',
      name: '咖啡券',
      displayPriceCents: 1250,
    });
    const listRequests: URLSearchParams[] = [];

    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url.startsWith('/api/v1/catalog/products?')) {
        const params = queryParams(url);
        listRequests.push(params);
        return listResponse([coffee], Number(params.get('page') ?? '1'));
      }
      return undefined;
    });

    const { router } = renderRoutes('/catalog?page=2');
    expect(await screen.findByText('咖啡券', undefined, { timeout: 5000 })).toBeTruthy();
    await waitFor(() => expect(listRequests.at(-1)?.get('page')).toBe('2'));

    fireEvent.click(screen.getByRole('columnheader', { name: /展示价/ }));
    await waitFor(() => {
      const request = listRequests.at(-1);
      expect(request?.get('sortBy')).toBe('displayPriceCents');
      expect(request?.get('sortOrder')).toBe('asc');
      expect(request?.get('page')).toBe('1');
    });
    expect(router.state.location.search).toContain('sortBy=displayPriceCents');

    fireEvent.click(screen.getByRole('columnheader', { name: /展示价/ }));
    await waitFor(() => expect(listRequests.at(-1)?.get('sortOrder')).toBe('desc'));
    expect(router.state.location.search).toContain('sortOrder=desc');
  });

  it('drops invalid list parameters from a hand-edited URL', { timeout: 60_000 }, async () => {
    const coffee = product({ id: 'p-2', code: 'COFFEE-1', name: '咖啡券' });
    const listRequests: URLSearchParams[] = [];

    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url.startsWith('/api/v1/catalog/products?')) {
        const params = queryParams(url);
        listRequests.push(params);
        return listResponse([coffee]);
      }
      return undefined;
    });

    renderRoutes(
      '/catalog?status=deleted&mappingState=evil&displayPriceMinCents=abc' +
        '&displayPriceMaxCents=1.5&sortBy=evil&sortOrder=desc&page=abc&pageSize=999',
    );
    expect(await screen.findByText('咖啡券', undefined, { timeout: 5000 })).toBeTruthy();

    await waitFor(() => expect(listRequests.length).toBeGreaterThan(0));
    for (const request of listRequests) {
      expect(request.get('status')).toBeNull();
      expect(request.get('mappingState')).toBeNull();
      expect(request.get('displayPriceMinCents')).toBeNull();
      expect(request.get('displayPriceMaxCents')).toBeNull();
      expect(request.get('sortBy')).toBeNull();
      expect(request.get('sortOrder')).toBeNull();
      expect(request.get('page')).toBe('1');
      expect(request.get('pageSize')).toBe('20');
    }
    expect(screen.getAllByText('全部状态').length).toBeGreaterThan(0);
    // Mapping state moved to advanced search, not the compact quick toolbar.
    fireEvent.click(findButtonText('高级检索'));
    const dialog = await screen.findByRole('dialog', { name: '高级检索' });
    expect(within(dialog).getByTitle('全部映射')).toBeTruthy();
  });

  it('replays filters through browser back and forward', { timeout: 60_000 }, async () => {
    const travel = product({ id: 'p-1', code: 'TRAVEL-1', name: '腾讯出行券 10 元' });
    const coffee = product({ id: 'p-2', code: 'COFFEE-1', name: '咖啡券' });
    const listRequests: URLSearchParams[] = [];

    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url.startsWith('/api/v1/catalog/products?')) {
        const params = queryParams(url);
        listRequests.push(params);
        const keyword = params.get('keyword');
        const rows = keyword === '咖啡' ? [coffee] : keyword === '出行' ? [travel] : [travel, coffee];
        return listResponse(rows);
      }
      return undefined;
    });

    const { router } = renderRoutes('/catalog');
    expect(await screen.findByText('腾讯出行券 10 元', undefined, { timeout: 5000 })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('关键词'), { target: { value: '咖啡' } });
    fireEvent.click(findButtonText('查询'));
    await waitFor(() => expect(listRequests.at(-1)?.get('keyword')).toBe('咖啡'));

    fireEvent.change(screen.getByLabelText('关键词'), { target: { value: '出行' } });
    fireEvent.click(findButtonText('查询'));
    await waitFor(() => expect(listRequests.at(-1)?.get('keyword')).toBe('出行'));

    await router.navigate(-1);
    await waitFor(() => expect(listRequests.at(-1)?.get('keyword')).toBe('咖啡'));
    expect((screen.getByLabelText('关键词') as HTMLInputElement).value).toBe('咖啡');
    expect(await screen.findByText('咖啡券', undefined, { timeout: 5000 })).toBeTruthy();

    await router.navigate(1);
    await waitFor(() => expect(listRequests.at(-1)?.get('keyword')).toBe('出行'));
    expect((screen.getByLabelText('关键词') as HTMLInputElement).value).toBe('出行');
    expect(await screen.findByText('腾讯出行券 10 元', undefined, { timeout: 5000 })).toBeTruthy();
  });

  it('renders table and card views from the same query with independent view prefs', { timeout: 60_000 }, async () => {
    const coffee = product({
      id: 'p-2',
      code: 'COFFEE-1',
      name: '咖啡券',
      displayPriceCents: 1250,
      mapping: {
        state: 'active',
        provider: 'yangmao',
        productCode: 'YM-2002',
        fulfillmentMode: 'D',
        versionNumber: 2,
      },
    });
    const listRequests: URLSearchParams[] = [];

    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url.startsWith('/api/v1/catalog/products?')) {
        const params = queryParams(url);
        listRequests.push(params);
        return listResponse([coffee]);
      }
      return undefined;
    });

    renderRoutes('/catalog');
    expect(await screen.findByText('咖啡券', undefined, { timeout: 5000 })).toBeTruthy();
    const callsBeforeSwitch = listRequests.length;

    fireEvent.click(screen.getByText('卡片'));
    const cards = await screen.findByRole('list', { name: '数据卡片' });
    expect(within(cards).getByText('咖啡券')).toBeTruthy();
    expect(cards.textContent).toContain('¥12.50');
    expect(within(cards).getByText('已生效')).toBeTruthy();
    expect(cards.textContent).toContain('v2');
    // The view switch only changes local display preference, not the query.
    expect(listRequests).toHaveLength(callsBeforeSwitch);
    expect(useUiPrefs.getState().dataPanels['catalog-products']?.view).toBe('card');

    fireEvent.click(within(cards).getByRole('button', { name: /查\s*看/ }));
    expect(await screen.findByText('内部商品详情', undefined, { timeout: 5000 })).toBeTruthy();
  });

  it('keeps core columns visible while column management hides optional ones', { timeout: 60_000 }, async () => {
    const coffee = product({ id: 'p-2', code: 'COFFEE-1', name: '咖啡券' });

    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse(ADMIN);
      if (url.startsWith('/api/v1/catalog/products?')) return listResponse([coffee]);
      return undefined;
    });

    renderRoutes('/catalog');
    expect(await screen.findByText('咖啡券', undefined, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '列设置' }));
    const nameCheckbox = (await screen.findByRole('checkbox', { name: '商品名称' })) as HTMLInputElement;
    const codeCheckbox = screen.getByRole('checkbox', { name: '商品编码' }) as HTMLInputElement;
    expect(nameCheckbox.disabled).toBe(true);
    expect(codeCheckbox.disabled).toBe(true);

    fireEvent.click(screen.getByRole('checkbox', { name: '映射状态' }));
    await waitFor(() =>
      expect(screen.queryByRole('columnheader', { name: '映射状态' })).toBeNull(),
    );
    expect(useUiPrefs.getState().dataPanels['catalog-products']?.visibleKeys).not.toContain(
      'mappingState',
    );
    expect(screen.getByRole('columnheader', { name: '商品名称' })).toBeTruthy();
  });
});
