// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { CatalogProduct } from '../catalog/api';
import { installDomStubs, renderRoutes, resetUiPrefs } from '../../test-utils/render-routes';
import { jsonResponse, mockFetch } from '../../test-utils/http';
import { findButtonText, writeCalls } from '../../test-utils/dom';

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

function rowButton(productName: string, label: string): HTMLElement {
  const row = screen.getByText(productName).closest('tr');
  if (!row) throw new Error(`No table row for ${productName}`);
  const element = within(row).getByText((content) => content.replace(/\s/g, '') === label);
  const button = element.closest('button');
  if (!button) throw new Error(`No ${label} button for ${productName}`);
  return button;
}

function mappingRequests(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return (fetchMock.mock.calls as [string][])
    .map(([url]) => url)
    .filter((url) => url.endsWith('/mapping'));
}

type MappingWriteAction = 'draft' | 'validate' | 'activate';

function standardHandler(options: {
  session?: Session;
  products: CatalogProduct[];
  mapping: (productId: string) => Response | Promise<Response> | undefined;
  mappingWrite?: (
    productId: string,
    action: MappingWriteAction,
    init?: RequestInit,
  ) => Response | Promise<Response> | undefined;
}) {
  const { session = ADMIN, products, mapping, mappingWrite } = options;
  return (url: string, init?: RequestInit) => {
    if (url === '/api/v1/auth/session') return sessionResponse(session);
    if (url === '/api/v1/auth/csrf') return jsonResponse(200, { csrfToken: 'csrf-token' });
    if (url.startsWith('/api/v1/catalog/products?') && (init?.method ?? 'GET') === 'GET') {
      return listResponse(products);
    }
    const detailMatch = /^\/api\/v1\/catalog\/products\/([^/?]+)$/.exec(url);
    if (detailMatch && (init?.method ?? 'GET') === 'GET') {
      const found = products.find((item) => item.id === detailMatch[1]);
      return found ? jsonResponse(200, { product: found }) : undefined;
    }
    const writeMatch =
      /^\/api\/v1\/catalog\/products\/([^/?]+)\/mapping\/(draft|validate|activate)$/.exec(url);
    if (writeMatch && mappingWrite) {
      return mappingWrite(
        decodeURIComponent(writeMatch[1]),
        writeMatch[2] as MappingWriteAction,
        init,
      );
    }
    const mappingMatch = /^\/api\/v1\/catalog\/products\/([^/?]+)\/mapping$/.exec(url);
    if (mappingMatch && (init?.method ?? 'GET') === 'GET') {
      return mapping(decodeURIComponent(mappingMatch[1]));
    }
    return undefined;
  };
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (!init?.body) throw new Error('expected a JSON request body');
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function requestHeaders(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

beforeAll(() => installDomStubs());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetUiPrefs();
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

    // The list does not fabricate a fulfillment state; mapping is inspected per product.
    expect(screen.queryByRole('columnheader', { name: '真实发放' })).toBeNull();

    fireEvent.click(rowButton('腾讯出行券 10 元', '查看'));
    expect(await screen.findByText('内部商品详情', undefined, { timeout: 5000 })).toBeTruthy();

    const panel = await screen.findByLabelText('供应商映射面板');
    expect(await within(panel).findByText('尚未配置供应商映射')).toBeTruthy();
    expect(within(panel).queryByText('仅完成本地映射校验')).toBeNull();
    expect(within(panel).queryByText(/upstreamVerified/)).toBeNull();
    // The product table header carries the same accessible name as the drawer
    // field, so the drawer input must be resolved inside the dialog.
    const drawer = await screen.findByRole('dialog');
    expect((within(drawer).getByLabelText('商品名称') as HTMLInputElement).value).toBe(
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
    expect(within(panel).getByText('仅完成本地映射校验')).toBeTruthy();
    expect(within(panel).getByText(/本地结构与模式规则/)).toBeTruthy();
    expect(within(panel).getByText('YM-1001')).toBeTruthy();

    // The admin editor exposes the frozen draft -> validate -> activate flow.
    expect(within(panel).getByText('映射草稿编辑')).toBeTruthy();
    expect(within(panel).getByRole('button', { name: '保存草稿' })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: '本地校验' })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: '激活映射' })).toBeTruthy();
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
    expect(within(panel).getByText('仅完成本地映射校验')).toBeTruthy();

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

type Panel = HTMLElement;

/** Opens the editable product drawer and waits for the admin mapping editor. */
async function openMappingEditor(productName = '腾讯出行券 10 元'): Promise<Panel> {
  renderRoutes('/catalog');
  expect(await screen.findByText(productName, undefined, { timeout: 5000 })).toBeTruthy();
  fireEvent.click(rowButton(productName, '编辑'));
  const panel = await screen.findByLabelText('供应商映射面板');
  expect(await within(panel).findByText('映射草稿编辑')).toBeTruthy();
  return panel;
}

function productCodeInput(panel: Panel): HTMLInputElement {
  const input = within(panel).getByLabelText('上游商品编码');
  if (!(input instanceof HTMLInputElement)) throw new Error('expected a product code input');
  return input;
}

