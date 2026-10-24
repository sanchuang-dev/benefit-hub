// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { CatalogProduct } from '../features/catalog/api';
import { installDomStubs, renderRoutes } from '../test-utils/render-routes';

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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sessionResponse(admin: typeof ADMIN | typeof VIEWER): Response {
  return jsonResponse(200, { admin, session: { expiresAt: SESSION_EXPIRES_AT } });
}

function product(overrides: Partial<CatalogProduct> & Pick<CatalogProduct, 'id' | 'code' | 'name'>): CatalogProduct {
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

function listResponse(products: CatalogProduct[], page = 1, pageSize = 20): Response {
  return jsonResponse(200, { products, page, pageSize, total: products.length });
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


/** Ant Design inserts a space inside two-character button labels; match on text. */
function findButtonText(text: string): HTMLElement {
  const element = screen.getByText((content) => content.replace(/\s/g, '') === text);
  const button = element.closest('button');
  if (!button) throw new Error(`No button containing ${text}`);
  return button;
}

async function findButtonTextAsync(text: string, timeout = 5000): Promise<HTMLElement> {
  const element = await screen.findByText(
    (content) => content.replace(/\s/g, '') === text,
    undefined,
    { timeout },
  );
  const button = element.closest('button');
  if (!button) throw new Error(`No button containing ${text}`);
  return button;
}

function queryParams(url: string): URLSearchParams {
  return new URL(url, 'http://localhost').searchParams;
}

function writeCalls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return (fetchMock.mock.calls as [string, RequestInit | undefined][])
    .filter(([, init]) => (init?.method ?? 'GET') !== 'GET')
    .map(([url, init]) => `${init?.method ?? 'GET'} ${url}`);
}

beforeAll(() => installDomStubs());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('internal product list', () => {
  it('lists real API products, marks them unmapped, and applies keyword and status filters', { timeout: 60_000 }, async () => {
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
    expect(screen.getAllByText('未映射供应商')).toHaveLength(2);
    expect(screen.getAllByText('不能发放')).toHaveLength(2);

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
});

describe('product writes', () => {
  it('creates a product through the API and shows the refetched row after saving', { timeout: 60_000 }, async () => {
    let created: CatalogProduct | null = null;
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

    fireEvent.change(screen.getByLabelText('商品编码'), { target: { value: 'new-1' } });
    fireEvent.change(screen.getByLabelText('商品名称'), { target: { value: '新商品' } });
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
    fireEvent.change(await screen.findByLabelText('商品编码'), { target: { value: 'dup-1' } });
    fireEvent.change(screen.getByLabelText('商品名称'), { target: { value: '重复商品' } });
    fireEvent.click(findButtonText('保存'));

    expect(await screen.findByText('商品编码已存在', undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText('商品已保存')).toBeNull();
    expect(screen.getByText('新建内部商品')).toBeTruthy();
    expect((screen.getByLabelText('商品编码') as HTMLInputElement).value).toBe('dup-1');
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
    fireEvent.change(await screen.findByLabelText('商品编码'), { target: { value: 'fail-1' } });
    fireEvent.change(screen.getByLabelText('商品名称'), { target: { value: '故障商品' } });
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
    expect((screen.getByLabelText('商品名称') as HTMLInputElement).value).toBe('咖啡券（新版）');
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
    const nameInput = (await screen.findByLabelText('商品名称')) as HTMLInputElement;
    expect(nameInput.value).toBe('咖啡券');
    expect(nameInput.disabled).toBe(true);
    expect(
      screen.queryByText((content) => content.replace(/\s/g, '') === '保存'),
    ).toBeNull();
    expect(screen.queryByText('停用商品')).toBeNull();
    expect(writeCalls(fetchMock)).toEqual([]);
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
    fireEvent.change(await screen.findByLabelText('商品名称'), {
      target: { value: '尚未保存的商品' },
    });
    fireEvent.click(findButtonText('关闭'));

    expect((await screen.findAllByText('放弃未保存的修改？')).length).toBeGreaterThan(0);
    fireEvent.click(findButtonText('继续编辑'));
    expect(await screen.findByText('新建内部商品')).toBeTruthy();
    expect((screen.getByLabelText('商品名称') as HTMLInputElement).value).toBe('尚未保存的商品');

    fireEvent.click(findButtonText('关闭'));
    expect((await screen.findAllByText('放弃未保存的修改？')).length).toBeGreaterThan(0);
    fireEvent.click(findButtonText('放弃修改'));
    await waitFor(() => expect(screen.queryByText('新建内部商品')).toBeNull());
  });

});
