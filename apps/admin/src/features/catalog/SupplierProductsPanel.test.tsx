// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { SupplierCatalogResponse, SupplierProductDetail } from './api';
import { installDomStubs, renderRoutes, resetUiPrefs } from '../../test-utils/render-routes';
import { jsonResponse, mockFetch } from '../../test-utils/http';
import { writeCalls } from '../../test-utils/dom';

const SESSION_EXPIRES_AT = Date.now() + 60 * 60 * 1000;
const ADMIN = {
  id: 'account-1',
  username: 'ops.admin',
  displayName: '运维管理员',
  role: 'admin' as const,
};

function sessionResponse(): Response {
  return jsonResponse(200, { admin: ADMIN, session: { expiresAt: SESSION_EXPIRES_AT } });
}

/**
 * The supplier products panel now lives in the supplier detail page, so every
 * render path also needs the supplier registration profile that page reads.
 */
function supplierDetailResponse(): Response {
  return jsonResponse(200, {
    supplier: {
      key: 'yangmao',
      name: '上力',
      catalogRead: { supported: true, configured: true },
    },
  });
}

const SUPPLIER_CATALOG: SupplierCatalogResponse = {
  provider: 'yangmao',
  currency: 'CNY',
  observedAt: '2026-10-27T02:03:04.000Z',
  products: [
    { productCode: 'FIXTURE-A', sellPriceCents: 1234 },
    { productCode: 'FIXTURE-B', sellPriceCents: 5 },
  ],
};

// 供货目录 in the sidebar points at this deep link.
const SUPPLIER_CATALOG_PATH = '/suppliers/yangmao?tab=catalog';
/** Number of signed supplier snapshot reads issued so far. */
function catalogCalls(fetchMock: ReturnType<typeof vi.fn>): number {
  return (fetchMock.mock.calls as [string][]).filter(
    ([url]) => url === '/api/v1/catalog/supplier-products',
  ).length;
}

function supplierRegion(): HTMLElement {
  return screen.getByRole('region', { name: '供应商商品列表' });
}

function findButton(container: HTMLElement, text: string): HTMLElement {
  const elements = within(container).getAllByText(
    (content) => content.replace(/\s/g, '') === text,
  );
  const element = elements[0];
  const button = element?.closest('button');
  if (!button) throw new Error(`No button containing ${text}`);
  return button;
}

beforeAll(() => installDomStubs());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetUiPrefs();
});