function panelButton(panel: Panel, name: string): HTMLButtonElement {
  const button = within(panel).getByRole('button', { name });
  if (!(button instanceof HTMLButtonElement)) throw new Error(`expected ${name} button`);
  return button;
}

/** The product Drawer is also role="dialog"; only Ant Design Modals are relevant here. */
function modalDialog(): HTMLElement | undefined {
  return screen.queryAllByRole('dialog').find((element) => element.classList.contains('ant-modal'));
}

async function findModalDialog(): Promise<HTMLElement> {
  return waitFor(
    () => {
      const modal = modalDialog();
      if (!modal) throw new Error('expected an Ant Design Modal dialog');
      return modal;
    },
    { timeout: 5000 },
  );
}

describe('supplier mapping draft editor', () => {
  it('creates a first draft with expectedVersion null through the real PUT and CSRF header', {
    timeout: 60_000,
  }, async () => {
    const travel = product({ id: 'p-1', code: 'TRAVEL-1', name: '腾讯出行券 10 元' });
    let overview: Record<string, unknown> = emptyOverview('p-1');
    let putBody: Record<string, unknown> | null = null;
    let putHeaders: Record<string, string> = {};

    const fetchMock = mockFetch(
      standardHandler({
        products: [travel],
        mapping: (id) => jsonResponse(200, { ...overview, productId: id }),
        mappingWrite: (id, action, init) => {
          if (action !== 'draft') return undefined;
          putBody = requestBody(init);
          putHeaders = requestHeaders(init);
          overview = {
            ...emptyOverview(id),
            draft: draft(id, {
              version: 1,
              validatedVersion: null,
              validatedAt: null,
              productCode: 'YM-1001',
              fulfillmentMode: 'A',
              deductionUnit: 'pack',
            }),
          };
          return jsonResponse(200, overview);
        },
      }),
    );

    const panel = await openMappingEditor();
    fireEvent.change(productCodeInput(panel), { target: { value: 'YM-1001' } });
    fireEvent.click(panelButton(panel, '保存草稿'));

    expect(
      await screen.findByText('草稿已保存，未生效', undefined, { timeout: 5000 }),
    ).toBeTruthy();
    expect(putBody).toEqual({
      expectedVersion: null,
      provider: 'yangmao',
      productCode: 'YM-1001',
      fulfillmentMode: 'A',
      deductionUnit: 'pack',
    });
    expect(putHeaders['x-csrf-token']).toBe('csrf-token');

    expect(await within(panel).findByText('草稿 v1')).toBeTruthy();
    expect(within(panel).getAllByText('待本地校验').length).toBeGreaterThan(0);
    expect(panelButton(panel, '激活映射').disabled).toBe(true);
    expect(writeCalls(fetchMock)).toEqual([
      'PUT /api/v1/catalog/products/p-1/mapping/draft',
    ]);
    expect(screen.queryByText(/真实权益已可发放/)).toBeNull();
  });

  it('updates an existing draft with its snapshot version and never changes the active version', {
    timeout: 60_000,
  }, async () => {
    const travel = product({ id: 'p-1', code: 'TRAVEL-1', name: '腾讯出行券 10 元' });
    const active = activatedVersion('p-1');
    let overview: Record<string, unknown> = {
      ...emptyOverview('p-1'),
      draft: draft('p-1'),
      activeVersion: active,
      versions: [active],
    };
    let putBody: Record<string, unknown> | null = null;

    mockFetch(
      standardHandler({
        products: [travel],
        mapping: (id) => jsonResponse(200, { ...overview, productId: id }),
        mappingWrite: (id, action, init) => {
          if (action !== 'draft') return undefined;
          putBody = requestBody(init);
          overview = {
            ...emptyOverview(id),
            draft: draft(id, {
              version: 3,
              validatedVersion: null,
              validatedAt: null,
              productCode: 'YM-2002',
            }),
            activeVersion: active,
            versions: [active],
          };
          return jsonResponse(200, overview);
        },
      }),
    );

    const panel = await openMappingEditor();
    await waitFor(() => expect(productCodeInput(panel).value).toBe('YM-1001'));
    fireEvent.change(productCodeInput(panel), { target: { value: 'YM-2002' } });
    fireEvent.click(panelButton(panel, '保存草稿'));

    expect(
      await screen.findByText('草稿已保存，未生效', undefined, { timeout: 5000 }),
    ).toBeTruthy();
    expect(putBody).toEqual({
      expectedVersion: 2,
      provider: 'yangmao',
      productCode: 'YM-2002',
      fulfillmentMode: 'B',
      deductionUnit: 'pack',
    });
    expect(await within(panel).findByText('草稿 v3')).toBeTruthy();
    expect(within(panel).getByText('映射已激活')).toBeTruthy();
    expect(within(panel).getAllByText('YM-ACTIVE').length).toBeGreaterThan(0);
    expect(within(panel).getAllByText('待本地校验').length).toBeGreaterThan(0);
    expect(panelButton(panel, '激活映射').disabled).toBe(true);
  });

  it('invalidates local validation on edit, then saves and validates the new version', {
    timeout: 60_000,
  }, async () => {
    const travel = product({ id: 'p-1', code: 'TRAVEL-1', name: '腾讯出行券 10 元' });
    let overview: Record<string, unknown> = {
      ...emptyOverview('p-1'),
      draft: draft('p-1'),
    };
    const bodies: Record<string, Record<string, unknown>> = {};

    mockFetch(
      standardHandler({
        products: [travel],
        mapping: (id) => jsonResponse(200, { ...overview, productId: id }),
        mappingWrite: (id, action, init) => {
          if (action === 'draft') {
            bodies.draft = requestBody(init);
            overview = {
              ...emptyOverview(id),
              draft: draft(id, {
                version: 3,
                validatedVersion: null,
                validatedAt: null,
                productCode: 'YM-3003',
              }),
            };
            return jsonResponse(200, overview);
          }
          if (action === 'validate') {
            bodies.validate = requestBody(init);
            overview = {
              ...emptyOverview(id),
              draft: draft(id, {
                version: 3,
                validatedVersion: 3,
                validatedAt: NOW,
                productCode: 'YM-3003',
              }),
            };
            return jsonResponse(200, overview);
          }
          return undefined;
        },
      }),
    );

    const panel = await openMappingEditor();
    await waitFor(() => expect(productCodeInput(panel).value).toBe('YM-1001'));
    expect(panelButton(panel, '激活映射').disabled).toBe(false);

    fireEvent.change(productCodeInput(panel), { target: { value: 'YM-3003' } });
    expect(await within(panel).findByText('表单已修改，需保存并重新校验')).toBeTruthy();
    expect(panelButton(panel, '激活映射').disabled).toBe(true);
    expect(panelButton(panel, '本地校验').disabled).toBe(true);
    expect(panelButton(panel, '保存草稿').disabled).toBe(false);
    expect(Object.keys(bodies)).toEqual([]);

    fireEvent.click(panelButton(panel, '保存草稿'));
    expect(
      await screen.findByText('草稿已保存，未生效', undefined, { timeout: 5000 }),
    ).toBeTruthy();
    await waitFor(() => expect(within(panel).getAllByText('待本地校验').length).toBeGreaterThan(0));
    expect(panelButton(panel, '激活映射').disabled).toBe(true);

    fireEvent.click(panelButton(panel, '本地校验'));
    expect(
      await screen.findByText('本地校验已记录，仅代表本地结构检查', undefined, { timeout: 5000 }),
    ).toBeTruthy();
    expect(await within(panel).findByText('本地校验有效（v3）')).toBeTruthy();
    expect(panelButton(panel, '激活映射').disabled).toBe(false);
    expect(bodies.draft).toMatchObject({ expectedVersion: 2, productCode: 'YM-3003' });
    expect(bodies.validate).toEqual({ version: 3 });
  });

  it('shows stable local validation issue explanations for a 422 and never claims upstream success', {
    timeout: 60_000,
  }, async () => {
    const travel = product({ id: 'p-1', code: 'TRAVEL-1', name: '腾讯出行券 10 元' });

    mockFetch(
      standardHandler({
        products: [travel],
        mapping: (id) =>
          jsonResponse(200, {
            ...emptyOverview(id),
            draft: draft(id, { validatedVersion: null, validatedAt: null }),
          }),
        mappingWrite: (_id, action) => {
          if (action !== 'validate') return undefined;
          return jsonResponse(422, {
            error: 'MAPPING_VALIDATION_FAILED',
            message: '映射草稿未通过本地校验',
            issues: ['deduction_unit_mismatch', 'product_code_invalid'],
          });
        },
      }),
    );

    const panel = await openMappingEditor();
    fireEvent.click(panelButton(panel, '本地校验'));

    expect(await within(panel).findByText('草稿未通过本地校验')).toBeTruthy();
    expect(
      within(panel).getByText('扣减单位与履约模式不匹配：A/B/C 使用 pack，D 使用 amount'),
    ).toBeTruthy();
    expect(
      within(panel).getByText('上游商品编码格式不正确，需为 1-64 位字母、数字或 . _ -'),
    ).toBeTruthy();
    expect(within(panel).getByText(/未调用供应商/)).toBeTruthy();
    expect(screen.queryByText('供应商验证通过')).toBeNull();
    expect(screen.queryByText(/上游验证通过/)).toBeNull();
    expect(screen.queryByText('本地校验已记录，仅代表本地结构检查')).toBeNull();
    expect(within(panel).getAllByText('待本地校验').length).toBeGreaterThan(0);
    expect(panelButton(panel, '激活映射').disabled).toBe(true);
  });

  it('requires an explicit diff confirmation before activating and then shows new active history', {
    timeout: 60_000,
  }, async () => {
    const travel = product({ id: 'p-1', code: 'TRAVEL-1', name: '腾讯出行券 10 元' });
    const active = activatedVersion('p-1');
    let overview: Record<string, unknown> = {
      ...emptyOverview('p-1'),
      draft: draft('p-1', { productCode: 'YM-NEW' }),
      activeVersion: active,
      versions: [active],
    };
    let activateBody: Record<string, unknown> | null = null;
    let activateHeaders: Record<string, string> = {};

    const fetchMock = mockFetch(
      standardHandler({
        products: [travel],
        mapping: (id) => jsonResponse(200, { ...overview, productId: id }),
        mappingWrite: (id, action, init) => {
          if (action !== 'activate') return undefined;
          activateBody = requestBody(init);
          activateHeaders = requestHeaders(init);
          const activated = activatedVersion(id, {
            id: `version-${id}-2`,
            versionNumber: 2,
            productCode: 'YM-NEW',
            fulfillmentMode: 'B',
            deductionUnit: 'pack',
            sourceDraftVersion: 2,
            activatedAt: NOW,
          });
          overview = {
            ...emptyOverview(id),
            draft: draft(id, {
              version: 3,
              validatedVersion: null,
              validatedAt: null,
              productCode: 'YM-NEW',
            }),
            activeVersion: activated,
            versions: [active, activated],
          };
          return jsonResponse(200, overview);
        },
      }),
    );

    const panel = await openMappingEditor();
    fireEvent.click(panelButton(panel, '激活映射'));

    const modal = await findModalDialog();
    expect(within(modal).getByText('当前生效版本 v1 与拟激活草稿的差异')).toBeTruthy();
    expect(within(modal).getAllByText('YM-ACTIVE').length).toBeGreaterThan(0);
    expect(within(modal).getAllByText('YM-NEW').length).toBeGreaterThan(0);
    expect(within(modal).getAllByText('变更').length).toBeGreaterThan(0);
    expect(
      within(modal).getByText('只影响此后新建订单；旧订单已绑定原映射版本，保持不变。'),
    ).toBeTruthy();
    expect(
      within(modal).getByText('本次仅基于本地结构校验，未进行上游验证（upstreamVerified: false）。'),
    ).toBeTruthy();
    expect(within(modal).getByText(/激活映射只绑定订单使用的供货关系/)).toBeTruthy();
    expect(writeCalls(fetchMock)).toEqual([]);

    fireEvent.click(within(modal).getByRole('button', { name: /取\s*消/ }));
    await waitFor(() => expect(modalDialog()).toBeUndefined());
    expect(writeCalls(fetchMock)).toEqual([]);

    fireEvent.click(panelButton(panel, '激活映射'));
    const confirmModal = await findModalDialog();
    fireEvent.click(within(confirmModal).getByRole('button', { name: '确认激活' }));

    expect(
      await screen.findByText('映射 v2 已激活，仅影响此后新建订单', undefined, { timeout: 5000 }),
    ).toBeTruthy();
    expect(activateBody).toEqual({ version: 2 });
    expect(activateHeaders['x-csrf-token']).toBe('csrf-token');
    expect(writeCalls(fetchMock)).toEqual([
      'POST /api/v1/catalog/products/p-1/mapping/activate',
    ]);

    expect(await within(panel).findByText('历史版本（2）')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('tab', { name: /历史版本/ }));
    expect(await within(panel).findByText('历史版本只读')).toBeTruthy();
    expect(within(panel).getAllByText('YM-NEW').length).toBeGreaterThan(0);
    expect(screen.queryByText(/真实权益已可发放/)).toBeNull();
  });

  it('names the first activation as having no previous effective version', { timeout: 60_000 }, async () => {
    const travel = product({ id: 'p-1', code: 'TRAVEL-1', name: '腾讯出行券 10 元' });

    mockFetch(
      standardHandler({
        products: [travel],
        mapping: (id) =>
          jsonResponse(200, {
            ...emptyOverview(id),
            draft: draft(id, { version: 1, validatedVersion: 1 }),
          }),
      }),
    );

    const panel = await openMappingEditor();
    fireEvent.click(panelButton(panel, '激活映射'));
    const modal = await findModalDialog();
    expect(within(modal).getByText('此前无生效版本')).toBeTruthy();
    expect(within(modal).getByText('拟激活内容')).toBeTruthy();
    fireEvent.click(within(modal).getByRole('button', { name: /取\s*消/ }));
    await waitFor(() => expect(modalDialog()).toBeUndefined());
  });

  it('locks after a version conflict, keeps input, and only reloads after explicit discard', {
    timeout: 60_000,
  }, async () => {
    const travel = product({ id: 'p-1', code: 'TRAVEL-1', name: '腾讯出行券 10 元' });
    let mappingReads = 0;
    const initial = {
      ...emptyOverview('p-1'),
      draft: draft('p-1'),
    };
    const latest = {
      ...emptyOverview('p-1'),
      draft: draft('p-1', {
        version: 4,
        validatedVersion: 4,
        validatedAt: NOW,
        productCode: 'YM-SERVER',
      }),
    };

    const fetchMock = mockFetch(
      standardHandler({
        products: [travel],
        mapping: (id) => {
          mappingReads += 1;
          return jsonResponse(200, { ...(mappingReads === 1 ? initial : latest), productId: id });
        },
        mappingWrite: (_id, action) => {
          if (action !== 'draft') return undefined;
          return jsonResponse(409, {
            error: 'MAPPING_VERSION_CONFLICT',
            message: '映射草稿版本已变化，请刷新后重试',
          });
        },
      }),
    );

    const panel = await openMappingEditor();
    await waitFor(() => expect(productCodeInput(panel).value).toBe('YM-1001'));
    fireEvent.change(productCodeInput(panel), { target: { value: 'YM-LOCAL' } });
    fireEvent.click(panelButton(panel, '保存草稿'));

    expect(await within(panel).findByText('映射草稿版本已变化')).toBeTruthy();
    expect(productCodeInput(panel).value).toBe('YM-LOCAL');
    expect(panelButton(panel, '保存草稿').disabled).toBe(true);
    expect(panelButton(panel, '本地校验').disabled).toBe(true);
    expect(panelButton(panel, '激活映射').disabled).toBe(true);

    fireEvent.click(panelButton(panel, '重新加载最新版本'));
    const keepEditing = await findModalDialog();
    fireEvent.click(within(keepEditing).getByRole('button', { name: '继续编辑' }));
    await waitFor(() =>
      expect(modalDialog()).toBeUndefined(),
    );
    expect(productCodeInput(panel).value).toBe('YM-LOCAL');
    expect(within(panel).getByText('映射草稿版本已变化')).toBeTruthy();

    fireEvent.click(panelButton(panel, '重新加载最新版本'));
    const discard = await findModalDialog();
    fireEvent.click(within(discard).getByRole('button', { name: '放弃并刷新' }));

    await waitFor(() => expect(productCodeInput(panel).value).toBe('YM-SERVER'));
    expect(within(panel).queryByText('映射草稿版本已变化')).toBeNull();
    expect(within(panel).getByText('本地校验有效（v4）')).toBeTruthy();
    expect(panelButton(panel, '保存草稿').disabled).toBe(true);
    expect(writeCalls(fetchMock)).toEqual([
      'PUT /api/v1/catalog/products/p-1/mapping/draft',
    ]);
  });

  it('keeps the conflict lock when reloading the latest mapping fails', {
    timeout: 60_000,
  }, async () => {
    const travel = product({ id: 'p-1', code: 'TRAVEL-1', name: '腾讯出行券 10 元' });
    let mappingReads = 0;

    mockFetch(
      standardHandler({
        products: [travel],
        mapping: (id) => {
          mappingReads += 1;
          if (mappingReads === 1) {
            return jsonResponse(200, { ...emptyOverview(id), draft: draft(id) });
          }
          return jsonResponse(500, {
            error: 'INTERNAL_ERROR',
            message: '供应商映射服务暂时不可用',
          });
        },
        mappingWrite: (_id, action) => {
          if (action !== 'draft') return undefined;
          return jsonResponse(409, {
            error: 'MAPPING_VERSION_CONFLICT',
            message: '映射草稿版本已变化，请刷新后重试',
          });
        },
      }),
    );

    const panel = await openMappingEditor();
    await waitFor(() => expect(productCodeInput(panel).value).toBe('YM-1001'));
    fireEvent.change(productCodeInput(panel), { target: { value: 'YM-LOCAL' } });
    fireEvent.click(panelButton(panel, '保存草稿'));
    expect(await within(panel).findByText('映射草稿版本已变化')).toBeTruthy();

    fireEvent.click(panelButton(panel, '重新加载最新版本'));
    const dialog = await findModalDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: '放弃并刷新' }));

    expect(await within(panel).findByText('无法加载最新映射状态')).toBeTruthy();
    expect(within(panel).getByText('映射草稿版本已变化')).toBeTruthy();
    expect(productCodeInput(panel).value).toBe('YM-LOCAL');
    expect(panelButton(panel, '保存草稿').disabled).toBe(true);
    expect(panelButton(panel, '激活映射').disabled).toBe(true);
    expect(screen.queryByText('草稿已保存，未生效')).toBeNull();
  });

  it('recovers from a duplicate first-create conflict by reloading and updating that draft', {
    timeout: 60_000,
  }, async () => {
    const travel = product({ id: 'p-1', code: 'TRAVEL-1', name: '腾讯出行券 10 元' });
    let mappingReads = 0;
    let existing = draft('p-1', {
      version: 5,
      validatedVersion: null,
      validatedAt: null,
      productCode: 'YM-EXISTING',
    });
    const putBodies: (Record<string, unknown> | null)[] = [];

    mockFetch(
      standardHandler({
        products: [travel],
        mapping: (id) => {
          mappingReads += 1;
          return jsonResponse(200, {
            ...emptyOverview(id),
            draft: mappingReads === 1 ? null : existing,
          });
        },
        mappingWrite: (id, action, init) => {
          if (action !== 'draft') return undefined;
          putBodies.push(requestBody(init));
          if (putBodies.length === 1) {
            return jsonResponse(409, {
              error: 'MAPPING_ALREADY_EXISTS',
              message: '供应商映射已存在，请按当前草稿版本更新',
            });
          }
          existing = draft(id, {
            version: 6,
            validatedVersion: null,
            validatedAt: null,
            productCode: 'YM-UPDATED',
          });
          return jsonResponse(200, { ...emptyOverview(id), draft: existing });
        },
      }),
    );

    const panel = await openMappingEditor();
    fireEvent.change(productCodeInput(panel), { target: { value: 'YM-DUPLICATE' } });
    fireEvent.click(panelButton(panel, '保存草稿'));

    expect(await within(panel).findByText('该商品已存在映射草稿')).toBeTruthy();
    expect(productCodeInput(panel).value).toBe('YM-DUPLICATE');

    fireEvent.click(panelButton(panel, '重新加载最新版本'));
    const discard = await findModalDialog();
    fireEvent.click(within(discard).getByRole('button', { name: '放弃并刷新' }));
    await waitFor(() => expect(productCodeInput(panel).value).toBe('YM-EXISTING'));
    expect(within(panel).queryByText('该商品已存在映射草稿')).toBeNull();

    fireEvent.change(productCodeInput(panel), { target: { value: 'YM-UPDATED' } });
    fireEvent.click(panelButton(panel, '保存草稿'));
    expect(
      await screen.findByText('草稿已保存，未生效', undefined, { timeout: 5000 }),
    ).toBeTruthy();

    expect(putBodies[0]).toMatchObject({ expectedVersion: null, productCode: 'YM-DUPLICATE' });
    expect(putBodies[1]).toMatchObject({ expectedVersion: 5, productCode: 'YM-UPDATED' });
  });

  it('locks activation when the server says the draft is no longer validated', {
    timeout: 60_000,
  }, async () => {
    const travel = product({ id: 'p-1', code: 'TRAVEL-1', name: '腾讯出行券 10 元' });

    mockFetch(
      standardHandler({
        products: [travel],
        mapping: (id) => jsonResponse(200, { ...emptyOverview(id), draft: draft(id) }),
        mappingWrite: (_id, action) => {
          if (action !== 'activate') return undefined;
          return jsonResponse(409, {
            error: 'MAPPING_NOT_VALIDATED',
            message: '当前草稿版本尚未通过本地校验，不能激活',
          });
        },
      }),
    );

    const panel = await openMappingEditor();
    expect(panelButton(panel, '激活映射').disabled).toBe(false);
    fireEvent.click(panelButton(panel, '激活映射'));
    const modal = await findModalDialog();
    fireEvent.click(within(modal).getByRole('button', { name: '确认激活' }));

    expect(await within(panel).findByText('当前草稿版本尚未通过本地校验')).toBeTruthy();
    expect(screen.queryByText(/已激活，仅影响此后新建订单/)).toBeNull();
    expect(within(panel).getByText('当前没有生效映射')).toBeTruthy();
    expect(panelButton(panel, '保存草稿').disabled).toBe(true);
    expect(panelButton(panel, '本地校验').disabled).toBe(true);
    expect(panelButton(panel, '激活映射').disabled).toBe(true);
    await waitFor(() => expect(modalDialog()).toBeUndefined());
  });

  it('shows INVALID_REQUEST field errors in place without reporting a save', {
    timeout: 60_000,
  }, async () => {
    const travel = product({ id: 'p-1', code: 'TRAVEL-1', name: '腾讯出行券 10 元' });

    mockFetch(
      standardHandler({
        products: [travel],
        mapping: (id) =>
          jsonResponse(200, {
            ...emptyOverview(id),
            draft: draft(id, { validatedVersion: null, validatedAt: null }),
          }),
        mappingWrite: (_id, action) => {
          if (action !== 'draft') return undefined;
          return jsonResponse(400, {
            error: 'INVALID_REQUEST',
            message: '映射草稿参数不正确',
            fields: ['productCode'],
          });
        },
      }),
    );

    const panel = await openMappingEditor();
    fireEvent.change(productCodeInput(panel), { target: { value: 'YM-4004' } });
    fireEvent.click(panelButton(panel, '保存草稿'));

    expect((await within(panel).findAllByText('映射草稿参数不正确')).length).toBeGreaterThan(0);
    expect(await within(panel).findByText('未通过服务端参数校验')).toBeTruthy();
    expect(productCodeInput(panel).value).toBe('YM-4004');
    expect(screen.queryByText('草稿已保存，未生效')).toBeNull();
  });

  it('reports a server 403 instead of pretending the mapping was saved', { timeout: 60_000 }, async () => {
    const travel = product({ id: 'p-1', code: 'TRAVEL-1', name: '腾讯出行券 10 元' });

    mockFetch(
      standardHandler({
        products: [travel],
        mapping: (id) =>
          jsonResponse(200, {
            ...emptyOverview(id),
            draft: draft(id, { validatedVersion: null, validatedAt: null }),
          }),
        mappingWrite: (_id, action) => {
          if (action !== 'validate') return undefined;
          return jsonResponse(403, {
            error: 'FORBIDDEN',
            message: '当前身份无权执行该操作',
          });
        },
      }),
    );

    const panel = await openMappingEditor();
    fireEvent.click(panelButton(panel, '本地校验'));

    expect(await within(panel).findByText('服务端拒绝该操作')).toBeTruthy();
    expect(within(panel).getByText(/当前身份没有管理员权限/)).toBeTruthy();
    expect(screen.queryByText('本地校验已记录，仅代表本地结构检查')).toBeNull();
    expect(within(panel).getAllByText('待本地校验').length).toBeGreaterThan(0);
    expect(panelButton(panel, '激活映射').disabled).toBe(true);
  });

  it('locks further writes when a validate call reports a stale draft version', {
    timeout: 60_000,
  }, async () => {
    const travel = product({ id: 'p-1', code: 'TRAVEL-1', name: '腾讯出行券 10 元' });

    mockFetch(
      standardHandler({
        products: [travel],
        mapping: (id) =>
          jsonResponse(200, {
            ...emptyOverview(id),
            draft: draft(id, { validatedVersion: null, validatedAt: null }),
          }),
        mappingWrite: (_id, action) => {
          if (action !== 'validate') return undefined;
          return jsonResponse(409, {
            error: 'MAPPING_VERSION_CONFLICT',
            message: '映射草稿版本已变化，请刷新后重试',
          });
        },
      }),
    );

    const panel = await openMappingEditor();
    fireEvent.click(panelButton(panel, '本地校验'));

    expect(await within(panel).findByText('映射草稿版本已变化')).toBeTruthy();
    expect(panelButton(panel, '保存草稿').disabled).toBe(true);
    expect(panelButton(panel, '本地校验').disabled).toBe(true);
    expect(panelButton(panel, '激活映射').disabled).toBe(true);
    expect(screen.queryByText('本地校验已记录，仅代表本地结构检查')).toBeNull();
  });

  it('prevents duplicate submissions while a save is in flight', { timeout: 60_000 }, async () => {
    const travel = product({ id: 'p-1', code: 'TRAVEL-1', name: '腾讯出行券 10 元' });
    let draftCalls = 0;
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });

    mockFetch(
      standardHandler({
        products: [travel],
        mapping: (id) => jsonResponse(200, emptyOverview(id)),
        mappingWrite: (id, action) => {
          if (action !== 'draft') return undefined;
          draftCalls += 1;
          return pending.then(() =>
            jsonResponse(200, {
              ...emptyOverview(id),
              draft: draft(id, { version: 1, validatedVersion: null, validatedAt: null }),
            }),
          );
        },
      }),
    );

    const panel = await openMappingEditor();
    fireEvent.change(productCodeInput(panel), { target: { value: 'YM-1001' } });
    fireEvent.click(panelButton(panel, '保存草稿'));
    fireEvent.click(panelButton(panel, '保存草稿'));

    await waitFor(() => expect(draftCalls).toBe(1));
    if (!release) throw new Error('expected a pending save release');
    release();

    expect(
      await screen.findByText('草稿已保存，未生效', undefined, { timeout: 5000 }),
    ).toBeTruthy();
    expect(draftCalls).toBe(1);
  });

  it('surfaces a network failure and retries the same request explicitly', { timeout: 60_000 }, async () => {
    const travel = product({ id: 'p-1', code: 'TRAVEL-1', name: '腾讯出行券 10 元' });
    let draftCalls = 0;

    mockFetch(
      standardHandler({
        products: [travel],
        mapping: (id) => jsonResponse(200, emptyOverview(id)),
        mappingWrite: (id, action) => {
          if (action !== 'draft') return undefined;
          draftCalls += 1;
          if (draftCalls === 1) throw new Error('socket hang up');
          return jsonResponse(200, {
            ...emptyOverview(id),
            draft: draft(id, { version: 1, validatedVersion: null, validatedAt: null }),
          });
        },
      }),
    );

    const panel = await openMappingEditor();
    fireEvent.change(productCodeInput(panel), { target: { value: 'YM-1001' } });
    fireEvent.click(panelButton(panel, '保存草稿'));

    expect(await within(panel).findByText('网络请求失败')).toBeTruthy();
    expect(screen.queryByText('草稿已保存，未生效')).toBeNull();
    expect(productCodeInput(panel).value).toBe('YM-1001');

    fireEvent.click(panelButton(panel, '保存草稿'));
    expect(
      await screen.findByText('草稿已保存，未生效', undefined, { timeout: 5000 }),
    ).toBeTruthy();
    expect(draftCalls).toBe(2);
  });

  it('keeps unsaved mapping edits when an unrelated product save succeeds', {
    timeout: 60_000,
  }, async () => {
    const travel = product({ id: 'p-1', code: 'TRAVEL-1', name: '腾讯出行券 10 元' });
    let productPatches = 0;
    const base = standardHandler({
      products: [travel],
      mapping: (id) => jsonResponse(200, { ...emptyOverview(id), draft: draft(id) }),
    });
    const fetchMock = mockFetch((url, init) => {
      if (url === '/api/v1/catalog/products/p-1' && init?.method === 'PATCH') {
        productPatches += 1;
        return jsonResponse(200, { product: { ...travel, version: 2 } });
      }
      return base(url, init);
    });

    const panel = await openMappingEditor();
    await waitFor(() => expect(productCodeInput(panel).value).toBe('YM-1001'));
    fireEvent.change(productCodeInput(panel), { target: { value: 'YM-UNSAVED' } });

    fireEvent.click(findButtonText('保存'));
    expect(await screen.findByText('商品已保存', undefined, { timeout: 5000 })).toBeTruthy();
    expect(
      await screen.findByText('商品已保存；供应商映射仍有未保存修改，请继续处理'),
    ).toBeTruthy();
    expect(screen.getByText('编辑内部商品')).toBeTruthy();
    expect(productCodeInput(panel).value).toBe('YM-UNSAVED');
    expect(productPatches).toBe(1);

    fireEvent.click(findButtonText('关闭'));
    const dialog = await findModalDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: '放弃修改' }));
    await waitFor(() => expect(screen.queryByText('编辑内部商品')).toBeNull());
    expect(writeCalls(fetchMock)).toEqual(['PATCH /api/v1/catalog/products/p-1']);
  });

  it('uses the new product version for a second save while mapping edits remain unsaved', {
    timeout: 60_000,
  }, async () => {
    const travel = product({ id: 'p-1', code: 'TRAVEL-1', name: '腾讯出行券 10 元' });
    const submittedVersions: number[] = [];
    const base = standardHandler({
      products: [travel],
      mapping: (id) => jsonResponse(200, { ...emptyOverview(id), draft: draft(id) }),
    });
    const fetchMock = mockFetch((url, init) => {
      if (url === '/api/v1/catalog/products/p-1' && init?.method === 'PATCH') {
        const body = requestBody(init);
        const version = Number(body.version);
        submittedVersions.push(version);
        // Mimic the real optimistic-lock guard, not an always-successful mock.
        if (version !== submittedVersions.length) {
          return jsonResponse(409, {
            error: 'PRODUCT_VERSION_CONFLICT',
            message: '商品版本已变化，请重新加载',
          });
        }
        return jsonResponse(200, {
          product: { ...travel, name: String(body.name), version: version + 1 },
        });
      }
      return base(url, init);
    });

    const panel = await openMappingEditor();
    await waitFor(() => expect(productCodeInput(panel).value).toBe('YM-1001'));
    fireEvent.change(productCodeInput(panel), { target: { value: 'YM-UNSAVED' } });

    const nameField = screen.getByRole('textbox', { name: '商品名称' }) as HTMLInputElement;
    fireEvent.change(nameField, { target: { value: '第一版商品名称' } });
    fireEvent.click(findButtonText('保存'));
    await waitFor(() => expect(submittedVersions).toEqual([1]));
    // Wait until the first mutation settles before testing the next save.
    expect(
      await screen.findByText('商品已保存；供应商映射仍有未保存修改，请继续处理'),
    ).toBeTruthy();
    expect(productCodeInput(panel).value).toBe('YM-UNSAVED');
    expect(screen.getByText('编辑内部商品')).toBeTruthy();

    fireEvent.change(nameField, { target: { value: '第二版商品名称' } });
    fireEvent.click(findButtonText('保存'));
    await waitFor(() => expect(submittedVersions).toEqual([1, 2]));
    expect(nameField.value).toBe('第二版商品名称');
    expect(productCodeInput(panel).value).toBe('YM-UNSAVED');
    expect(screen.queryByText('商品已被他人修改')).toBeNull();
    expect(writeCalls(fetchMock)).toEqual([
      'PATCH /api/v1/catalog/products/p-1',
      'PATCH /api/v1/catalog/products/p-1',
    ]);
  });

  it('confirms before closing the drawer with unsaved mapping edits', { timeout: 60_000 }, async () => {
    const travel = product({ id: 'p-1', code: 'TRAVEL-1', name: '腾讯出行券 10 元' });
    const fetchMock = mockFetch(
      standardHandler({
        products: [travel],
        mapping: (id) => jsonResponse(200, { ...emptyOverview(id), draft: draft(id) }),
      }),
    );

    const panel = await openMappingEditor();
    await waitFor(() => expect(productCodeInput(panel).value).toBe('YM-1001'));
    fireEvent.change(productCodeInput(panel), { target: { value: 'YM-UNSAVED' } });

    fireEvent.click(findButtonText('关闭'));
    const firstDialog = await findModalDialog();
    fireEvent.click(within(firstDialog).getByRole('button', { name: '继续编辑' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '放弃未保存的修改？' })).toBeNull(),
    );
    expect(screen.getByText('编辑内部商品')).toBeTruthy();
    expect(productCodeInput(panel).value).toBe('YM-UNSAVED');

    fireEvent.click(findButtonText('关闭'));
    const closeDialog = await findModalDialog();
    fireEvent.click(within(closeDialog).getByRole('button', { name: '放弃修改' }));
    await waitFor(() => expect(screen.queryByText('编辑内部商品')).toBeNull());
    expect(writeCalls(fetchMock)).toEqual([]);
  });
});