describe('supplier products sub-tab', () => {
  it('opens from the supplier detail deep link, reads the real API result, and keeps its filter and view across tabs', async () => {
    const fetchMock = mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse();
      if (url === '/api/v1/suppliers/yangmao') return supplierDetailResponse();
      if (url === '/api/v1/catalog/supplier-products') return jsonResponse(200, SUPPLIER_CATALOG);
      return undefined;
    });

    const { router } = renderRoutes(SUPPLIER_CATALOG_PATH);

    expect(await screen.findByText('FIXTURE-A', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getAllByText('上力').length).toBeGreaterThan(0);
    expect(screen.getAllByText('¥12.34').length).toBeGreaterThan(0);
    expect(screen.getAllByText('尚未获取').length).toBeGreaterThan(0);
    expect(screen.getAllByText('待核实').length).toBeGreaterThan(0);
    expect(screen.getByRole('tab', { name: '供货商品', selected: true })).toBeTruthy();

    // The keyword filters the same real result locally; the supplier snapshot
    // request is not repeated per keystroke or per row.
    const section = supplierRegion();
    fireEvent.change(within(section).getByLabelText('上游商品编码'), {
      target: { value: 'B' },
    });
    fireEvent.click(findButton(section, '查询'));

    await waitFor(() => expect(within(section).queryByText('FIXTURE-A')).toBeNull());
    expect(within(section).getByText('FIXTURE-B')).toBeTruthy();

    // Card view consumes the same filtered result.
    fireEvent.click(within(section).getByText('卡片'));
    expect(await within(section).findByText('商品名称：尚未获取（选中后读取）')).toBeTruthy();
    expect(within(section).getByText('FIXTURE-B')).toBeTruthy();

    // Switch to 供应商概览 and back: the sub-tab keeps its filter and view.
    fireEvent.click(screen.getByRole('tab', { name: '供应商概览' }));
    expect(await screen.findByText('接入与供货概览', undefined, { timeout: 5000 })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '供货商品' }));

    const restored = supplierRegion();
    expect((within(restored).getByLabelText('上游商品编码') as HTMLInputElement).value).toBe('B');
    expect(within(restored).getByText('FIXTURE-B')).toBeTruthy();
    expect(within(restored).queryByText('FIXTURE-A')).toBeNull();
    expect(await within(restored).findByText('商品名称：尚未获取（选中后读取）')).toBeTruthy();
    // The filter lives in the URL next to the deep-linkable tab key, so a refresh
    // reproduces both the open sub-tab and the applied keyword.
    const restoredSearch = new URLSearchParams(router.state.location.search);
    expect(restoredSearch.get('tab')).toBe('catalog');
    expect(restoredSearch.get('supplierQ')).toBe('B');
    expect(screen.getByRole('tab', { name: '供货商品', selected: true })).toBeTruthy();

    // The read-only panel still sent no write request.
    expect(writeCalls(fetchMock)).toEqual([]);
  }, 60_000);

  it('restores the supplier keyword from the URL after a refresh', async () => {
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse();
      if (url === '/api/v1/suppliers/yangmao') return supplierDetailResponse();
      if (url === '/api/v1/catalog/supplier-products') return jsonResponse(200, SUPPLIER_CATALOG);
      return undefined;
    });

    renderRoutes(SUPPLIER_CATALOG_PATH + '&supplierQ=FIXTURE-B');

    const section = await screen.findByRole('region', { name: '供应商商品列表' }, { timeout: 5000 });
    expect(await within(section).findByText('FIXTURE-B', undefined, { timeout: 5000 })).toBeTruthy();
    expect(within(section).queryByText('FIXTURE-A')).toBeNull();
    expect((within(section).getByLabelText('上游商品编码') as HTMLInputElement).value).toBe(
      'FIXTURE-B',
    );
  }, 60_000);

  it('keeps the supplier keyword when visiting the supplier overview and back', async () => {
    const fetchMock = mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse();
      if (url === '/api/v1/suppliers/yangmao') return supplierDetailResponse();
      if (url === '/api/v1/catalog/supplier-products') return jsonResponse(200, SUPPLIER_CATALOG);
      return undefined;
    });

    const { router } = renderRoutes(SUPPLIER_CATALOG_PATH);
    const section = await screen.findByRole('region', { name: '供应商商品列表' }, { timeout: 5000 });
    expect(await within(section).findByText('FIXTURE-A', undefined, { timeout: 5000 })).toBeTruthy();
    const callsAfterLoad = catalogCalls(fetchMock);
    fireEvent.change(within(section).getByLabelText('上游商品编码'), { target: { value: 'B' } });
    fireEvent.click(findButton(section, '查询'));
    await waitFor(() => expect(within(section).queryByText('FIXTURE-A')).toBeNull());
    expect(within(section).getByText('FIXTURE-B')).toBeTruthy();
    // Keyword filtering consumes the loaded snapshot; it never fans out into
    // another signed supplier request.
    expect(catalogCalls(fetchMock)).toBe(callsAfterLoad);

    fireEvent.click(screen.getByRole('tab', { name: '供应商概览' }));
    expect(await screen.findByText('接入与供货概览', undefined, { timeout: 5000 })).toBeTruthy();
    // Leaving 供货商品 removes only the tab key; the panel's own filter stays,
    // and the sidebar points back at 供应商管理 instead of the deep link.
    await waitFor(() =>
      expect(new URLSearchParams(router.state.location.search).get('supplierQ')).toBe('B'),
    );
    expect(new URLSearchParams(router.state.location.search).get('tab')).toBeNull();
    expect(screen.getByRole('tab', { name: '供应商管理' })).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: '供货商品' }));
    expect(await screen.findByText('FIXTURE-B', undefined, { timeout: 5000 })).toBeTruthy();
    expect((screen.getByLabelText('上游商品编码') as HTMLInputElement).value).toBe('B');
    expect(screen.queryByText('FIXTURE-A')).toBeNull();
  }, 60_000);

  it('paginates internal product cards and keeps the page when switching to table view', async () => {
    const internalProducts = Array.from({ length: 25 }, (_, index) => ({
      id: `internal-${index + 1}`,
      code: `INTERNAL-${String(index + 1).padStart(2, '0')}`,
      name: `内部商品${index + 1}`,
      shortDescription: '',
      status: 'active' as const,
      displayPriceCents: 1200,
      estimatedCostCents: null,
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));

    const fetchMock = mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse();
      if (url === '/api/v1/catalog/supplier-products') return jsonResponse(200, SUPPLIER_CATALOG);
      if (url.startsWith('/api/v1/catalog/products?')) {
        const params = new URLSearchParams(url.split('?')[1] ?? '');
        const page = Number(params.get('page') ?? 1);
        const pageSize = Number(params.get('pageSize') ?? 20);
        return jsonResponse(200, {
          products: internalProducts.slice((page - 1) * pageSize, page * pageSize),
          page,
          pageSize,
          total: internalProducts.length,
        });
      }
      return undefined;
    });

    renderRoutes('/catalog');
    const section = await screen.findByRole('region', { name: '内部商品列表' }, { timeout: 5000 });
    expect(await within(section).findByText('INTERNAL-01', undefined, { timeout: 5000 })).toBeTruthy();

    fireEvent.click(within(section).getByText('卡片'));
    expect(await within(section).findByText('INTERNAL-01')).toBeTruthy();

    const nextPage = section.querySelector('.data-panel-pagination .ant-pagination-next button');
    expect(nextPage).toBeTruthy();
    fireEvent.click(nextPage!);

    expect(await within(section).findByText('INTERNAL-21', undefined, { timeout: 5000 })).toBeTruthy();
    expect(within(section).queryByText('INTERNAL-01')).toBeNull();

    fireEvent.click(within(section).getByText('表格'));
    expect(await within(section).findByText('INTERNAL-21')).toBeTruthy();
    fireEvent.click(within(section).getByText('卡片'));
    expect(await within(section).findByText('INTERNAL-21')).toBeTruthy();

    const readUrls = (fetchMock.mock.calls as [string][]).map(([url]) => url);
    expect(
      readUrls.some((url) =>
        url.startsWith('/api/v1/catalog/products?') &&
        new URLSearchParams(url.split('?')[1] ?? '').get('page') === '2',
      ),
    ).toBe(true);
    expect(writeCalls(fetchMock)).toEqual([]);
  }, 60_000);

  it('shows a real empty supplier catalogue distinctly from a failure', async () => {
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse();
      if (url === '/api/v1/suppliers/yangmao') return supplierDetailResponse();
      if (url === '/api/v1/catalog/supplier-products') {
        return jsonResponse(200, { ...SUPPLIER_CATALOG, products: [] });
      }
      return undefined;
    });

    renderRoutes(SUPPLIER_CATALOG_PATH);

    expect(
      await screen.findByText('尚未获取到供应商商品', undefined, { timeout: 5000 }),
    ).toBeTruthy();
    expect(screen.queryByText('供应商商品读取失败')).toBeNull();
    expect(screen.queryByText('没有符合条件的供应商商品')).toBeNull();
  }, 60_000);

  it('shows an explicit unconfigured state instead of an empty catalogue', async () => {
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse();
      if (url === '/api/v1/suppliers/yangmao') return supplierDetailResponse();
      if (url === '/api/v1/catalog/supplier-products') {
        return jsonResponse(503, {
          error: 'SUPPLIER_NOT_CONFIGURED',
          message: '上力供应商商品读取尚未配置；请在服务器侧配置只读凭证后重试',
        });
      }
      return undefined;
    });

    renderRoutes(SUPPLIER_CATALOG_PATH);

    expect(
      await screen.findByText('尚未配置上力只读凭证', undefined, { timeout: 5000 }),
    ).toBeTruthy();
    expect(screen.queryByText('尚未获取到供应商商品')).toBeNull();
  }, 60_000);

  it('shows a load failure with retry and never renders it as an empty catalogue', async () => {
    let fail = true;
    mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse();
      if (url === '/api/v1/suppliers/yangmao') return supplierDetailResponse();
      if (url === '/api/v1/catalog/supplier-products') {
        if (fail) {
          return jsonResponse(502, {
            error: 'SUPPLIER_READ_FAILED',
            message: '上力供应商商品读取失败，请稍后重试',
          });
        }
        return jsonResponse(200, SUPPLIER_CATALOG);
      }
      return undefined;
    });

    renderRoutes(SUPPLIER_CATALOG_PATH);

    expect(
      await screen.findByText('供应商商品读取失败', undefined, { timeout: 5000 }),
    ).toBeTruthy();
    expect(screen.queryByText('尚未获取到供应商商品')).toBeNull();

    fail = false;
    fireEvent.click(within(supplierRegion()).getByRole('button', { name: /重\s*试/ }));

    expect(await screen.findByText('FIXTURE-A', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText('供应商商品读取失败')).toBeNull();
  }, 60_000);

  it('reads the vendor name only when one product is selected, without writes', async () => {
    const detail: SupplierProductDetail = {
      provider: 'yangmao',
      currency: 'CNY',
      observedAt: '2026-10-27T02:05:06.000Z',
      productCode: 'FIXTURE-A',
      name: '上力测试商品甲',
      sellPriceCents: 1234,
    };
    const fetchMock = mockFetch((url) => {
      if (url === '/api/v1/auth/session') return sessionResponse();
      if (url === '/api/v1/suppliers/yangmao') return supplierDetailResponse();
      if (url === '/api/v1/catalog/supplier-products') return jsonResponse(200, SUPPLIER_CATALOG);
      if (url === '/api/v1/catalog/supplier-products/FIXTURE-A') {
        return jsonResponse(200, { product: detail });
      }
      return undefined;
    });

    renderRoutes(SUPPLIER_CATALOG_PATH);
    expect(await screen.findByText('FIXTURE-A', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText('上力测试商品甲')).toBeNull();

    fireEvent.click(findButton(supplierRegion(), '查看详情'));

    expect(await screen.findByText('上力测试商品甲', undefined, { timeout: 5000 })).toBeTruthy();
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('供应商商品详情')).toBeTruthy();
    expect(within(dialog).getByText('¥12.34')).toBeTruthy();
    expect(within(dialog).getByText('待核实')).toBeTruthy();
    expect(within(dialog).getByText(/2026/)).toBeTruthy();

    // No supplier dispatch, edit or import request is ever issued from this tab.
    expect(writeCalls(fetchMock)).toEqual([]);
    const detailCalls = (fetchMock.mock.calls as [string][])
      .map(([url]) => url)
      .filter((url) => url === '/api/v1/catalog/supplier-products/FIXTURE-A');
    expect(detailCalls).toHaveLength(1);
  }, 60_000);
});
